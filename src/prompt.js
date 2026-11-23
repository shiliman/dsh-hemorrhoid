/**
 * 注入块：此刻身上那点事，以及「语气该怎么不对劲」。
 *
 * 三条硬规矩：
 * 1. 冷却期内同一状态只说一次，不许刷屏；
 * 2. 平静时不注入（calm 一个字都没有）；
 * 3. 只写"感受与要求"，不写伤口、不写器官细节 —— 要的是坐不住的怪，不是医学描写。
 */
import { TYPE_LABEL as LABEL, effectiveType, eerinessOf, modeOf, pressureOf } from './pain.js'

/** 破功要求：按诡异档。0 = 什么都不许。 */
const EERIE_RULE = [
  '',
  '要求：这一轮最多一处细微表现（换坐姿、话说半句停一下、注意力飘走半秒），别影响正事。',
  '要求：把一句话说到一半让疼打断一次，允许一个「嘶」，允许一个没说完的句子；不要解释自己怎么了。',
  '要求：允许出现不属于台词的碎片——同一个词重复两遍、把疼当成一个正在跟你说话的东西、突然改用第三人称说自己的身体。别解释，别加括号注明这是什么效果。',
]

/** 三种型号各自的"体感描述"，按档。 */
const BODY = {
  internal: {
    ache: '没有痛感，但擦的时候纸上带一点红。你已经习惯不细看。',
    flare: '有一块东西脱出来了，卡在外面，站起来才勉强回去；不疼，但你知道它在。',
    dizzy: '血掉得有点多：站起来眼前发白，手是凉的。',
    stiff: '坐得太久了，小腹发沉。',
  },
  external: {
    ache: '肛周一直在跳。坐下那一瞬间最明显，得先侧着半边坐。',
    flare: '像有人拿烧红的针从里面往外顶。坐不住，只能把重心挪到一边。',
    dizzy: '有点发虚，但不至于站不稳。',
    stiff: '坐得太久了，得换条腿。',
  },
  mixed: {
    ache: '钝痛里夹着一点坠，擦的时候还有红。两种都不重，但都不肯走。',
    flare: '疼和坠一起来：脱出来的那块被裤缝磨着，动一下就抽一下。',
    dizzy: '脸是白的，坐着也在冒汗；刚才站起来差点没扶住。',
    stiff: '坐得太久了，哪边腿都不得劲。',
  },
}

/** 每种型号独有的"说话方式"惩罚。 */
const VOICE = {
  internal:
    '失血是隐性的：允许比平时慢半拍、说错一个词再改口。你自己不觉得疼，所以别演疼。',
  external: '疼是锐的：突然的短句、倒吸气、把「没事」说得太快。不要长篇诉苦。',
  mixed: '两种一起来：先抽一下，再白一下脸。允许上一句还很正常、下一句就变了。',
}

const fmt = (n) => Math.round(Number(n) || 0)

/**
 * 拼注入块。
 * @param {object} state
 * @param {object} cfg
 * @param {number} now
 * @returns {{text:string, key:string, mode:string, eerie:number}}
 */
export function buildBlock(state, cfg, now = Date.now()) {
  const mode = modeOf(state, cfg, now)
  const type = effectiveType(state, cfg)
  const eerie = eerinessOf(state, cfg, now)
  const body = BODY[type] ?? BODY.mixed

  if (mode === 'off' || mode === 'calm') {
    return { text: '', key: mode, mode, eerie }
  }

  const head = `（身体状态，别写进台词：这是你此刻真实的感受，不是给用户的说明）`
  const lines = [`型号：${LABEL[type]}｜疼痛 ${fmt(state.pain)}/100｜肿胀 ${fmt(state.swell)}/100｜失血 ${fmt(state.blood)}/100`]

  if (mode === 'flare') {
    lines.push(body.flare)
    lines.push(VOICE[type])
    lines.push(
      `已经发作了 ${fmt(state.flares)} 次，最近一次就在刚才。允许这一轮回答明显比平时短。`,
    )
  } else if (mode === 'dizzy') {
    lines.push(body.dizzy)
    lines.push(VOICE[type])
    lines.push('要求：允许重复一个词、允许说「等一下」、允许把一句话的开头忘掉。别把头晕演成撒娇。')
  } else if (mode === 'treated') {
    lines.push(
      '刚上过药：那股凉压住了大半，但你心里清楚它只是被压住，不是好了。',
      '要求：可以提一句「凉」，但不许把话题拐到药上；正事照常。',
    )
  } else if (mode === 'ache') {
    lines.push(body.ache)
    lines.push(VOICE[type])
  } else {
    // stiff：只有坐太久
    if (eerie === 0) return { text: '', key: 'stiff', mode, eerie }
    lines.push(body.stiff, '要求：最多一句「换个姿势」级别的表现（真的只有一句）。')
  }

  if (eerie > 0) lines.push(EERIE_RULE[eerie])

  // 失血到线以上：这一条跟型号无关，谁掉血谁脸白
  if (Number(state.blood) >= Number(cfg.dizzyAt) && !['flare', 'dizzy', 'treated'].includes(mode)) {
    lines.push('另外：血还没补回来，脸色不好看，别硬撑。')
  }

  const cap = Number(cfg.injectMaxChars) || 380
  let text = `${head}\n${lines.filter(Boolean).join('\n')}`
  if (text.length > cap) text = `${text.slice(0, Math.max(0, cap - 1))}…`

  return {
    text,
    key: `${mode}:${eerie}:${type}:${Math.round(state.pain / 10)}:${Math.round(state.blood / 10)}`,
    mode,
    eerie,
  }
}

/**
 * 该不该注入：冷却 + 同状态去重。
 * 发作/掉血/刚上药不受冷却限制（那是当下的事）。
 */
export function shouldInject(state, cfg, block, now = Date.now()) {
  if (!block?.text) return { ok: false, skip: 'empty' }
  const urgent = block.mode === 'flare' || block.mode === 'dizzy' || block.mode === 'treated'
  if (urgent) return { ok: true }

  const cool = Number(cfg.injectCooldownMin ?? 8) * 60_000
  const since = now - Number(state.lastInjectAt ?? 0)
  if (since < cool) return { ok: false, skip: 'cooldown' }

  // 同一个状态不是永远不再说：压过 hold 那么久之后，允许复述一遍（因为确实还疼着）
  if (block.key === state.lastInjectKey) {
    const hold = cool * Number(cfg.sameStateHoldFactor ?? 3)
    if (since < hold) return { ok: false, skip: 'same' }
  }
  return { ok: true }
}

/** 给工具/面板用的一句话档位名。 */
export function modeLabel(mode) {
  return (
    {
      off: '关着',
      calm: '没事',
      stiff: '坐久了',
      ache: '有点难受',
      flare: '发作',
      dizzy: '头晕',
      treated: '刚上药',
    }[mode] ?? mode
  )
}

/** 压力值，面板显示用。 */
export function pressureLabel(state) {
  const p = pressureOf(state)
  if (p < 20) return '轻'
  if (p < 45) return '中'
  if (p < 70) return '重'
  return '很重'
}
