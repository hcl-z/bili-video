import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mixinKey, signWbi, type WbiKeys } from '../../src/server/infra/bili/wbi.ts'


const IDENTITY = Array.from({ length: 64 }, (_, i) => i)

const REVERSED = Array.from({ length: 64 }, (_, i) => 63 - i)

const KEYS: WbiKeys = {

  imgKey: 'abcdefghijklmnopqrstuvwxyz012345',
  subKey: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ678901',
  fetchedAt: 0,
}

const RAW = KEYS.imgKey + KEYS.subKey

describe('infra/bili WBI 混淆密钥', () => {
  it('按表重排后取前 32 位', () => {
    assert.equal(mixinKey(KEYS, IDENTITY), RAW.slice(0, 32))
  })

  it('表的顺序真的生效（倒序表给出倒序的前 32 位）', () => {
    assert.equal(mixinKey(KEYS, REVERSED), [...RAW].reverse().join('').slice(0, 32))
  })

  it('表长度不对就抛，不产出一个签错的密钥', () => {
    assert.throws(() => mixinKey(KEYS, [1, 2, 3]), /64/)
  })

  it('key 长度不对也抛 —— imgKey 变短意味着 nav 响应变了，别猜', () => {
    assert.throws(() => mixinKey({ ...KEYS, imgKey: 'short' }, IDENTITY), /64/)
  })
})

describe('infra/bili WBI 签名', () => {
  const sign = (params: Record<string, string | number>, wts = 1_700_000_000) =>
    signWbi(params, KEYS, IDENTITY, wts)

  it('补上 wts 与 w_rid', () => {
    const out = sign({ mid: 123 })
    assert.equal(out['wts'], '1700000000')
    assert.match(out['w_rid']!, /^[0-9a-f]{32}$/)
    assert.equal(out['mid'], '123')
  })

  it('参数顺序不影响签名 —— 签名前必须按 key 排序', () => {
    const a = sign({ mid: 1, ps: 30, pn: 1 })
    const b = sign({ pn: 1, mid: 1, ps: 30 })
    assert.equal(a['w_rid'], b['w_rid'])
  })

  it("值里的 !'()* 会被剔除后再签", () => {
    const withSpecials = sign({ keyword: "a!b'c(d)e*f" })
    const without = sign({ keyword: 'abcdef' })
    assert.equal(withSpecials['w_rid'], without['w_rid'])

    assert.equal(withSpecials['keyword'], "a!b'c(d)e*f")
  })

  it('换一个 wts 就换一个签名（否则签名可以被无限重放）', () => {
    assert.notEqual(sign({ mid: 1 }, 1)['w_rid'], sign({ mid: 1 }, 2)['w_rid'])
  })

  it('换 imgKey 就换签名', () => {
    const other = signWbi({ mid: 1 }, { ...KEYS, imgKey: '5432109876zyxwvutsrqponmlkjihgfe' }, IDENTITY, 1)
    assert.notEqual(sign({ mid: 1 }, 1)['w_rid'], other['w_rid'])
  })

  it('中文与空格按 URL 编码后参与签名，不是原样拼进去', () => {
    const out = sign({ keyword: '测试 视频' })
    assert.equal(out['keyword'], '测试 视频')
    assert.match(out['w_rid']!, /^[0-9a-f]{32}$/)
  })

  it('未配置混淆表时明确抛错，而不是发一个必定 -352 的请求', () => {
    assert.throws(() => signWbi({ mid: 1 }, KEYS, [], 1), /混淆表/)
  })
})
