/**
 * dsh-hemorrhoid —— 给 DSH 加一条「久坐副线」
 *
 * 设计：
 * - 插件挂进 profile 的 bundles，所以每个会话都看得见工具；
 * - 但每个会话有一份自己的身体状态（sessions/<sid>.json），默认不发作；
 * - 开 = 在这个 agent 自己的 scope 里注册一条 systemPrompt context（只喂这个会话）；
 * - 关 = dispose 掉那条注册，文件留着。
 *
 * 三种型号（内痔 / 外痔 / 混合痔）的惩罚形状在 pain.js 的 TYPE_META 里，
 * 这边只负责：按轮结算、注入、工具、面板、落盘。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALLOWED_KEYS, TYPE_LABEL, TYPES, normalizeConfig } from './config.js'
import {
  effectiveType,
  eerinessOf,
  modeOf,
  newState,
  normalizeState,
  ointment,
  pressureOf,
  sit,
  sitz,
  stand,
  tick,
} from './pain.js'
import { buildBlock, modeLabel, pressureLabel, shouldInject } from './prompt.js'
import {
  ensureDir,
  listSessionFiles,
  pushHistory,
  readJson,
  safeSid,
  sessionFile,
  sessionsDir,
  writeJsonAtomic,
  writeTextAtomic,
} from './store.js'

export const name = 'dsh-hemorrhoid'
export const inject = []

const TICK_MS = 60_000
const SAVE_MS = 8_000
const FILE_VERSION = 1

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/** 状态目录：显式 statePath > DSH_HEMORRHOID_DIR > $DSH_HOME/hemorrhoid。永远不碰 cwd。 */
function baseDirOf(ctx, config, logger) {
  const statePath = String(config?.statePath ?? '').trim()
  if (statePath) return resolve(statePath)

  const envDir = String(process.env.DSH_HEMORRHOID_DIR ?? '').trim()
  if (envDir) return resolve(envDir)

  let home = ''
  try {
    const svc = ctx?.get?.('dshHomePath')
    home = typeof svc === 'string' ? svc : String(svc?.path ?? svc?.home ?? '')
  } catch {}
  if (!home) home = String(process.env.DSH_HOME ?? '').trim()
  if (!home) home = join(homedir(), '.dsh')
  const dir = join(home, 'hemorrhoid')
  logger?.info?.(`[dsh-hemorrhoid] 状态目录：${dir}`)
  return dir
}

