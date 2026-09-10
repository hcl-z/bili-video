/** 同 `http-client.test.ts`：对 spec「`infra/` 适配器不写自动化测试」的有意偏离， 假的只有 `fetch`。这里钉的是票 02 的两条硬性要求：登录轮询的 86101/86090/0 状态机， 以及 cookie 续期应项四步链（`cookie/info` → `correspond/1` → `refresh` → `confirm`）。 续期一年才走一次，没有测就等于没写 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'

import { BiliAuthClient, POLL_URL, QR_GENERATE_URL } from '../../src/server/infra/bili/login.ts'
import { createBrowserIdentity } from '../../src/server/infra/bili/browser-identity.ts'
import { BiliHttp } from '../../src/server/infra/bili/http-client.ts'
import { CollectingLogger } from '../fakes/logger.ts'
import { FakeFetch } from '../fakes/bili-fetch.ts'
import { MemoryCookieJar } from '../fakes/cookie-jar.ts'

const TABLE = Array.from({ length: 64 }, (_, i) => i)
const NOW = 1_700_000_000_000

function rig(cookies: Record<string, string> = {}, opts: RigOptions = {}) {
  const fetch = new FakeFetch()
  const logger = new CollectingLogger()
  const jar = new MemoryCookieJar(cookies, NOW + 30 * 86_400_000)
  const now = NOW
  let token: string | null = opts.refreshToken ?? null
  const http = new BiliHttp({
    fetch: fetch.fetch,
    identity: createBrowserIdentity(() => 0.5),
    cookies: jar,
    clock: { now: () => now, sleep: async () => {}, schedule: () => () => {}, checkCron: () => null },
    logger,
    config: () => ({ wbiMixinTable: TABLE, ticket: { keyId: 'ec02', hmacKey: 'hmac' } }),
  })
  const auth = new BiliAuthClient({
    http,
    cookies: jar,
    clock: { now: () => now, sleep: async () => {}, schedule: () => () => {}, checkCron: () => null },
    logger,
    config: () => ({ correspondPublicKeyPem: opts.pem ?? '' }),
    tokens: {
      get: () => token,
      set: (t) => {
        token = t
      },
    },
  })
  // token 从注入的 store 里读，而不是让生产代码多长一个只有测试用的 getter
  return { auth, fetch, jar, logger, now, token: () => token }
}

interface RigOptions {
  /** 预置的 refresh_token（模拟「上次登录留下的」） */
  refreshToken?: string

  pem?: string
}

describe('infra/bili 扫码登录', () => {
  it('拿到二维码内容与轮询 key', async () => {
    const r = rig()
    r.fetch.on(QR_GENERATE_URL, {
      data: { url: 'https://qr.example/login?key=abc', qrcode_key: 'abc' },
    })

    const res = await r.auth.startQrLogin()
    assert.ok(res.ok)
    assert.equal(res.value.qrcodeKey, 'abc')
    assert.equal(res.value.url, 'https://qr.example/login?key=abc')
  })

  it('响应缺字段时是 fatal，不给出一个 key 为 undefined 的二维码', async () => {
    const r = rig()
    r.fetch.on(QR_GENERATE_URL, { data: { url: 'x' } })
    const res = await r.auth.startQrLogin()
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'fatal')
  })

  it('轮询驱动出「待扫码 → 已扫码 → 成功」，并在成功时收下 cookie', async () => {
    const r = rig()
    r.fetch.onSequence(POLL_URL, [
      { data: { code: 86101, message: '未扫码' } },
      { data: { code: 86090, message: '已扫码未确认' } },
      {
        data: { code: 0, message: '', refresh_token: 'rt-1', timestamp: 1_700_000_000_000 },
        setCookie: [
          'SESSDATA=sess-value; Path=/; Domain=.bilibili.com; Max-Age=2592000; HttpOnly',
          'bili_jct=jct-value; Path=/; Domain=.bilibili.com; Max-Age=2592000',
          'DedeUserID=12345; Path=/; Domain=.bilibili.com; Max-Age=2592000',
        ],
      },
    ])
    r.fetch.on('/x/web-interface/nav', {
      data: { isLogin: true, mid: 12345, uname: '小号甲' },
    })

    const first = await r.auth.pollQrLogin('abc')
    assert.ok(first.ok)
    assert.equal(first.value.state, 'pending')

    const second = await r.auth.pollQrLogin('abc')
    assert.ok(second.ok)
    assert.equal(second.value.state, 'scanned')

    const third = await r.auth.pollQrLogin('abc')
    assert.ok(third.ok)
    assert.equal(third.value.state, 'confirmed')
    assert.ok(third.value.state === 'confirmed')
    assert.equal(third.value.uid, '12345')
    assert.equal(third.value.uname, '小号甲')

    // cookie 必须真的进了 jar，否则「登录成功」是句空话
    assert.equal(r.jar.get('SESSDATA'), 'sess-value')
    assert.equal(r.jar.csrf(), 'jct-value')
  })

  it('二维码过期是独立状态，不是失败 —— 页面该重新出码而不是报错', async () => {
    const r = rig()
    r.fetch.on(POLL_URL, { data: { code: 86038, message: '二维码已失效' } })
    const res = await r.auth.pollQrLogin('abc')
    assert.ok(res.ok)
    assert.equal(res.value.state, 'expired')
  })

  it('不认识的轮询码变成失败，绝不当成 pending 让页面永远转圈', async () => {
    const r = rig()
    r.fetch.on(POLL_URL, { data: { code: 99999, message: '天知道' } })
    const res = await r.auth.pollQrLogin('abc')
    assert.ok(!res.ok)
    assert.match(res.failure.message, /99999/)
  })

  it('确认成功但 refresh_token 没给到时仍算登录成功，只是后续只能重新扫码', async () => {
    const r = rig()
    r.fetch.on(POLL_URL, {
      data: { code: 0, message: '' },
      setCookie: ['SESSDATA=s; Max-Age=100', 'DedeUserID=1; Max-Age=100'],
    })
    r.fetch.on('/x/web-interface/nav', { data: { isLogin: true, mid: 1, uname: 'u' } })
    const res = await r.auth.pollQrLogin('abc')
    assert.ok(res.ok)
    assert.equal(res.value.state, 'confirmed')
    assert.equal(r.token(), null)
  })

  it('成功时把 refresh_token 留给续期链用', async () => {
    const r = rig()
    r.fetch.on(POLL_URL, {
      data: { code: 0, refresh_token: 'rt-9' },
      setCookie: ['SESSDATA=s; Max-Age=100', 'DedeUserID=1; Max-Age=100'],
    })
    r.fetch.on('/x/web-interface/nav', { data: { isLogin: true, mid: 1, uname: 'u' } })
    await r.auth.pollQrLogin('abc')
    assert.equal(r.token(), 'rt-9')
  })
})

