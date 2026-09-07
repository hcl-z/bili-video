import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'

import type { AuthState } from '#shared/contract/api.ts'
import { AuthLifecycle } from '../../src/server/app/auth-lifecycle.ts'
import { MAX_REFRESH_ATTEMPTS } from '../../src/server/domain/auth.ts'
import { createBrowserIdentity } from '../../src/server/infra/bili/browser-identity.ts'
import { BiliHttp } from '../../src/server/infra/bili/http-client.ts'
import { BiliAuthClient } from '../../src/server/infra/bili/login.ts'
import { InMemoryEventBus } from '../../src/server/infra/event-bus/in-memory.ts'
import { FakeClock } from '../fakes/clock.ts'
import { FakeFetch } from '../fakes/bili-fetch.ts'
import { MemoryCookieJar } from '../fakes/cookie-jar.ts'
import { CollectingLogger } from '../fakes/logger.ts'
import { MemoryStateRepo } from '../fakes/state.ts'

/**
 * 判据 9 的那条链：全程用假件，从伪造的轮询响应一路驱动到「登录成功」。
 *
 * 这里刻意**不**给 BiliAuth 打桩 —— 用真的 BiliAuthClient + 真的 BiliHttp，
 * 只把 fetch 换成假的。打桩 BiliAuth 会把「两层 code」「cookie 从 Set-Cookie 收」
 * 这些最容易错的地方一起桩掉，那条链就白测了。
 */

const TABLE = Array.from({ length: 64 }, (_, i) => i)
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0)
const MONTH = 30 * 86_400_000
const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const REFRESH_CSRF = '0123456789abcdef0123456789abcdef'

interface RigOptions {
  cookies?: Record<string, string>
  cookieExpiry?: number | null
  refreshToken?: string
  refreshFailures?: number
  thresholdMs?: number
}

function rig(opts: RigOptions = {}) {
  const fetch = new FakeFetch()
  const clock = new FakeClock(NOW)
  const logger = new CollectingLogger()
  const events = new InMemoryEventBus()
  const cookies = new MemoryCookieJar(
    opts.cookies ?? {},
    opts.cookieExpiry === undefined ? NOW + MONTH : opts.cookieExpiry,
  )
  const state = new MemoryStateRepo(
    opts.refreshFailures === undefined
      ? {}
      : { 'refresh-failures': String(opts.refreshFailures) },
  )
  let token: string | null = opts.refreshToken ?? null

  const http = new BiliHttp({
    fetch: fetch.fetch,
    identity: createBrowserIdentity(() => 0.5),
    cookies,
    clock,
    logger,
    config: () => ({ wbiMixinTable: TABLE, ticket: { keyId: 'ec02', hmacKey: 'hmac' } }),
  })
  const auth = new BiliAuthClient({
    http,
    cookies,
    clock,
    logger,
    config: () => ({ correspondPublicKeyPem: publicKey }),
    tokens: {
      get: () => token,
      set: (t) => {
        token = t
      },
    },
  })

  const seen: AuthState[] = []
  const qrs: string[] = []
  const lifecycle = new AuthLifecycle({
    auth,
    cookies,
    state,
    clock,
    events,
    logger,
    refreshThresholdMs: () => opts.thresholdMs ?? 15 * 86_400_000,
    showQr: (_art, url) => qrs.push(url),
    // 字符画本身另有单测；这里只关心「有没有把码交给人」。
    renderQr: async (url) => `[QR:${url}]`,
  })

  // 每次状态迁移都该发一个事件，工作台才能不轮询就更新。
  const emitted: boolean[] = []
  events.on((e) => {
    if (e.type === 'auth.changed') emitted.push(e.loggedIn)
  })
  const track = () => seen.push(lifecycle.snapshot().state)

  return { lifecycle, fetch, clock, logger, events, cookies, state, qrs, emitted, seen, track }
}

