/**
 * 配置：默认值 + 面板可写键白名单。
 *
 * 约束：状态键（pain / blood / swell / sittingMin ...）永远不在 ALLOWED_KEYS 里 ——
 * 面板保存配置时不能把当前状态快照顺手写进配置文件。
 *
 * 型号表只有一份权威源：pain.js 的 TYPE_META。这里只 re-export。
 */
import { TYPES, TYPE_LABEL } from './pain.js'

export { TYPES, TYPE_LABEL }

export const DEFAULTS = {
  // 主机总闸：关掉 = 所有会话都没这回事
  enabled: true,
  // 新会话默认开不开。false = 得自己说一句「我得了痔疮」
  defaultEnabled: false,
  personaName: '大肥鱼',
  // 型号：internal / external / mixed
  type: 'mixed',
  // 语气的不对劲程度：0 = 几乎正常，3 = 明显诡异
  eeriness: 2,

  // ── 久坐 ──────────────────────────────────────────────────────────────
  // 一轮没有真实时长时按这个兜底（分钟）
  sittingPerTurnMin: 12,
  // 一轮最多算这么多分钟，防止挂机一整夜把数值顶爆
  maxSitPerTurnMin: 90,
  // 每坐一分钟，肿胀涨多少
  swellPerSitMin: 0.18,
  // 疼的时候烦躁涨多快（乘 pain）
  irritationPerPain: 0.25,

  // ── 疼痛 ──────────────────────────────────────────────────────────────
  // 超过这个值才开始有可感知的注入
  painStart: 35,
  // 到这个值进入「随时会发作」
  painFlare: 78,
  // 发作一次顶上去多少疼
  flareGain: 28,

  // ── 失血（内痔 / 混合痔） ─────────────────────────────────────────────
  // 每累计这么多「坐姿分钟」掉一次血
  bleedPerSitMin: 30,
  bleedGain: 8,
  // 每小时自然回多少（身体会造血，但慢）
  bloodRecoverPerHour: 1.2,
  // 到这里开始明显头晕
  dizzyAt: 45,

  // ── 缓解 ──────────────────────────────────────────────────────────────
  // 站起来后多少分钟内不算久坐
  standMinutes: 6,
  standPainRelief: 10,
  // 上药
  ointmentRelief: 32,
  ointmentMinutes: 25,
  // 温水坐浴
  sitzRelief: 48,
  sitzSwellRelief: 22,
  // 不坐了，每分钟自然退多少疼
  idleDecayPerMin: 0.35,

  // ── 注入 ──────────────────────────────────────────────────────────────
  injectCooldownMin: 8,
  injectMaxChars: 380,
  injectOrder: 160,

  // ── 运行 ──────────────────────────────────────────────────────────────
  debugMode: false,
  // 状态目录；空 = $DSH_HOME/hemorrhoid
  statePath: '',
  historyMax: 300,
  // 超过这么多天没动的会话状态自动清掉
  pruneDays: 45,
  // 同一状态最多压着不说多久（冷却的倍数）；到了就允许再说一遍
  sameStateHoldFactor: 3,
}

/** 面板可以写的键（行为参数，不含状态）。 */
export const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS))

export const NUM_KEYS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'number'),
)
export const BOOL_KEYS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'boolean'),
)
export const STR_KEYS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'string'),
)

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 补全 + 校验配置。任何入口（DSH 装配、面板保存、测试直接 apply）都得到同一份。
 * @param {object} input 调用方给的原始配置
 * @returns {object} 全量配置
 */
export function normalizeConfig(input) {
  const raw = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) }
  const cfg = {}

  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (typeof def === 'number') {
      cfg[k] = num(raw[k], def)
      continue
    }
    if (typeof def === 'boolean') {
      cfg[k] = raw[k] === true || raw[k] === 'true' || raw[k] === 1
      continue
    }
    cfg[k] = String(raw[k] ?? def)
  }

  // 型号不认识就回退到混合痔（最难受的那档，用户至少能察觉）
  if (!TYPES.includes(cfg.type)) cfg.type = DEFAULTS.type
  cfg.eeriness = Math.round(clamp(cfg.eeriness, 0, 3))

  cfg.sittingPerTurnMin = clamp(cfg.sittingPerTurnMin, 1, 240)
  cfg.maxSitPerTurnMin = clamp(cfg.maxSitPerTurnMin, 1, 720)
  cfg.swellPerSitMin = clamp(cfg.swellPerSitMin, 0, 5)
  cfg.irritationPerPain = clamp(cfg.irritationPerPain, 0, 2)
  cfg.painStart = clamp(cfg.painStart, 0, 100)
  cfg.painFlare = clamp(cfg.painFlare, 1, 100)
  cfg.flareGain = clamp(cfg.flareGain, 0, 100)
  cfg.bleedPerSitMin = clamp(cfg.bleedPerSitMin, 1, 720)
  cfg.bleedGain = clamp(cfg.bleedGain, 0, 100)
  cfg.bloodRecoverPerHour = clamp(cfg.bloodRecoverPerHour, 0, 100)
  cfg.dizzyAt = clamp(cfg.dizzyAt, 1, 100)
  cfg.standMinutes = clamp(cfg.standMinutes, 0, 240)
  cfg.standPainRelief = clamp(cfg.standPainRelief, 0, 100)
  cfg.ointmentRelief = clamp(cfg.ointmentRelief, 0, 100)
  cfg.ointmentMinutes = clamp(cfg.ointmentMinutes, 1, 240)
  cfg.sitzRelief = clamp(cfg.sitzRelief, 0, 100)
  cfg.sitzSwellRelief = clamp(cfg.sitzSwellRelief, 0, 100)
  cfg.idleDecayPerMin = clamp(cfg.idleDecayPerMin, 0, 10)
  cfg.injectCooldownMin = clamp(cfg.injectCooldownMin, 0, 1440)
  cfg.injectMaxChars = clamp(cfg.injectMaxChars, 80, 1600)
  cfg.injectOrder = clamp(cfg.injectOrder, 0, 1000)
  cfg.sameStateHoldFactor = clamp(cfg.sameStateHoldFactor, 1, 20)
  cfg.historyMax = clamp(Math.round(cfg.historyMax), 20, 5000)
  cfg.pruneDays = clamp(Math.round(cfg.pruneDays), 0, 3650)

  return cfg
}
