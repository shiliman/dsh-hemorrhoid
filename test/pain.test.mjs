import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, normalizeConfig, TYPE_LABEL, TYPES } from '../src/config.js'
import {
  eerinessOf,
  effectiveType,
  metaOf,
  modeOf,
  newState,
  normalizeState,
  ointment,
  sit,
  sitz,
  stand,
  tick,
  TYPE_META,
} from '../src/pain.js'
import { buildBlock, shouldInject } from '../src/prompt.js'

const cfg = (over = {}) => normalizeConfig({ ...DEFAULTS, enabled: true, ...over })

// ── config ────────────────────────────────────────────────────────────────

test('型号不认识时回退到混合痔', () => {
  assert.equal(normalizeConfig({ type: '直肠癌' }).type, 'mixed')
  for (const t of TYPES) assert.equal(normalizeConfig({ type: t }).type, t)
})

test('eeriness 夹在 0-3', () => {
  assert.equal(normalizeConfig({ eeriness: -2 }).eeriness, 0)
  assert.equal(normalizeConfig({ eeriness: 9 }).eeriness, 3)
  assert.equal(normalizeConfig({ eeriness: 2.4 }).eeriness, 2)
})

test('三个型号都有中文名与惩罚系数', () => {
  for (const t of TYPES) {
    assert.ok(TYPE_LABEL[t], t)
    assert.ok(TYPE_META[t].painGain >= 0)
  }
})

// ── pain：三种型号的惩罚形状 ───────────────────────────────────────────────

test('内痔：坐 60 分钟也不怎么疼，但会掉一次血', () => {
  const c = cfg({ type: 'internal' })
  const r = sit(newState(0), c, 60, 1000, () => 0.99)
  assert.ok(r.state.pain < 10, `pain=${r.state.pain}`)
  assert.ok(r.state.blood >= 8, `blood=${r.state.blood}`)
  assert.ok(r.events.some((e) => e.kind === 'bleed'))
})

test('外痔：坐 60 分钟疼得明显，且不掉血', () => {
  const c = cfg({ type: 'external' })
  const r = sit(newState(0), c, 60, 1000, () => 0.99)
  assert.ok(r.state.pain > 25, `pain=${r.state.pain}`)
  assert.equal(r.state.blood, 0)
  assert.ok(!r.events.some((e) => e.kind === 'bleed'))
})

test('混合痔：疼和血一起涨', () => {
  const c = cfg({ type: 'mixed' })
  const r = sit(newState(0), c, 60, 1000, () => 0.99)
  assert.ok(r.state.pain > 15, `pain=${r.state.pain}`)
  assert.ok(r.state.blood > 0)
})

test('疼到线以上会掷出一次发作', () => {
  const c = cfg({ type: 'external' })
  const s0 = { ...newState(0), pain: 80 }
  const r = sit(s0, c, 5, 1000, () => 0) // rng=0 必中
  assert.ok(r.events.some((e) => e.kind === 'flare'))
  assert.equal(r.state.flares, 1)
  assert.ok(r.state.pain >= 80)
})

test('rng=1 时不发作', () => {
  const c = cfg({ type: 'external' })
  const s0 = { ...newState(0), pain: 80 }
  const r = sit(s0, c, 5, 1000, () => 0.999)
  assert.ok(!r.events.some((e) => e.kind === 'flare'))
})

test('站起来：清连坐 + 压疼 + 这段时间不算坐', () => {
  const c = cfg({ type: 'external' })
  const s = { ...newState(0), sittingMin: 120, bleedCarry: 50, pain: 60 }
  const a = stand(s, c, 1000)
  assert.equal(a.sittingMin, 0)
  assert.equal(a.bleedCarry, 0)
  assert.equal(a.pain, 50)
  // 站着的时候再坐，不涨
  const r = sit(a, c, 30, 2000, () => 0.99)
  assert.equal(r.state.pain, 50)
})

test('上药：压疼，且药效期内不再涨疼', () => {
  const c = cfg({ type: 'external' })
  const s = ointment({ ...newState(0), pain: 90 }, c, 1000)
  assert.equal(s.pain, 58)
  assert.ok(s.ointmentUntil > 1000)
  const r = sit(s, c, 20, 2000, () => 0.99)
  assert.equal(r.state.pain, 58)
})

test('坐浴：退得比药膏多', () => {
  const c = cfg()
  const s0 = { ...newState(0), pain: 90, swell: 80 }
  const o = ointment(s0, c, 1000)
  const z = sitz(s0, c, 1000)
  assert.ok(z.pain < o.pain, `sitz=${z.pain} oint=${o.pain}`)
  assert.ok(z.swell < o.swell)
})

test('失血会缓慢回来，但不会掉到负数', () => {
  const c = cfg()
  const s = tick({ ...newState(0), blood: 3 }, c, 1000, 60 * 10)
  assert.ok(s.blood >= 0)
  assert.ok(s.blood < 3)
})

