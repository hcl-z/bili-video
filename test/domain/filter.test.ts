import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FilterRule, RuleKind } from '#shared/contract/subscription.ts'
import {
  evaluate,
  inQuietHours,
  resolveRules,
  type QuietHours,
  type RegexMatcher,
} from '../../src/server/domain/filter.ts'

let seq = 0
const rule = (kind: RuleKind, pattern: string, scope = 'global'): FilterRule => ({
  id: (seq += 1),
  scope,
  kind,
  pattern,
  enabled: true,
})

const realMatch: RegexMatcher = (pattern, text) => new RegExp(pattern).test(text)
const off: QuietHours = { enabled: false, start: '23:30', end: '07:30' }

const judge = (rules: FilterRule[], text: string, match: RegexMatcher = realMatch) =>
  evaluate({ target: { title: null, text, desc: null }, rules, match, minuteOfDay: 600, quietHours: off })
    .verdict

describe('黑白名单优先级', () => {
  it('没有规则就通过', () => {
    assert.equal(judge([], '随便什么').kind, 'pass')
  })

  it('黑名单命中就拦下', () => {
    const v = judge([rule('keyword-deny', '恰饭')], '今天这条是恰饭视频')
    assert.equal(v.kind, 'blocked')
    assert.match(v.kind === 'blocked' ? v.reason : '', /全局关键词黑名单「恰饭」/)
  })

  it('黑名单优先于白名单：两个都命中也拦下', () => {
    const v = judge([rule('keyword-allow', '技术'), rule('keyword-deny', '恰饭')], '技术区恰饭')
    assert.equal(v.kind, 'blocked')
  })

  it('白名单非空时没命中就拦下', () => {
    const v = judge([rule('keyword-allow', '技术')], '今天吃了顿好的')
    assert.equal(v.kind, 'blocked')
    assert.match(v.kind === 'blocked' ? v.reason : '', /白名单非空/)
  })

  it('白名单命中就通过', () => {
    assert.equal(judge([rule('keyword-allow', '技术')], '技术分享').kind, 'pass')
  })

  it('正则黑白名单同样参与优先级', () => {
    assert.equal(judge([rule('regex-deny', '^广告')], '广告位招租').kind, 'blocked')
    assert.equal(judge([rule('regex-allow', 'Rust|Go')], '聊聊 Rust').kind, 'pass')
    assert.equal(judge([rule('regex-allow', 'Rust')], '聊聊 Java').kind, 'blocked')
  })

  it('超时的规则不算命中，也不阻塞判定', () => {
    const timeout: RegexMatcher = () => 'timeout'
    // 一条跑废的黑名单不该把所有内容都拦下。
    assert.equal(judge([rule('regex-deny', '(a+)+$')], '正常内容', timeout).kind, 'pass')
    // 跑废的白名单等于「没命中」，仍然拦下 —— 白名单的语义是「只放行命中的」。
    assert.equal(judge([rule('regex-allow', '(a+)+$')], '正常内容', timeout).kind, 'blocked')
  })
})

describe('免扰时段', () => {
  const quiet: QuietHours = { enabled: true, start: '23:30', end: '07:30' }
  const at = (minuteOfDay: number) =>
    evaluate({
      target: { title: null, text: '内容', desc: null },
      rules: [],
      match: realMatch,
      minuteOfDay,
      quietHours: quiet,
    }).verdict

  it('免扰时段内挂起而不是丢弃', () => {
    const v = at(0)
    assert.equal(v.kind, 'held')
    assert.match(v.kind === 'held' ? v.reason : '', /免扰时段/)
  })

  it('跨午夜的边界：start 含、end 不含', () => {
    assert.equal(inQuietHours(23 * 60 + 29, quiet), false)
    assert.equal(inQuietHours(23 * 60 + 30, quiet), true)
    assert.equal(inQuietHours(7 * 60 + 29, quiet), true)
    assert.equal(inQuietHours(7 * 60 + 30, quiet), false)
  })

  it('不跨午夜的区间照常判', () => {
    const day: QuietHours = { enabled: true, start: '09:00', end: '18:00' }
    assert.equal(inQuietHours(8 * 60 + 59, day), false)
    assert.equal(inQuietHours(9 * 60, day), true)
    assert.equal(inQuietHours(18 * 60, day), false)
  })

  it('关掉、或者时间写坏了，都不挂起', () => {
    assert.equal(inQuietHours(0, off), false)
    assert.equal(inQuietHours(0, { enabled: true, start: '25:00', end: '07:30' }), false)
  })

  it('被拦下的条目不进免扰分支：blocked 优先', () => {
    const v = evaluate({
      target: { title: null, text: '恰饭', desc: null },
      rules: [rule('keyword-deny', '恰饭')],
      match: realMatch,
      minuteOfDay: 0,
      quietHours: quiet,
    }).verdict
    assert.equal(v.kind, 'blocked')
  })
})

describe('resolveRules', () => {
  it('per-UP 有规则就整套换掉全局的，不叠加', () => {
    const g = rule('keyword-deny', '恰饭')
    const mine = rule('keyword-deny', '带货', '123')
    const used = resolveRules('123', [g, mine])
    assert.deepEqual(used, [mine])
  })

  it('per-UP 没规则时用全局', () => {
    const g = rule('keyword-deny', '恰饭')
    assert.deepEqual(resolveRules('123', [g, rule('keyword-deny', '带货', '456')]), [g])
  })

  it('停用的规则不参与', () => {
    const mine = { ...rule('keyword-deny', '带货', '123'), enabled: false }
    const g = rule('keyword-deny', '恰饭')
    assert.deepEqual(resolveRules('123', [g, mine]), [g])
  })
})
