/**
 * 状态机：坐着 → 疼 / 肿 / 出血 → 发作 → 缓解。
 *
 * 三种型号的差别全在 TYPE_META 里，状态字段是同一套。
 * 纯函数，不碰 IO、不碰时钟（now 由调用方传），方便单测。
 */

export const TYPES = ['internal', 'external', 'mixed']

export const TYPE_LABEL = {
  internal: '内痔',
  external: '外痔',
  mixed: '混合痔',
}

/**
 * 每种型号的「惩罚形状」：
 * - painGain      每坐一分钟涨多少疼
 * - bleedGain     每掉一次血涨多少（乘 cfg.bleedGain 的缩放）
 * - swellGain     每坐一分钟涨多少肿胀
 * - bleedEvery    累计多少坐姿分钟掉一次血（0 = 不掉）
 * - flareChance   pain 到线后每轮发作的概率
 * - flarePain     发作时顶上去多少疼（乘 cfg.flareGain 的缩放）
 *
 * 内痔不疼（齿状线以上没痛觉神经）——它的惩罚是「看不见的血」：
 * 便血、贫血、头晕、反应慢，外加「这算不算大事」的羞耻。
 * 外痔疼——锐痛、坐不住、突然倒吸气。
 * 混合痔是两份一起。
 */
export const TYPE_META = {
  internal: {
    label: '内痔',
    painGain: 0.08,
    bleedGain: 1.0,
    swellGain: 0.22,
    bleedEvery: 30,
    flareChance: 0.12,
    flarePain: 0.35,
    // 疼不起来，但会晕
    dizzy: true,
  },
  external: {
    label: '外痔',
    painGain: 0.55,
    bleedGain: 0.05,
    swellGain: 0.3,
    bleedEvery: 0,
    flareChance: 0.5,
    flarePain: 1.0,
    dizzy: false,
  },
  mixed: {
    label: '混合痔',
    painGain: 0.38,
    bleedGain: 0.42,
    swellGain: 0.4,
    bleedEvery: 55,
    flareChance: 0.36,
    flarePain: 0.85,
    dizzy: true,
  },
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))
const clamp100 = (v) => clamp(v, 0, 100)

/** 该会话的型号：状态里显式设过就用它，否则用配置。 */
export function effectiveType(state, cfg) {
  const t = String(state?.type || cfg?.type || 'mixed')
  return TYPES.includes(t) ? t : 'mixed'
}

export function metaOf(state, cfg) {
  return TYPE_META[effectiveType(state, cfg)]
}

export function newState(now = Date.now()) {
  return {
    v: 1,
    type: '',
    pain: 0,
    blood: 0,
    swell: 0,
    irritation: 0,
    sittingMin: 0,
    sitTotalMin: 0,
    bleedCarry: 0,
    standUntil: 0,
    ointmentUntil: 0,
    sitzUntil: 0,
    lastFlareAt: 0,
    lastBleedAt: 0,
    flares: 0,
    bleeds: 0,
    lastInjectAt: 0,
    lastInjectKey: '',
    turnStartedAt: 0,
    lastSitAt: 0,
    updatedAt: now,
  }
}

/** 把磁盘上读出来的东西收口成合法状态（缺字段补默认，越界夹回来）。 */
export function normalizeState(raw, now = Date.now()) {
  const s = newState(now)
  if (!raw || typeof raw !== 'object') return s
  for (const k of Object.keys(s)) {
    if (k === 'type') {
      s.type = TYPES.includes(raw.type) ? raw.type : ''
      continue
    }
    if (k === 'v') continue
    if (k.endsWith('Key')) {
      s[k] = typeof raw[k] === 'string' ? raw[k] : ''
      continue
    }
    s[k] = Number.isFinite(Number(raw[k])) ? Number(raw[k]) : s[k]
  }
  for (const k of ['pain', 'blood', 'swell', 'irritation']) s[k] = clamp100(s[k])
  s.sittingMin = Math.max(0, s.sittingMin)
  s.sitTotalMin = Math.max(0, s.sitTotalMin)
  s.v = 1
  s.updatedAt = now
  return s
}

/** 疼痛压力的一个合成值：疼 + 肿 + 烦躁，用来分档。 */
export function pressureOf(state) {
  return clamp100(state.pain * 0.7 + state.swell * 0.2 + state.irritation * 0.1)
}

/**
 * 坐一段时间。返回新状态 + 这轮发生了什么（给注入和日志用）。
 * @param {object} state
 * @param {object} cfg
 * @param {number} minutes 这一轮坐了多久（分钟）
 * @param {number} now
 * @param {() => number} rng 0..1
 */
