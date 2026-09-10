import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_REFRESH_THRESHOLD_MS,
  MAX_REFRESH_ATTEMPTS,
  classifyQrPoll,
  decideAuthAction,
  remainingMs,
} from '../../src/server/domain/auth.ts'

describe('domain/auth 扫码轮询码', () => {
  it('86101 = 还没扫', () => {
    assert.deepEqual(classifyQrPoll(86101, ''), { state: 'pending' })
  })

  it('86090 = 扫了但还没在手机上点确认', () => {
    assert.deepEqual(classifyQrPoll(86090, ''), { state: 'scanned' })
  })

  it('86038 = 二维码过期，要重新生成而不是继续轮询', () => {
    assert.deepEqual(classifyQrPoll(86038, ''), { state: 'expired' })
  })

  it('0 = 确认成功', () => {
    assert.deepEqual(classifyQrPoll(0, ''), { state: 'confirmed' })
  })

  it('没见过的码不假装成 pending —— 那会让登录界面永远转圈', () => {
    const r = classifyQrPoll(-99, '出事了')
    assert.equal(r.state, 'failed')
    assert.ok('failure' in r && r.failure.message.includes('出事了'))
  })
})

describe('domain/auth cookie 剩余有效期', () => {
  it('没有到期时间就是 null，不猜', () => {
    assert.equal(remainingMs(null, 1000), null)
  })

  it('已过期返回 0，不返回负数 —— 页面上「剩余 -3 天」是 bug 而不是信息', () => {
    assert.equal(remainingMs(500, 1000), 0)
  })

  it('正常情况返回差值', () => {
    assert.equal(remainingMs(5000, 1000), 4000)
  })
})

describe('domain/auth 续期决策', () => {
  const base = {
    hasCookies: true,
    expiresAt: null as number | null,
    serverSaysRefresh: false,
    now: 1_000_000,
    thresholdMs: DEFAULT_REFRESH_THRESHOLD_MS,
    failedRefreshes: 0,
  }

  it('没有 cookie = 要重新扫码，不是要续期', () => {
    const d = decideAuthAction({ ...base, hasCookies: false })
    assert.equal(d.action, 'relogin')
  })

  it('cookie 还很新、服务端也没说要续 = 什么都不做', () => {
    const d = decideAuthAction({
      ...base,
      expiresAt: base.now + 90 * 86_400_000,
    })
    assert.equal(d.action, 'idle')
  })

  it('B 站的 cookie/info 说要续期就续期，哪怕本地算出来还很久', () => {
    const d = decideAuthAction({
      ...base,
      expiresAt: base.now + 90 * 86_400_000,
      serverSaysRefresh: true,
    })
    assert.equal(d.action, 'refresh')
    // 服务端的判断优先：它知道 refresh_token 的真实状态，我们只有个到期时间
    assert.match(d.reason, /cookie\/info/)
  })

  it('本地算出来快到期了也主动续 —— 不等 B 站开口', () => {
    const d = decideAuthAction({
      ...base,
      expiresAt: base.now + DEFAULT_REFRESH_THRESHOLD_MS - 1,
    })
    assert.equal(d.action, 'refresh')
  })

  it('已经过期 = 直接重新扫码，别浪费一次续期请求', () => {
    const d = decideAuthAction({ ...base, expiresAt: base.now - 1 })
    assert.equal(d.action, 'relogin')
  })

  it('续期连续失败到上限 → 转「登录已失效」，不再无效重试', () => {
    const d = decideAuthAction({
      ...base,
      serverSaysRefresh: true,
      failedRefreshes: MAX_REFRESH_ATTEMPTS,
    })
    assert.equal(d.action, 'relogin')
    assert.match(d.reason, /续期/)
  })

  it('失败但还没到上限，仍然可以再试一次', () => {
    const d = decideAuthAction({
      ...base,
      serverSaysRefresh: true,
      failedRefreshes: MAX_REFRESH_ATTEMPTS - 1,
    })
    assert.equal(d.action, 'refresh')
  })

  it('到期时间未知时不主动续期 —— 拿不到信息不等于出事了', () => {
    const d = decideAuthAction({ ...base, expiresAt: null })
    assert.equal(d.action, 'idle')
  })
})