describe('infra/bili 登录状态', () => {
  it('cookie 为空时直接说没登录，不白打一次网络', async () => {
    const r = rig()
    const res = await r.auth.status()
    assert.ok(res.ok)
    assert.equal(res.value.loggedIn, false)
    assert.equal(res.value.uid, null)
    assert.equal(r.fetch.requests.length, 0)
  })

  it('带上昵称、到期时间与「该不该续期」', async () => {
    const r = rig({ SESSDATA: 's', bili_jct: 'jct', DedeUserID: '42' })
    r.fetch.on('/x/web-interface/nav', { data: { isLogin: true, mid: 42, uname: '小号甲' } })
    r.fetch.on('/x/passport-login/web/cookie/info', {
      data: { refresh: true, timestamp: 1_700_000_000_000 },
    })

    const res = await r.auth.status()
    assert.ok(res.ok)
    assert.equal(res.value.loggedIn, true)
    assert.equal(res.value.uid, '42')
    assert.equal(res.value.uname, '小号甲')
    assert.equal(res.value.needsRefresh, true)
    assert.equal(res.value.expiresAt, 1_700_000_000_000 + 30 * 86_400_000)
  })

  it('nav 回 -101 时是「登录已失效」，不是 loggedIn=true', async () => {
    const r = rig({ SESSDATA: 'stale-sessdata' })
    r.fetch.on('/x/web-interface/nav', { code: -101, message: '账号未登录' })
    r.fetch.on('/x/passport-login/web/cookie/info', { data: { refresh: false } })

    const res = await r.auth.status()
    assert.ok(res.ok)
    assert.equal(res.value.loggedIn, false)
  })

  it('cookie/info 打不通时不假装「不需要续期」', async () => {
    const r = rig({ SESSDATA: 's' })
    r.fetch.on('/x/web-interface/nav', { data: { isLogin: true, mid: 1, uname: 'u' } })
    r.fetch.on('/x/passport-login/web/cookie/info', { status: 503 })

    const res = await r.auth.status()
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'transient')
  })
})