const LOGIN_COOKIES = [
  'SESSDATA=sess-value; Path=/; Domain=.bilibili.com; Max-Age=2592000; HttpOnly',
  'bili_jct=jct-value; Path=/; Domain=.bilibili.com; Max-Age=2592000',
  'DedeUserID=12345; Path=/; Domain=.bilibili.com; Max-Age=2592000',
]

function stubQrFlow(r: ReturnType<typeof rig>, polls: unknown[]): void {
  r.fetch.on('/qrcode/generate', {
    data: { url: 'https://qr.example/login?key=abc', qrcode_key: 'abc' },
  })
  r.fetch.onSequence(
    '/qrcode/poll',
    polls.map((data) =>
      (data as { code: number }).code === 0
        ? { data, setCookie: LOGIN_COOKIES }
        : { data },
    ),
  )
  r.fetch.on('/x/web-interface/nav', { data: { isLogin: true, mid: 12345, uname: '小号甲' } })
}

describe('app/auth-lifecycle 扫码登录全流程', () => {
  it('伪造的轮询响应驱动出「待扫码 → 已扫码 → 成功」', async () => {
    const r = rig()
    stubQrFlow(r, [
      { code: 86101, message: '未扫码' },
      { code: 86090, message: '已扫码未确认' },
      { code: 0, message: '', refresh_token: 'rt-1' },
    ])

    assert.equal(r.lifecycle.snapshot().state, 'logged-out')
    const res = await r.lifecycle.loginByQr()
    assert.ok(res.ok, JSON.stringify(res))

    // 状态迁移必须是这三步，一步都不能少也不能乱。
    const states = r.logger.lines
      .filter((l) => l.msg === '登录状态变化')
      .map((l) => (l.obj as { to: string }).to)
    assert.deepEqual(states, ['waiting-scan', 'scanned', 'logged-in'])
    assert.deepEqual(r.emitted, [false, false, true])

    const snap = r.lifecycle.snapshot()
    assert.equal(snap.state, 'logged-in')
    assert.equal(snap.uid, '12345')
    assert.equal(snap.uname, '小号甲')
    assert.equal(snap.remainingMs, MONTH)
    assert.equal(snap.lastError, null)
    assert.equal(r.cookies.get('SESSDATA'), 'sess-value')
    assert.deepEqual(r.qrs, ['https://qr.example/login?key=abc'])
    assert.ok(r.lifecycle.isUsable())
  })

  it('跳过「已扫码」直接确认也能走通 —— 手机快的时候真会这样', async () => {
    const r = rig()
    stubQrFlow(r, [{ code: 86101 }, { code: 0, refresh_token: 'rt' }])
    const res = await r.lifecycle.loginByQr()
    assert.ok(res.ok)
    assert.equal(r.lifecycle.snapshot().state, 'logged-in')
  })

  it('二维码过期时换一张新码，而不是报错收工', async () => {
    const r = rig()
    r.fetch.on('/qrcode/generate', (_req, hit) => ({
      data: { url: `https://qr.example/login?key=key-${hit}`, qrcode_key: `key-${hit}` },
    }))
    r.fetch.onSequence('/qrcode/poll', [
      { data: { code: 86038, message: '二维码已失效' } },
      { data: { code: 0, refresh_token: 'rt' }, setCookie: LOGIN_COOKIES },
    ])
    r.fetch.on('/x/web-interface/nav', { data: { isLogin: true, mid: 1, uname: 'u' } })

    const res = await r.lifecycle.loginByQr()
    assert.ok(res.ok, JSON.stringify(res))
    assert.equal(r.qrs.length, 2)
    assert.notEqual(r.qrs[0], r.qrs[1])
  })

  it('一直没人扫就明确超时，不永远转圈', async () => {
    const r = rig()
    r.fetch.on('/qrcode/generate', { data: { url: 'u', qrcode_key: 'k' } })
    r.fetch.on('/qrcode/poll', { data: { code: 86101 } })

    const res = await r.lifecycle.loginByQr()
    assert.ok(!res.ok)
    assert.match(res.failure.message, /超时/)
    assert.equal(r.lifecycle.snapshot().state, 'logged-out')
    assert.match(r.lifecycle.snapshot().lastError!, /超时/)
  })

  it('登录成功会把续期失败计数清零 —— 重新扫码就是重新开始', async () => {
    const r = rig({ refreshFailures: 3 })
    stubQrFlow(r, [{ code: 0, refresh_token: 'rt' }])
    await r.lifecycle.loginByQr()
    assert.equal(r.lifecycle.snapshot().refreshFailures, 0)
  })
})

