import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { nextAnchors, type AnchorItem } from '../../src/server/domain/anchor.ts'

const item = (uid: string, pubTs: number, ok: boolean): AnchorItem => ({ uid, pubTs, ok })

describe('nextAnchors', () => {
  it('全成功时推进到最大时间戳', () => {
    const next = nextAnchors([item('1', 100, true), item('1', 300, true), item('1', 200, true)], new Map())
    assert.equal(next.get('1'), 300)
  })

  it('只推进到「早于最早失败项」的最大成功时间戳', () => {
    // 失败卡在 200，所以 300/400 成功了也不能算 —— 否则 200 那条永远补不回来。
    const items = [item('1', 100, true), item('1', 200, false), item('1', 300, true), item('1', 400, true)]
    assert.equal(nextAnchors(items, new Map()).get('1'), 100)
  })

  it('最早的一条就失败时完全不推进', () => {
    const next = nextAnchors([item('1', 100, false), item('1', 200, true)], new Map())
    assert.equal(next.has('1'), false)
  })

  it('顺序不影响结果', () => {
    const base = [item('1', 100, true), item('1', 200, false), item('1', 300, true)]
    const orders = [base, [...base].reverse(), [base[2]!, base[0]!, base[1]!]]
    for (const order of orders) {
      assert.equal(nextAnchors(order, new Map()).get('1'), 100, JSON.stringify(order))
    }
  })

  it('不回退：算出来的值不大于现值就不返回这个 uid', () => {
    const items = [item('1', 100, true), item('1', 200, true)]
    assert.equal(nextAnchors(items, new Map([['1', 500]])).has('1'), false)
    assert.equal(nextAnchors(items, new Map([['1', 200]])).has('1'), false)
    assert.equal(nextAnchors(items, new Map([['1', 150]])).get('1'), 200)
  })

  it('每个 uid 各自算，一个人的失败不拖累别人', () => {
    const next = nextAnchors(
      [item('1', 100, false), item('1', 200, true), item('2', 300, true)],
      new Map(),
    )
    assert.equal(next.has('1'), false)
    assert.equal(next.get('2'), 300)
  })
})
