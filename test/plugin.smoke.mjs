/**
 * 装配 smoke：不装进 profile，用假 ctx 把 apply() 跑一遍。
 * 验的是「宿主契约对不对」——工具注册、注入挂载/卸载、事件结算、落盘、dispose。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name as pluginName } from '../src/index.js'

function harness(over = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'hemo-smoke-'))
  const handlers = new Map()
  const effects = []
  const tools = []
  const webRoutes = []
  const contexts = []
  const detached = []
  const logs = []

  let agent = null

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(ev, fn) {
      handlers.set(ev, fn)
    },
    effect(fn) {
      effects.push(fn)
    },
    get(n) {
      if (n === 'tools') return { register: (d) => tools.push(d) }
      if (n === 'webServer') return { register: (d) => webRoutes.push(d) }
      if (n === 'dshHomePath') return tmp
      if (n === 'agents') return { get: () => agent }
      return null
    },
  }

  const dispose = apply(ctx, {
    statePath: tmp,
    enabled: true,
    defaultEnabled: true,
    type: 'external',
    eeriness: 2,
    ...over,
  })

  function makeAgent(sid = 'sess-a') {
    const session = { header: { id: sid, title: 'test' }, id: sid }
    agent = {
      id: sid,
      session,
      ctx: {
        get(n) {
          if (n !== 'systemPrompt') return null
          return {
            context(def) {
              contexts.push(def)
              return () => detached.push(def.name)
            },
          }
        },
      },
    }
    return agent
  }

  const call = (toolName, args, a = agent) => {
    const def = tools.find((t) => t.name === toolName)
    assert.ok(def, `工具 ${toolName} 没注册`)
    return def.execute(args ?? {}, { agent: a })
  }

  return {
    tmp, ctx, handlers, effects, tools, webRoutes, contexts, detached, logs,
    dispose, makeAgent, call,
    get agent() { return agent },
  }
}

test('插件名与包名一致', () => {
  assert.equal(pluginName, 'dsh-hemorrhoid')
})

test('注册 7 个工具，参数面完整', () => {
  const h = harness()
  const names = h.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'hemorrhoid_diagnose',
    'hemorrhoid_ointment',
    'hemorrhoid_sit',
    'hemorrhoid_sitz',
    'hemorrhoid_stand',
    'hemorrhoid_status',
    'hemorrhoid_switch',
  ])
  for (const t of h.tools) {
    assert.equal(t.parameters.type, 'object', t.name)
    assert.ok(t.description.length > 10, t.name)
  }
  const sit = h.tools.find((t) => t.name === 'hemorrhoid_sit')
  assert.equal(sit.parameters.properties.minutes.type, 'number')
  h.dispose()
})

test('面板路由挂在 /hemorrhoid', () => {
  const h = harness()
  assert.equal(h.webRoutes.length, 1)
  assert.equal(h.webRoutes[0].path, '/hemorrhoid')
  assert.equal(h.webRoutes[0].kind, 'prefix')
  h.dispose()
})

test('agent/created 会在该 agent 的 scope 挂一条注入', () => {
  const h = harness()
  assert.equal(typeof h.handlers.get('agent/created'), 'function')
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  assert.equal(h.contexts.length, 1)
  assert.match(h.contexts[0].name, /^hemorrhoid:sess-a$/)
  assert.equal(typeof h.contexts[0].text, 'function')
  h.dispose()
})

test('子代理不挂注入', () => {
  const h = harness()
  h.makeAgent()
  h.agent.session.header.parent = 'parent-1'
  h.handlers.get('agent/created')({ agent: h.agent })
  assert.equal(h.contexts.length, 0)
  h.dispose()
})

test('平静状态下注入块是空串', () => {
  const h = harness()
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  assert.equal(h.contexts[0].text(), '')
  h.dispose()
})

test('开关：off 会 detach，on 会重新挂', async () => {
  const h = harness()
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })

  const off = await h.call('hemorrhoid_switch', { action: 'off' })
  assert.equal(off.ok, true)
  assert.equal(h.detached.length, 1)

  const on = await h.call('hemorrhoid_switch', { action: 'on' })
  assert.equal(on.ok, true)
  assert.equal(h.contexts.length, 2)
  h.dispose()
})

test('坐 3 小时：外痔疼起来，注入块出现并带型号', async () => {
  const h = harness()
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  await h.call('hemorrhoid_switch', { action: 'on' })

  const r = await h.call('hemorrhoid_sit', { minutes: 180 })
  assert.equal(r.ok, true)
  assert.ok(r.data.pain > 40, `pain=${r.data.pain}`)
  assert.equal(r.data.type, 'external')

  const text = h.contexts.at(-1).text()
  assert.ok(text.length > 0, '疼成这样应该注入了')
  assert.match(text, /外痔/)
  h.dispose()
})

test('停药/站起来/坐浴都能把数值拉回来', async () => {
  const h = harness()
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  await h.call('hemorrhoid_switch', { action: 'on' })
  await h.call('hemorrhoid_sit', { minutes: 120 })
  const before = (await h.call('hemorrhoid_status')).data

  await h.call('hemorrhoid_stand')
  const afterStand = (await h.call('hemorrhoid_status')).data
  assert.ok(afterStand.pain <= before.pain)
  assert.equal(afterStand.sittingMin, 0)

  await h.call('hemorrhoid_sit', { minutes: 60 })
  await h.call('hemorrhoid_sitz')
  const afterSitz = (await h.call('hemorrhoid_status')).data
  assert.ok(afterSitz.pain < 40, `pain=${afterSitz.pain}`)
  h.dispose()
})

test('没开的时候工具拒绝并给出开法', async () => {
  const h = harness({ defaultEnabled: false })
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  const r = await h.call('hemorrhoid_stand')
  assert.equal(r.ok, false)
  assert.match(r.text, /hemorrhoid_switch/)
  h.dispose()
})

test('型号不认识时工具报错而不是瞎选', async () => {
  const h = harness()
  h.makeAgent()
  const bad = await h.call('hemorrhoid_diagnose', { type: '直肠癌' })
  assert.equal(bad.ok, false)
  assert.match(bad.text, /internal/)
  h.dispose()
})

test('turn/end 会结算并落盘', async () => {
  const h = harness()
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  await h.call('hemorrhoid_switch', { action: 'on' })

  const sess = h.agent.session
  h.handlers.get('session/event')(sess, { type: 'user/message' })
  await new Promise((r) => setTimeout(r, 30))
  h.handlers.get('session/event')(sess, { type: 'turn/end' })

  const files = readdirSync(join(h.tmp, 'sessions'))
  assert.ok(files.some((f) => f.startsWith('sess-a')), files.join(','))
  const raw = JSON.parse(readFileSync(join(h.tmp, 'sessions', files.find((f) => f.startsWith('sess-a'))), 'utf8'))
  assert.equal(raw.enabled, true)
  assert.ok(raw.state.sittingMin > 0)
  h.dispose()
})

test('压缩上下文当久坐，会加 10 分钟', async () => {
  const h = harness()
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  await h.call('hemorrhoid_switch', { action: 'on' })
  const sess = h.agent.session
  h.handlers.get('session/event')(sess, { type: 'compaction/summary' })
  const s = (await h.call('hemorrhoid_status')).data
  assert.ok(s.sittingMin >= 10)
  h.dispose()
})

test('dispose 会摘掉注入并停掉定时器', () => {
  const h = harness()
  h.makeAgent()
  h.handlers.get('agent/created')({ agent: h.agent })
  h.dispose()
  assert.equal(h.detached.length, 1)
  assert.ok(existsSync(join(h.tmp, 'sessions')))
})