// ── 档位 ─────────────────────────────────────────────────────────────────

test('modeOf：平静 / 坐久了 / 难受 / 发作 / 头晕 / 上药', () => {
  const c = cfg({ type: 'external' })
  assert.equal(modeOf(newState(0), c, 0), 'calm')
  assert.equal(modeOf({ ...newState(0), sittingMin: 60 }, c, 0), 'stiff')
  assert.equal(modeOf({ ...newState(0), pain: 50 }, c, 0), 'ache')
  assert.equal(modeOf({ ...newState(0), pain: 79 }, c, 0), 'flare')
  const cm = cfg({ type: 'internal' })
  assert.equal(modeOf({ ...newState(0), blood: 60 }, cm, 0), 'dizzy')
  assert.equal(modeOf({ ...newState(0), ointmentUntil: 9999 }, c, 0), 'treated')
})

test('eeriness 是上限：配置 0 时永远 0 档', () => {
  const c = cfg({ eeriness: 0 })
  const s = { ...newState(0), pain: 100, blood: 100, irritation: 100, swell: 100 }
  assert.equal(eerinessOf(s, c, 0), 0)
})

test('eeriness 到 3 时，高压状态能到 3', () => {
  const c = cfg({ eeriness: 3 })
  const s = { ...newState(0), pain: 100, blood: 100, irritation: 100, swell: 100 }
  assert.equal(eerinessOf(s, c, 0), 3)
})

// ── 注入块 ───────────────────────────────────────────────────────────────

test('平静时一个字都不注入', () => {
  const b = buildBlock(newState(0), cfg(), 0)
  assert.equal(b.text, '')
  assert.equal(b.mode, 'calm')
})

test('发作时注入块含型号与体感，且不写器官细节', () => {
  const b = buildBlock({ ...newState(0), pain: 90, swell: 70, flares: 2 }, cfg({ type: 'external' }), 0)
  assert.match(b.text, /外痔/)
  assert.match(b.text, /坐不住|针/)
  assert.doesNotMatch(b.text, /肛门|直肠|流血不止/)
})

test('内痔的注入块说的是血和晕，不是疼', () => {
  const b = buildBlock({ ...newState(0), blood: 70 }, cfg({ type: 'internal' }), 0)
  assert.equal(b.mode, 'dizzy')
  assert.match(b.text, /血|白|晕/)
})

test('诡异档会改变要求行', () => {
  const s = { ...newState(0), pain: 90, swell: 80, irritation: 60 }
  const b3 = buildBlock(s, cfg({ type: 'external', eeriness: 3 }), 0)
  assert.match(b3.text, /碎片|第三人称|重复/)
})

test('冷却期内同一状态不重复注入，发作例外', () => {
  const c = cfg()
  const s = { ...newState(0), pain: 50, lastInjectAt: -1e9 }
  const b = buildBlock(s, c, 1_000)
  assert.equal(shouldInject(s, c, b, 1_000).ok, true)
  s.lastInjectAt = 1_000
  s.lastInjectKey = b.key
  assert.equal(shouldInject(s, c, b, 2_000).skip, 'cooldown')

  const f = buildBlock({ ...s, pain: 90 }, c, 2_000)
  f.mode = 'flare'
  assert.equal(shouldInject({ ...s, pain: 90 }, c, f, 2_000).ok, true)
})

test('字数上限生效', () => {
  const c = cfg({ injectMaxChars: 120 })
  const b = buildBlock({ ...newState(0), pain: 90, blood: 90, swell: 90, flares: 9 }, c, 0)
  assert.ok(b.text.length <= 120, `len=${b.text.length}`)
})

// ── 状态收口 ─────────────────────────────────────────────────────────────

test('normalizeState：坏数据不炸，越界夹回来', () => {
  const s = normalizeState({ pain: 999, blood: -5, swell: 'abc', type: 'external', v: 9 }, 1000)
  assert.equal(s.pain, 100)
  assert.equal(s.blood, 0)
  assert.equal(s.swell, 0)
  assert.equal(s.type, 'external')
  assert.equal(s.v, 1)
})

test('同一状态压过 hold 之后允许复述', () => {
  const c = cfg({ injectCooldownMin: 10, sameStateHoldFactor: 3 })
  const state = { ...newState(0), pain: 50, lastInjectAt: 0, lastInjectKey: 'k' }
  const b = { text: 'x', key: 'k', mode: 'ache' }
  assert.equal(shouldInject(state, c, b, 10 * 60_000).skip, 'same')
  assert.equal(shouldInject(state, c, b, 31 * 60_000).ok, true)
})

test('effectiveType：状态覆盖配置', () => {
  assert.equal(effectiveType({ type: 'internal' }, cfg({ type: 'external' })), 'internal')
  assert.equal(effectiveType({ type: '' }, cfg({ type: 'external' })), 'external')
  assert.equal(metaOf({ type: 'internal' }, cfg()).label, '内痔')
})