describe('app/auth-lifecycle 登录态维持', () => {
  const stubStatus = (
    r: ReturnType<typeof rig>,
    opts: { loggedIn?: boolean; refresh?: boolean } = {},
  ) => {
    r.fetch.on(
      '/x/web-interface/nav',
      opts.loggedIn === false
        ? { code: -101, message: '账号未登录' }
        : { data: { isLogin: true, mid: 12345, uname: '小号甲' } },
    )
    r.fetch.on('/web/cookie/info', {
      data: { refresh: opts.refresh ?? false, timestamp: NOW - 86_400_000 },
    })
    return r
  }

  it('还在有效期内就什么都不做', async () => {
    const r = stubStatus(rig({ cookies: { SESSDATA: 's', bili_jct: 'jct' } }))
    const res = await r.lifecycle.ensureFresh()
    assert.ok(res.ok)
    assert.equal(res.value.action, 'idle')
    assert.equal(r.lifecycle.snapshot().state, 'logged-in')
    assert.equal(r.lifecycle.snapshot().checkedAt, NOW)
  })

  it('临近过期时自动续上，并把状态记成已登录', async () => {
    const r = stubStatus(
      rig({
        cookies: { SESSDATA: 'old', bili_jct: 'old-jct' },
        cookieExpiry: NOW + 3 * 86_400_000,
        refreshToken: 'old-token',
      }),
    )
    r.fetch.on('/correspond/1/', {
      raw: `<html><body><div id="1-name">${REFRESH_CSRF}</div></body></html>`,
    })
    r.fetch.on('/web/cookie/refresh', {
      data: { status: 0, refresh_token: 'new-token' },
      setCookie: ['SESSDATA=new-sess; Max-Age=2592000', 'bili_jct=new-jct; Max-Age=2592000'],
    })
    r.fetch.on('/web/confirm/refresh', { data: null })

    const res = await r.lifecycle.ensureFresh()
    assert.ok(res.ok, JSON.stringify(res))
    assert.equal(res.value.action, 'refresh')
    assert.equal(r.cookies.get('SESSDATA'), 'new-sess')
    assert.equal(r.lifecycle.snapshot().state, 'logged-in')
    assert.equal(r.lifecycle.snapshot().refreshFailures, 0)
  })

  it('服务端说该续期时就续，哪怕本地看着还早', async () => {
    const r = stubStatus(
      rig({ cookies: { SESSDATA: 'old', bili_jct: 'jct' }, refreshToken: 'old-token' }),
      { refresh: true },
    )
    r.fetch.on('/correspond/1/', {
      raw: `<html><body><div id="1-name">${REFRESH_CSRF}</div></body></html>`,
    })
    r.fetch.on('/web/cookie/refresh', {
      data: { status: 0, refresh_token: 'new' },
      setCookie: ['SESSDATA=new-sess; Max-Age=2592000'],
    })
    r.fetch.on('/web/confirm/refresh', { data: null })

    const res = await r.lifecycle.ensureFresh()
    assert.ok(res.ok)
    assert.equal(res.value.action, 'refresh')
  })

  it('续期失败会累计次数，到上限转「登录已失效」而不是继续无效重试', async () => {
    const r = stubStatus(
      rig({
        cookies: { SESSDATA: 'old', bili_jct: 'jct' },
        cookieExpiry: NOW + 86_400_000,
        refreshToken: 'old-token',
      }),
      { refresh: true },
    )
    r.fetch.on('/correspond/1/', { raw: '<html><body>请先登录</body></html>' })

    // correspond 抠不出 csrf 是 auth-lost：一次就该转终态，不用凑满三次。
    const res = await r.lifecycle.ensureFresh()
    assert.ok(res.ok)
    assert.equal(res.value.action, 'relogin')
    assert.equal(r.lifecycle.snapshot().state, 'auth-lost')
    assert.equal(r.lifecycle.isUsable(), false)
    assert.deepEqual(r.emitted, [false])
  })

  it('瞬时性的续期失败先累计，攒满 MAX_REFRESH_ATTEMPTS 才转终态', async () => {
    const r = stubStatus(
      rig({
        cookies: { SESSDATA: 'old', bili_jct: 'jct' },
        cookieExpiry: NOW + 86_400_000,
        refreshToken: 'old-token',
      }),
      { refresh: true },
    )
    r.fetch.on('/correspond/1/', { status: 503 })

    for (let i = 1; i < MAX_REFRESH_ATTEMPTS; i += 1) {
      const res = await r.lifecycle.ensureFresh()
      assert.ok(!res.ok, `第 ${i} 次应当仍是失败而不是终态`)
      assert.equal(r.lifecycle.snapshot().refreshFailures, i)
      assert.equal(r.lifecycle.snapshot().state, 'logged-in')
    }
    // 攒满之后：纯函数直接给 relogin，不再发起第 4 次续期。
    const last = await r.lifecycle.ensureFresh()
    assert.ok(last.ok)
    assert.equal(last.value.action, 'relogin')
    assert.equal(r.lifecycle.snapshot().state, 'auth-lost')
  })

  it('有 cookie 但 B 站说没登录 → 直接终态，不带着废 cookie 继续轮询', async () => {
    const r = stubStatus(rig({ cookies: { SESSDATA: 'stale' } }), { loggedIn: false })
    const res = await r.lifecycle.ensureFresh()
    assert.ok(res.ok)
    assert.equal(res.value.action, 'relogin')
    assert.equal(r.lifecycle.snapshot().state, 'auth-lost')
    assert.match(r.lifecycle.snapshot().lastError!, /重新扫码/)
  })

  it('cookie 已经过期就直接要重新扫码，不白试一次续期', async () => {
    const r = stubStatus(
      rig({ cookies: { SESSDATA: 'old', bili_jct: 'jct' }, cookieExpiry: NOW - 1 }),
    )
    const res = await r.lifecycle.ensureFresh()
    assert.ok(res.ok)
    assert.equal(res.value.action, 'relogin')
    assert.equal(r.fetch.countOf('/correspond/1/'), 0)
    assert.equal(r.lifecycle.snapshot().remainingMs, 0)
  })

  it('核对本身失败时保持原状态 —— 问不出来不等于没登录', async () => {
    const r = rig({ cookies: { SESSDATA: 's', bili_jct: 'jct' } })
    r.fetch.on('/x/web-interface/nav', { status: 503 })
    r.fetch.on('/web/cookie/info', { data: { refresh: false } })

    const res = await r.lifecycle.ensureFresh()
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'transient')
    assert.equal(r.lifecycle.snapshot().state, 'logged-in')
    assert.match(r.lifecycle.snapshot().lastError!, /503/)
    // 没得出结论就不该发事件，否则页面会闪一下「掉线了」。
    assert.deepEqual(r.emitted, [])
  })

  it('本地没有 cookie 时说「要扫码」，一个请求都不发给 B 站', async () => {
    const r = rig()
    const res = await r.lifecycle.ensureFresh()
    assert.ok(res.ok)
    assert.equal(res.value.action, 'relogin')
    assert.equal(r.fetch.requests.length, 0)
    // 全新安装：什么都没丢，所以是 logged-out，不是「登录已失效」。
    assert.equal(r.lifecycle.snapshot().state, 'logged-out')
    assert.match(r.lifecycle.snapshot().lastError!, /没有 cookie/)
  })
})