describe('infra/bili cookie 续期链', () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const LOGGED_IN = { SESSDATA: 'old-sess', bili_jct: 'old-jct', DedeUserID: '42' }
  /** 真实的 refresh_csrf 是 32 位十六进制，测试数据也照这个形状来 */
  const REFRESH_CSRF = '0123456789abcdef0123456789abcdef'
  const CORRESPOND_PAGE = `<html><body><div id="1-name">${REFRESH_CSRF}</div></body></html>`

  const chain = (r: ReturnType<typeof rig>) => {
    r.fetch.on('/x/passport-login/web/cookie/info', {
      data: { refresh: true, timestamp: 1_699_000_000_000 },
    })
    r.fetch.on('/correspond/1/', { raw: CORRESPOND_PAGE })
    return r
  }

  it('走完四步：新 cookie 进 jar，新 token 存下，旧 token 被吊销', async () => {
    const r = chain(rig(LOGGED_IN, { refreshToken: 'old-token', pem: publicKey }))
    r.fetch.on('/web/cookie/refresh', {
      data: { status: 0, message: '0', refresh_token: 'new-token' },
      setCookie: ['SESSDATA=new-sess; Max-Age=2592000', 'bili_jct=new-jct; Max-Age=2592000'],
    })
    r.fetch.on('/web/confirm/refresh', { data: null })

    const res = await r.auth.refreshCookies()
    assert.ok(res.ok, JSON.stringify(res))
    assert.equal(r.jar.get('SESSDATA'), 'new-sess')
    assert.equal(r.token(), 'new-token')

    // confirm 必须带**新** csrf 和**旧** token，写反了旧 cookie 就吊销不掉。
    const confirm = r.fetch.requests.find((q) => q.url.includes('/web/confirm/refresh'))!
    const body = new URLSearchParams(confirm.body!)
    assert.equal(body.get('csrf'), 'new-jct')
    assert.equal(body.get('refresh_token'), 'old-token')

    // cookie/refresh 带的是**旧** csrf 加页面上抠出来的 refresh_csrf。
    const refresh = new URLSearchParams(
      r.fetch.requests.find((q) => q.url.includes('/web/cookie/refresh'))!.body!,
    )
    assert.equal(refresh.get('csrf'), 'old-jct')
    assert.equal(refresh.get('refresh_csrf'), REFRESH_CSRF)
    assert.equal(refresh.get('source'), 'main_web')
  })

  it('correspond 页面没有 refresh_csrf 时是「登录已失效」，不是可重试错误', async () => {
    const r = rig(LOGGED_IN, { refreshToken: 'old-token', pem: publicKey })
    r.fetch.on('/x/passport-login/web/cookie/info', { data: { refresh: true, timestamp: 1 } })
    r.fetch.on('/correspond/1/', { raw: '<html><body>请先登录</body></html>' })

    const res = await r.auth.refreshCookies()
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'auth-lost')
    assert.equal(res.failure.retryAfterMs, null)
  })

  it('cookie/refresh 失败时旧 cookie 原样保留 —— 换到一半比不换更糟', async () => {
    const r = chain(rig(LOGGED_IN, { refreshToken: 'old-token', pem: publicKey }))
    r.fetch.on('/web/cookie/refresh', {
      data: { status: 1, message: '刷新失败', refresh_token: '' },
    })

    const res = await r.auth.refreshCookies()
    assert.ok(!res.ok)
    assert.equal(r.jar.get('SESSDATA'), 'old-sess')
    assert.equal(r.token(), 'old-token')
    assert.equal(r.fetch.countOf('/web/confirm/refresh'), 0)
  })

  it('最后一步 confirm 失败仍算续期成功 —— 新 cookie 已经能用了', async () => {
    const r = chain(rig(LOGGED_IN, { refreshToken: 'old-token', pem: publicKey }))
    r.fetch.on('/web/cookie/refresh', {
      data: { status: 0, refresh_token: 'new-token' },
      setCookie: ['SESSDATA=new-sess; Max-Age=2592000'],
    })
    r.fetch.on('/web/confirm/refresh', { status: 503 })

    const res = await r.auth.refreshCookies()
    assert.ok(res.ok)
    assert.ok(r.logger.lines.some((l) => l.level === 'warn' && /旧 token 未吊销/.test(l.msg ?? '')))
  })

  it('没有 refresh_token 时直接说要重新扫码，不打任何请求', async () => {
    const r = rig(LOGGED_IN, { pem: publicKey })
    const res = await r.auth.refreshCookies()
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'auth-lost')
    assert.match(res.failure.message, /重新扫码/)
    assert.equal(r.fetch.requests.length, 0)
  })

  it('没有 bili_jct 时同样是「登录已失效」', async () => {
    const r = rig({ SESSDATA: 'only-sess' }, { refreshToken: 'old-token', pem: publicKey })
    const res = await r.auth.refreshCookies()
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'auth-lost')
  })

  it('公钥没配时给出说清缺哪项配置的 fatal', async () => {
    const r = rig(LOGGED_IN, { refreshToken: 'old-token' })
    r.fetch.on('/x/passport-login/web/cookie/info', { data: { refresh: true, timestamp: 1 } })

    const res = await r.auth.refreshCookies()
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'fatal')
    assert.match(res.failure.message, /correspondPublicKeyPem/)
  })
})