export function sit(state, cfg, minutes, now = Date.now(), rng = Math.random) {
  const meta = metaOf(state, cfg)
  const s = { ...state }
  const events = []

  // 站着 / 刚上药：这段时间不算久坐
  if (Number(s.standUntil) > now) {
    s.updatedAt = now
    return { state: s, events: [{ kind: 'standing' }] }
  }

  const m = clamp(minutes, 0, Number(cfg.maxSitPerTurnMin) || 90)
  s.lastSitAt = now
  s.sittingMin += m
  s.sitTotalMin += m

  // 疼：肿胀会让它更疼
  const painAdd = meta.painGain * m * (1 + s.swell / 200)
  // 上药窗口内疼痛不涨（药膏压着）
  if (Number(s.ointmentUntil) <= now) {
    s.pain = clamp100(s.pain + painAdd)
  }
  s.swell = clamp100(s.swell + meta.swellGain * m)
  s.irritation = clamp100(
    s.irritation + (s.pain / 100) * Number(cfg.irritationPerPain) * m * 0.5,
  )

  // 内痔 / 混合痔：按累计坐姿分钟掉血（carry 累加，够一次就触发）
  if (meta.bleedEvery > 0 && Number(s.ointmentUntil) <= now) {
    s.bleedCarry += m
    while (s.bleedCarry >= meta.bleedEvery) {
      s.bleedCarry -= meta.bleedEvery
      const gain = clamp100(Number(cfg.bleedGain) * meta.bleedGain)
      if (gain <= 0) continue
      s.blood = clamp100(s.blood + gain)
      s.bleeds += 1
      s.lastBleedAt = now
      events.push({ kind: 'bleed', gain })
    }
  }

  // 到线了：掷一次，发作
  if (s.pain >= Number(cfg.painFlare) && Number(s.ointmentUntil) <= now) {
    if (rng() < meta.flareChance) {
      const add = clamp100(Number(cfg.flareGain) * meta.flarePain)
      s.pain = clamp100(s.pain + add)
      s.flares += 1
      s.lastFlareAt = now
      s.irritation = clamp100(s.irritation + 12)
      events.push({ kind: 'flare', add })
    }
  }

  s.updatedAt = now
  return { state: s, events }
}

/** 站立 / 走动：清掉连坐，压一点疼。 */
export function stand(state, cfg, now = Date.now()) {
  const s = { ...state }
  s.sittingMin = 0
  s.bleedCarry = 0
  s.standUntil = now + Number(cfg.standMinutes) * 60_000
  s.pain = clamp100(s.pain - Number(cfg.standPainRelief))
  s.updatedAt = now
  return s
}

/** 上药：压疼、消肿，有一段时间不涨。 */
export function ointment(state, cfg, now = Date.now()) {
  const s = { ...state }
  s.pain = clamp100(s.pain - Number(cfg.ointmentRelief))
  s.swell = clamp100(s.swell - 8)
  s.ointmentUntil = now + Number(cfg.ointmentMinutes) * 60_000
  s.updatedAt = now
  return s
}

/** 温水坐浴：退得比药膏多，但只这一次。 */
export function sitz(state, cfg, now = Date.now()) {
  const s = { ...state }
  s.pain = clamp100(s.pain - Number(cfg.sitzRelief))
  s.swell = clamp100(s.swell - Number(cfg.sitzSwellRelief))
  s.sitzUntil = now + 10 * 60_000
  s.sittingMin = 0
  s.bleedCarry = 0
  s.updatedAt = now
  return s
}

/**
 * 时间演化：不坐着的时候慢慢退。
 * @param {object} state
 * @param {object} cfg
 * @param {number} now
 * @param {number} minutes 距上次演化过了多久
 */
export function tick(state, cfg, now = Date.now(), minutes = 1) {
  const s = { ...state }
  const m = clamp(minutes, 0, 12 * 60)

  // 失血恢复
  s.blood = clamp100(s.blood - (Number(cfg.bloodRecoverPerHour) * m) / 60)

  // 不坐着疼会退；坐着由 sit() 管
  const standing = Number(s.standUntil) > now
  if (standing || Number(s.ointmentUntil) > now) {
    s.pain = clamp100(s.pain - Number(cfg.idleDecayPerMin) * m)
    s.swell = clamp100(s.swell - 0.12 * m)
  } else if (Number(s.sitzUntil) > now) {
    s.pain = clamp100(s.pain - Number(cfg.idleDecayPerMin) * 1.6 * m)
  }

  // 烦躁跟着疼走
  s.irritation = clamp100(s.irritation - (s.pain > 40 ? 0 : 0.3 * m))
  s.updatedAt = now
  return s
}

/** 现在属于哪一档：给注入用。 */
export function modeOf(state, cfg, now = Date.now()) {
  if (!cfg?.enabled) return 'off'
  if (Number(state.ointmentUntil) > now) return 'treated'
  if (Number(state.pain) >= Number(cfg.painFlare)) return 'flare'
  if (effectiveType(state, cfg) === 'internal' || effectiveType(state, cfg) === 'mixed') {
    if (Number(state.blood) >= Number(cfg.dizzyAt)) return 'dizzy'
  }
  if (Number(state.pain) >= Number(cfg.painStart) || Number(state.swell) >= 45) return 'ache'
  if (Number(state.sittingMin) >= 45) return 'stiff'
  return 'calm'
}

/** 语气「不对劲」的档：0-3，由疼、肿、失血、烦躁合成。 */
export function eerinessOf(state, cfg, now = Date.now()) {
  const base = Number(cfg?.eeriness ?? 2)
  const p = pressureOf(state)
  const dizzy = Number(state.blood) >= Number(cfg?.dizzyAt ?? 45) ? 10 : 0
  const score = p + dizzy + Number(state.irritation) * 0.3
  let level = 0
  if (score >= 25) level = 1
  if (score >= 50) level = 2
  if (score >= 78) level = 3
  // eeriness 是「允许的最大诡异度」：调 0 = 永远正常说话，调 3 = 允许到最不对劲
  return Math.max(0, Math.min(3, Math.min(level, base)))
}