export function apply(ctx, configIn) {
  const logger = ctx?.logger ?? console
  const cfg = normalizeConfig(configIn)
  const baseDir = baseDirOf(ctx, cfg, logger)
  ensureDir(baseDir)
  ensureDir(sessionsDir(baseDir))

  // 面板改过的参数要重启后还在：单独存一份叠加层
  const panelCfgFile = join(baseDir, 'panel-config.json')
  const overrides = readJson(panelCfgFile, null, logger)
  if (overrides && typeof overrides === 'object') {
    Object.assign(cfg, normalizeConfig({ ...cfg, ...overrides }))
  }
  const savePanelCfg = () => {
    const out = {}
    for (const k of ALLOWED_KEYS) if (cfg[k] !== undefined) out[k] = cfg[k]
    writeJsonAtomic(panelCfgFile, out, logger)
  }

  const tokenFile = join(baseDir, 'panel-token.txt')
  let panelToken = ''
  try {
    if (existsSync(tokenFile)) panelToken = readFileSync(tokenFile, 'utf8').trim()
    if (!panelToken) {
      panelToken = randomUUID().replace(/-/g, '')
      writeTextAtomic(tokenFile, `${panelToken}\n`, logger)
    }
  } catch (e) {
    logger?.warn?.(`[dsh-hemorrhoid] 面板令牌不可用：${e?.message ?? e}`)
  }

  const runtimes = new Map()
  let disposed = false

  // ── 运行时 ────────────────────────────────────────────────────────────────

  function rtKey(sid) {
    return sessionFile(baseDir, sid)
  }

  function loadRt(sid, session) {
    const file = rtKey(sid)
    const cached = runtimes.get(file)
    if (cached) {
      if (session && !cached.label) cached.label = labelOf(session)
      return cached
    }
    const raw = readJson(file, null, logger)
    const rt = {
      sid: String(sid),
      file,
      state: normalizeState(raw?.state ?? raw, Date.now()),
      enabled: raw ? raw.enabled === true : Boolean(cfg.defaultEnabled),
      label: String(raw?.label ?? labelOf(session)),
      cwd: String(raw?.cwd ?? session?.header?.cwd ?? ''),
      history: Array.isArray(raw?.history) ? raw.history : [],
      agent: null,
      detach: null,
      turnStartedAt: 0,
      lastSaveAt: 0,
      dirty: false,
    }
    runtimes.set(file, rt)
    return rt
  }

  function labelOf(session) {
    const h = session?.header ?? session ?? {}
    return String(h.title ?? h.name ?? h.id ?? '')
  }

  function saveRt(rt, force = false) {
    const now = Date.now()
    if (!force && now - rt.lastSaveAt < SAVE_MS) {
      rt.dirty = true
      return
    }
    writeJsonAtomic(
      rt.file,
      {
        v: FILE_VERSION,
        sid: rt.sid,
        enabled: rt.enabled,
        label: rt.label,
        cwd: rt.cwd,
        state: rt.state,
        history: rt.history.slice(-Number(cfg.historyMax)),
        updatedAt: now,
      },
      logger,
    )
    rt.lastSaveAt = now
    rt.dirty = false
  }

  function record(rt, kind, text, extra) {
    rt.history = pushHistory(
      rt.history,
      { at: Date.now(), kind, text, ...(extra ?? {}) },
      cfg.historyMax,
    )
    rt.dirty = true
  }

  // ── agent 绑定 + 作用域注入 ────────────────────────────────────────────────

  function agentOf(sid) {
    try {
      return ctx?.get?.('agents')?.get?.(sid) ?? null
    } catch {
      return null
    }
  }

  /** 只给这一个会话喂块：注册在 agent 自己的 ctx 上，别的会话看不见。 */
  function attach(rt) {
    if (rt.detach) return true
    const agent = rt.agent ?? agentOf(rt.sid)
    if (!agent) return false
    rt.agent = agent
    const sp = agent.ctx?.get?.('systemPrompt') ?? agent.ctx?.systemPrompt
    if (!sp?.context) return false
    try {
      rt.detach = sp.context({
        name: `hemorrhoid:${rt.sid}`,
        order: Number(cfg.injectOrder) || 160,
        text: () => blockFor(rt),
      })
      logger?.info?.(`[dsh-hemorrhoid] 会话 ${rt.sid} 已开：注入挂到 agent scope`)
      return true
    } catch (e) {
      logger?.warn?.(`[dsh-hemorrhoid] 会话 ${rt.sid} 注入挂载失败：${e?.message ?? e}`)
      return false
    }
  }

  function detach(rt) {
    if (!rt.detach) return
    try {
      rt.detach()
    } catch {}
    rt.detach = null
  }

  /**
   * 算注入块。
   * commit=true（默认）表示「宿主真的把这段取走了」，才写冷却时间戳；
   * 工具/结算里调用时传 commit=false，只算一份快照，避免自己把这一轮的话吞掉。
   */
  function blockFor(rt, { commit = true } = {}) {
    if (disposed || !cfg.enabled || !rt.enabled) return ''
    const now = Date.now()
    const block = buildBlock(rt.state, cfg, now)
    const verdict = shouldInject(rt.state, cfg, block, now)
    if (!verdict.ok) return ''
    if (block.text && commit) {
      rt.state.lastInjectAt = now
      rt.state.lastInjectKey = block.key
      rt.dirty = true
      writeTextAtomic(join(baseDir, `inject.${safeSid(rt.sid)}.txt`), block.text, logger)
    }
    return block.text
  }

  // ── 一轮的结算 ────────────────────────────────────────────────────────────

  function settleTurn(rt) {
    const now = Date.now()
    const started = Number(rt.turnStartedAt) || 0
    rt.turnStartedAt = 0
    const minutes =
      started > 0
        ? Math.min(
            Number(cfg.maxSitPerTurnMin) || 90,
            Math.max(1, (now - started) / 60_000),
          )
        : Number(cfg.sittingPerTurnMin) || 12

    const r = sit(rt.state, cfg, minutes, now)
    rt.state = r.state

    for (const ev of r.events) {
      if (ev.kind === 'flare') {
        record(rt, 'flare', `发作了，疼顶到 ${Math.round(rt.state.pain)}`, {
          pain: Math.round(rt.state.pain),
        })
        logger?.info?.(`[dsh-hemorrhoid] ${rt.sid} 发作 #${rt.state.flares}`)
      } else if (ev.kind === 'bleed') {
        record(rt, 'bleed', `掉了一点血（+${Math.round(ev.gain)}）`, {
          blood: Math.round(rt.state.blood),
        })
      }
    }

    saveRt(rt, true)
    blockFor(rt, { commit: false })
  }

  // ── 事件 ──────────────────────────────────────────────────────────────────

  function onAgentCreated(payload) {
    const agent = payload?.agent
    if (disposed || !agent) return
    const header = agent.session?.header ?? {}
    if (header.parent || header.parentId) return // 子代理不坐这把椅子
    const sid = String(header.id ?? agent.session?.id ?? agent.id ?? '')
    if (!sid) return
    const rt = loadRt(sid, agent.session)
    rt.agent = agent
    if (rt.enabled && cfg.enabled) attach(rt)
  }

  function onSessionEvent(session, event) {
    if (disposed || !cfg.enabled || !event?.type) return
    const header = session?.header ?? session
    if (header?.parent || header?.parentId) return
    const sid = String(header?.id ?? session?.id ?? '')
    if (!sid) return
    const rt = loadRt(sid, session)
    if (rt.enabled && !rt.detach) attach(rt)
    if (!rt.enabled) return

    if (event.type === 'user/message') {
      if (!rt.turnStartedAt) rt.turnStartedAt = Date.now()
      return
    }

    if (event.type === 'turn/end') {
      settleTurn(rt)
      return
    }

    // 上下文被压缩 = 一直没起身
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      rt.state.sittingMin += 10
      record(rt, 'compaction', '上下文压缩，又坐了十分钟')
      saveRt(rt, false)
    }
  }

  try {
    ctx.on('agent/created', onAgentCreated)
  } catch (e) {
    logger?.warn?.(`[dsh-hemorrhoid] agent/created 订阅失败：${e?.message ?? e}`)
  }
  try {
    ctx.on('session/event', onSessionEvent)
  } catch (e) {
    logger?.warn?.(`[dsh-hemorrhoid] session/event 订阅失败：${e?.message ?? e}`)
  }

  // ── 定时器：时间演化 + 落盘 + 清理 ─────────────────────────────────────────

  let timer = null
  try {
    timer = setInterval(() => {
      if (disposed) return
      const now = Date.now()
      for (const rt of runtimes.values()) {
        if (!rt.enabled) continue
        rt.state = tick(rt.state, cfg, now, 1)
        saveRt(rt, false)
      }
    }, TICK_MS)
    timer?.unref?.()
  } catch {}

  try {
    const prune = () => {
      if (!cfg.pruneDays) return
      const cutoff = Date.now() - cfg.pruneDays * 86_400_000
      for (const f of listSessionFiles(baseDir)) {
        if (f.mtime && f.mtime < cutoff && !runtimes.has(f.file)) {
          // 只删本插件自己写的会话文件，且文件名必须过白名单
          if (!/^[A-Za-z0-9_-]+\.json$/.test(f.name)) continue
          try {
            unlinkSync(f.file)
          } catch {}
        }
      }
    }
    prune()
    const t = setInterval(prune, 6 * 3600_000)
    t?.unref?.()
  } catch {}

  // ── 工具 ──────────────────────────────────────────────────────────────────

  const sidOf = (exec) => {
    const a = exec?.agent
    return String(a?.session?.header?.id ?? a?.session?.id ?? a?.id ?? '')
  }

  function rtOfExec(exec, { autoAttach = true } = {}) {
    const sid = sidOf(exec)
    if (!sid) return { rt: null, why: '拿不到会话 id' }
    const rt = loadRt(sid, exec?.agent?.session)
    if (exec?.agent) rt.agent = exec.agent
    if (autoAttach && rt.enabled && !rt.detach) attach(rt)
    return { rt, why: '' }
  }

  const who = () => String(cfg.personaName || '我')
  const NOT_ON = '这个会话的痔疮还没开。要开就调 hemorrhoid_switch（action=on），或者直接说型号。'

  const statusText = (rt) => {
    const now = Date.now()
    const type = effectiveType(rt.state, cfg)
    const mode = modeOf(rt.state, cfg, now)
    return (
      `${rt.enabled ? '开' : '关'}｜${TYPE_LABEL[type]}` +
      `｜疼 ${Math.round(rt.state.pain)}/100｜肿 ${Math.round(rt.state.swell)}/100｜失血 ${Math.round(rt.state.blood)}/100` +
      `｜烦躁 ${Math.round(rt.state.irritation)}` +
      `｜连坐 ${Math.round(rt.state.sittingMin)} 分钟` +
      `｜状态 ${modeLabel(mode)}（压力 ${pressureLabel(rt.state)}，诡异档 ${eerinessOf(rt.state, cfg, now)}）` +
      `｜发作 ${rt.state.flares} 次｜掉血 ${rt.state.bleeds} 次`
    )
  }

  const toolDefs = [
    {
      name: 'hemorrhoid_switch',
      description:
        `开关**当前这个会话**的痔疮副线（每个会话独立）。` +
        `用户说「我得了痔疮 / 开痔疮 / 让他难受一下」→ action=on；` +
        `说「关掉 / 别演了 / 治好了」→ action=off；问现状 → action=status。`,
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['on', 'off', 'status'] } },
        required: ['action'],
      },
      async execute(args, exec) {
        const action = String(args?.action ?? 'status')
        const { rt, why } = rtOfExec(exec, { autoAttach: false })
        if (!rt) return { ok: false, text: `拿不到会话（${why}）` }
        if (action === 'on') {
          rt.enabled = true
          const ok = attach(rt)
          record(rt, 'switch', '开了')
          saveRt(rt, true)
          return {
            ok: true,
            text: ok
              ? `${who()}的痔疮开了（这个会话独一份）。${statusText(rt)}`
              : '开关记下了，但注入通道还没就绪（agent 可能还没建好），下一轮会重试。',
            data: summaryOf(rt),
          }
        }
        if (action === 'off') {
          rt.enabled = false
          detach(rt)
          record(rt, 'switch', '关了')
          saveRt(rt, true)
          return { ok: true, text: '关了。数值留着，下次开还是这副身体。', data: summaryOf(rt) }
        }
        return { ok: true, text: statusText(rt), data: summaryOf(rt) }
      },
    },
    {
      name: 'hemorrhoid_diagnose',
      description:
        `选型号（会顺手打开开关）。用户说「内痔」→ internal（不疼，但便血、贫血、头晕、反应慢）；` +
        `「外痔」→ external（锐痛、坐不住、突然倒吸气）；「混合痔」→ mixed（两份一起来，最难受）。`,
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: TYPES },
        },
        required: ['type'],
      },
      async execute(args, exec) {
        const type = String(args?.type ?? '')
        if (!TYPES.includes(type)) {
          return { ok: false, text: `型号只能是 ${TYPES.join(' / ')}。` }
        }
        const { rt } = rtOfExec(exec, { autoAttach: false })
        if (!rt) return { ok: false, text: '拿不到会话。' }
        rt.state.type = type
        rt.enabled = true
        attach(rt)
        record(rt, 'diagnose', `确诊：${TYPE_LABEL[type]}`)
        saveRt(rt, true)
        blockFor(rt, { commit: false })
        return {
          ok: true,
          text: `确诊为${TYPE_LABEL[type]}。${statusText(rt)}`,
          data: summaryOf(rt),
        }
      },
    },
    {
      name: 'hemorrhoid_stand',
      description: `站起来走走：清掉连坐、压一点疼，接下来一段时间的坐姿不计入久坐。用户说「站起来 / 走动一下 / 歇会儿」时用。`,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec)
        if (!rt || !rt.enabled) return { ok: false, text: NOT_ON }
        rt.state = stand(rt.state, cfg, Date.now())
        record(rt, 'stand', '站起来走了走')
        saveRt(rt, true)
        blockFor(rt, { commit: false })
        return { ok: true, text: `站起来了。${statusText(rt)}`, data: summaryOf(rt) }
      },
    },
    {
      name: 'hemorrhoid_ointment',
      description: `上药：压住疼、消一点肿，接下来一段时间疼痛不涨。用户说「上药 / 抹点药」时用。不能用它来假装没事——药劲过了还是那样。`,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec)
        if (!rt || !rt.enabled) return { ok: false, text: NOT_ON }
        rt.state = ointment(rt.state, cfg, Date.now())
        record(rt, 'ointment', '上了药')
        saveRt(rt, true)
        blockFor(rt, { commit: false })
        return { ok: true, text: `抹上了，凉。${statusText(rt)}`, data: summaryOf(rt) }
      },
    },
    {
      name: 'hemorrhoid_sitz',
      description: `温水坐浴：退得比药膏多，尤其是肿。用户说「坐浴 / 泡一下」时用。`,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec)
        if (!rt || !rt.enabled) return { ok: false, text: NOT_ON }
        rt.state = sitz(rt.state, cfg, Date.now())
        record(rt, 'sitz', '泡了一会儿')
        saveRt(rt, true)
        blockFor(rt, { commit: false })
        return { ok: true, text: `泡完了，松了一点。${statusText(rt)}`, data: summaryOf(rt) }
      },
    },
    {
      name: 'hemorrhoid_sit',
      description: `主动再坐一会儿（默认按配置，约 12 分钟），推进剧情或调试用。用户说「再坐两小时 / 我就坐着不动」时用。`,
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: '坐多少分钟，默认按配置' },
        },
        required: [],
      },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec)
        if (!rt || !rt.enabled) return { ok: false, text: NOT_ON }
        const m = Math.max(1, Math.min(240, Math.round(Number(args?.minutes) || cfg.sittingPerTurnMin)))
        const r = sit(rt.state, cfg, m, Date.now())
        rt.state = r.state
        for (const ev of r.events) {
          if (ev.kind === 'flare') record(rt, 'flare', '硬坐着，发作了')
          else if (ev.kind === 'bleed') record(rt, 'bleed', '硬坐着，掉了血')
        }
        record(rt, 'sit', `又坐了 ${m} 分钟`)
        saveRt(rt, true)
        blockFor(rt, { commit: false })
        return { ok: true, text: `又坐了 ${m} 分钟。${statusText(rt)}`, data: summaryOf(rt) }
      },
    },
    {
      name: 'hemorrhoid_status',
      description: `读当前会话的数值（开关、型号、疼/肿/失血/烦躁、连坐、状态档、诡异档、发作次数）。排查与汇报用。`,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec, { autoAttach: false })
        if (!rt) return { ok: false, text: '拿不到会话。' }
        return { ok: true, text: statusText(rt), data: summaryOf(rt) }
      },
    },
  ]

  let toolTries = 0
  const tryRegisterTools = () => {
    if (disposed) return
    const tools = ctx?.get?.('tools')
    if (!tools?.register) {
      if (++toolTries < 15) {
        const t = setTimeout(tryRegisterTools, 2000)
        t?.unref?.()
        return
      }
      logger?.info?.('[dsh-hemorrhoid] tools 服务不可用，工具未注册')
      return
    }
    for (const def of toolDefs) {
      try {
        tools.register(def)
      } catch (e) {
        logger?.warn?.(`[dsh-hemorrhoid] 工具 ${def.name} 注册失败：${e?.message ?? e}`)
      }
    }
  }
  tryRegisterTools()

  // ── 面板 ──────────────────────────────────────────────────────────────────

  function summaryOf(rt) {
    const now = Date.now()
    const type = effectiveType(rt.state, cfg)
    const mode = modeOf(rt.state, cfg, now)
    return {
      sid: rt.sid,
      label: rt.label,
      cwd: rt.cwd,
      enabled: rt.enabled,
      type,
      typeLabel: TYPE_LABEL[type],
      pain: Math.round(rt.state.pain),
      blood: Math.round(rt.state.blood),
      swell: Math.round(rt.state.swell),
      irritation: Math.round(rt.state.irritation),
      sittingMin: Math.round(rt.state.sittingMin),
      mode,
      modeLabel: modeLabel(mode),
      pressure: pressureLabel(rt.state),
      pressureValue: Math.round(pressureOf(rt.state)),
      eerie: eerinessOf(rt.state, cfg, now),
      flares: rt.state.flares,
      bleeds: rt.state.bleeds,
      updatedAt: rt.state.updatedAt,
      live: Boolean(rt.detach),
    }
  }

  function allSessions() {
    const out = []
    const seen = new Set()
    for (const rt of runtimes.values()) {
      out.push(summaryOf(rt))
      seen.add(rt.file)
    }
    for (const f of listSessionFiles(baseDir)) {
      if (seen.has(f.file)) continue
      const raw = readJson(f.file, null, logger)
      if (!raw || typeof raw !== 'object') continue
      const sid = String(raw.sid ?? f.file.split(/[\\/]/).pop()?.replace(/\.json$/, '') ?? '')
      const st = normalizeState(raw.state ?? raw, Date.now())
      const type = effectiveType(st, cfg)
      const mode = modeOf(st, cfg, Date.now())
      out.push({
        sid,
        label: String(raw.label ?? ''),
        cwd: String(raw.cwd ?? ''),
        enabled: raw.enabled === true,
        type,
        typeLabel: TYPE_LABEL[type],
        pain: Math.round(st.pain),
        blood: Math.round(st.blood),
        swell: Math.round(st.swell),
        irritation: Math.round(st.irritation),
        sittingMin: Math.round(st.sittingMin),
        mode,
        modeLabel: modeLabel(mode),
        pressure: pressureLabel(st),
        pressureValue: Math.round(pressureOf(st)),
        eerie: eerinessOf(st, cfg, Date.now()),
        flares: st.flares,
        bleeds: st.bleeds,
        updatedAt: st.updatedAt,
        live: false,
      })
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  const registerWeb = (web) => {
    const send = (res, code, body, type = 'application/json; charset=utf-8') => {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
      res.writeHead(code, { 'content-type': type, 'content-length': data.length })
      res.end(data)
    }
    const json = (res, obj) => send(res, 200, JSON.stringify(obj))
    const readBody = (req) =>
      new Promise((settle) => {
        const chunks = []
        let size = 0
        let done = false
        const finish = (v) => {
          if (done) return
          done = true
          settle(v)
        }
        req.on('data', (c) => {
          chunks.push(c)
          size += c.length
          if (size > 262144) {
            finish({})
            req.destroy()
          }
        })
        req.on('end', () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
          } catch {
            finish({})
          }
        })
        req.on('error', () => finish({}))
      })

    const here = dirname(fileURLToPath(import.meta.url))
    const panelFile = join(here, '..', 'panel', 'index.html')

    web.register({
      kind: 'prefix',
      path: '/hemorrhoid',
      handler: async (req, res) => {
        const url = String(req.url ?? '').split('?')[0]
        const qs = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '')
        const origin = String(req.headers.origin ?? '')
        if (origin) {
          const host = String(req.headers.host ?? '')
          let originHost = ''
          try {
            originHost = new URL(origin).host
          } catch {}
          if (!originHost || originHost !== host) return send(res, 403, 'forbidden origin')
        }

        if (url.startsWith('/hemorrhoid/api/')) {
          const tok = String(req.headers['x-hemorrhoid-token'] ?? '')
          if (!panelToken || !safeEqual(tok, panelToken)) return send(res, 401, 'unauthorized')
        }

        if (url === '/hemorrhoid' || url === '/hemorrhoid/' || url === '/hemorrhoid/panel') {
          let html = ''
          try {
            html = readFileSync(panelFile, 'utf8')
          } catch (e) {
            return send(res, 500, `panel missing: ${e?.message ?? e}`)
          }
          html = html
            .replace(/__HEMORRHOID_TOKEN__/g, panelToken)
            .replace(/__HEMORRHOID_DIR__/g, baseDir.replace(/\\/g, '\\\\'))
          return send(res, 200, html, 'text/html; charset=utf-8')
        }

        if (url === '/hemorrhoid/api/sessions' && req.method === 'GET') {
          return json(res, { sessions: allSessions(), config: cfg })
        }

        if (url === '/hemorrhoid/api/config' && req.method === 'POST') {
          const body = await readBody(req)
          for (const k of ALLOWED_KEYS) {
            if (body[k] === undefined) continue
            cfg[k] = body[k]
          }
          Object.assign(cfg, normalizeConfig(cfg))
          savePanelCfg()
          for (const rt of runtimes.values()) {
            if (rt.detach) {
              detach(rt)
              attach(rt)
            }
          }
          return json(res, { ok: true, config: cfg })
        }

        if (url === '/hemorrhoid/api/action' && req.method === 'POST') {
          const body = await readBody(req)
          const sid = String(body.sid ?? qs.get('sid') ?? '')
          const rt = sid ? loadRt(sid) : null
          if (!rt) return json(res, { ok: false, text: '没给 sid' })
          const now = Date.now()
          const act = String(body.action ?? '')

          if (act === 'on') {
            rt.enabled = true
            attach(rt)
          } else if (act === 'off') {
            rt.enabled = false
            detach(rt)
          } else if (act === 'diagnose') {
            const type = String(body.type ?? '')
            if (!TYPES.includes(type)) return json(res, { ok: false, text: '型号不认识' })
            rt.state.type = type
            rt.enabled = true
            attach(rt)
          } else if (act === 'stand') {
            rt.state = stand(rt.state, cfg, now)
          } else if (act === 'ointment') {
            rt.state = ointment(rt.state, cfg, now)
          } else if (act === 'sitz') {
            rt.state = sitz(rt.state, cfg, now)
          } else if (act === 'sit') {
            const r = sit(rt.state, cfg, Number(body.minutes) || cfg.sittingPerTurnMin, now)
            rt.state = r.state
          } else if (act === 'reset') {
            if (!cfg.debugMode) return json(res, { ok: false, text: '调试模式没开' })
            rt.state = newState(now)
            rt.history = []
          } else {
            return json(res, { ok: false, text: `未知动作：${act}` })
          }
          record(rt, 'panel', `面板：${act}${body.type ? `(${body.type})` : ''}`)
          saveRt(rt, true)
          blockFor(rt)
          return json(res, { ok: true, summary: summaryOf(rt) })
        }

        return send(res, 404, 'not found')
      },
    })
  }

  let webTries = 0
  const tryRegisterWeb = () => {
    if (disposed) return
    const web = ctx?.get?.('webServer')
    if (web?.register) {
      try {
        registerWeb(web)
        logger?.info?.('[dsh-hemorrhoid] 面板：/hemorrhoid')
        return
      } catch (e) {
        logger?.warn?.(`[dsh-hemorrhoid] 面板路由注册失败：${e?.message ?? e}`)
        return
      }
    }
    if (++webTries < 15) {
      const t = setTimeout(tryRegisterWeb, 2000)
      t?.unref?.()
      return
    }
    logger?.info?.('[dsh-hemorrhoid] webServer 不可用，面板未注册')
  }
  tryRegisterWeb()

  // 进程内快照（排障用）
  globalThis.__dshHemorrhoidSessions = () => allSessions()

  const dispose = () => {
    disposed = true
    try {
      clearInterval(timer)
    } catch {}
    for (const rt of runtimes.values()) {
      try {
        detach(rt)
        saveRt(rt, true)
      } catch {}
    }
  }
  try {
    ctx?.on?.('dispose', dispose)
  } catch {}
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose)
  } catch {}

  logger?.info?.(
    `[dsh-hemorrhoid] 已就绪：全局加载、每会话开关（新会话默认${cfg.defaultEnabled ? '开' : '关'}）` +
      `｜型号 ${TYPE_LABEL[cfg.type]}｜诡异档 ${cfg.eeriness}｜状态目录 ${baseDir}`,
  )
  return dispose
}
