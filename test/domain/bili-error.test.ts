import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FailureKind } from '#shared/contract/failure.ts'
import {
  RETRY_AFTER_MS,
  classifyBiliCode,
  classifyHttpStatus,
  classifyThrown,
} from '../../src/server/domain/bili-error.ts'

/** 这张表就是「值最钱的部分」（spec 附录原话）。它错一格的后果不是报错， 而是安静地做错事：把风控当终态 → 系统再也不轮询；把鉴权失效当瞬时 → 拿着废 cookie 疯狂重试，把账号送进更深的风控。所以逐码固定验证 */
describe('domain/bili-error 码表', () => {
  const cases: Array<[code: number, kind: FailureKind, why: string]> = [
    [-101, 'auth-lost', '账号未登录：停下来等重新扫码，重试一万次也不会变好'],
    [-111, 'auth-lost', 'csrf 校验失败：bili_jct 与 SESSDATA 不咬合，等于登录态坏了'],
    [-352, 'risk-control', '风控校验失败：非终态，清 WBI key 重取 ticket 再试'],
    [-403, 'risk-control', '访问权限不足：B 站这里给的是风控，不是真的权限问题'],
    [-412, 'risk-control', '请求被拦截：WAF 拦的，退避后能恢复'],
    [-509, 'rate-limit', '请求过于频繁'],
    [-799, 'rate-limit', '请求过于频繁（另一个口径）'],
    [-400, 'fatal', '请求错误：参数错了，重试没意义'],
    [-404, 'fatal', '啥都木有：目标不存在'],
    [-110, 'fatal', '未绑定手机：要人去处理，不是重试能解决的'],
  ]

  for (const [code, kind, why] of cases) {
    it(`${code} → ${kind}（${why}）`, () => {
      const f = classifyBiliCode(code, 'x')
      assert.ok(f, `${code} 应该是失败`)
      assert.equal(f.kind, kind)
      assert.equal(f.code, code)
    })
  }

  it('code 0 不是失败', () => {
    assert.equal(classifyBiliCode(0, 'ok'), null)
  })

  it('未知码归 fatal 而不是 transient —— 不认识的东西不许盲目重试', () => {
    const f = classifyBiliCode(-99999, '未知')
    assert.ok(f)
    assert.equal(f.kind, 'fatal')
    // 原始 message 必须留着：排查未知码时它是唯一线索。
    assert.match(f.message, /未知/)
  })

  it('保留 B 站原始 message 与 code，不吞掉', () => {
    const f = classifyBiliCode(-352, '风控校验失败')
    assert.ok(f)
    assert.equal(f.code, -352)
    assert.match(f.message, /风控校验失败/)
  })
})

describe('domain/bili-error HTTP 状态', () => {
  const cases: Array<[status: number, kind: FailureKind]> = [
    [412, 'risk-control'],
    [429, 'rate-limit'],
    [401, 'auth-lost'],
    [403, 'risk-control'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [400, 'fatal'],
    [404, 'fatal'],
  ]

  for (const [status, kind] of cases) {
    it(`HTTP ${status} → ${kind}`, () => {
      assert.equal(classifyHttpStatus(status).kind, kind)
    })
  }

  it('HTTP 层的失败 code 是 null —— 它不是 B 站业务码', () => {
    assert.equal(classifyHttpStatus(500).code, null)
  })
})

describe('domain/bili-error 异常', () => {
  it('网络抖动、超时都是 transient', () => {
    assert.equal(classifyThrown(new TypeError('fetch failed')).kind, 'transient')
    assert.equal(classifyThrown(new Error('The operation was aborted')).kind, 'transient')
  })

  it('非 Error 也不会炸，照样给出可读 message', () => {
    const f = classifyThrown('字符串异常')
    assert.equal(f.kind, 'transient')
    assert.match(f.message, /字符串异常/)
  })
})

describe('domain/bili-error 退避建议', () => {
  it('风控退避 5 分钟（抄参考实现）', () => {
    assert.equal(RETRY_AFTER_MS['risk-control'], 5 * 60_000)
    assert.equal(classifyBiliCode(-352, 'x')?.retryAfterMs, 5 * 60_000)
  })

  it('鉴权失效与终态错误不给退避时间 —— 它们不该被重试', () => {
    assert.equal(RETRY_AFTER_MS['auth-lost'], null)
    assert.equal(RETRY_AFTER_MS.fatal, null)
    assert.equal(classifyBiliCode(-101, 'x')?.retryAfterMs, null)
  })

  it('限流比风控短，瞬时错误最短', () => {
    const rate = RETRY_AFTER_MS['rate-limit']
    const transient = RETRY_AFTER_MS.transient
    assert.ok(rate !== null && transient !== null)
    assert.ok(transient < rate && rate < RETRY_AFTER_MS['risk-control']!)
  })
})
