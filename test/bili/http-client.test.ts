/** 对 spec「`infra/` 里对真外部的适配器不写自动化测试」的一处有意偏离。 应项取舍的理由是「给它们写 mock 测试只会测到 mock 自己」。这里假的只有 `fetch` 这一个进程边界，签名、身份、Set-Cookie 收集、错误码分类跑的都是实际代码，所以测到的不是 mock。 而票 02 要求「命中风控时先清空签名 key、重取 ticket 并重试一次」—— 应项链只有在这一层才编排得出来：它一次成功的表现是「什么都没发生」，最需要固定验证 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBrowserIdentity } from '../../src/server/infra/bili/browser-identity.ts'
import { BiliHttp, type BiliHttpConfig } from '../../src/server/infra/bili/http-client.ts'
import { CollectingLogger } from '../fakes/logger.ts'
import { FakeFetch } from '../fakes/bili-fetch.ts'
import { MemoryCookieJar } from '../fakes/cookie-jar.ts'

const TABLE = Array.from({ length: 64 }, (_, i) => i)
const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

interface Rig {
  http: BiliHttp
  fetch: FakeFetch
  logger: CollectingLogger
  jar: MemoryCookieJar
  setNow(ms: number): void
}

function rig(config: Partial<BiliHttpConfig> = {}, cookies: Record<string, string> = {}): Rig {
  const fetch = new FakeFetch()
  const logger = new CollectingLogger()
  const jar = new MemoryCookieJar(cookies)
  let now = 1_700_000_000_000
  const full: BiliHttpConfig = {
    wbiMixinTable: config.wbiMixinTable ?? TABLE,
    ticket: config.ticket ?? { keyId: 'ec02', hmacKey: 'hmac' },
  }
  const http = new BiliHttp({
    fetch: fetch.fetch,
    identity: createBrowserIdentity(() => 0.5),
    cookies: jar,
    clock: {
      now: () => now,
      sleep: async () => {},
      schedule: () => () => {}, checkCron: () => null,
    },
    logger,
    config: () => full,
  })
  return {
    http,
    fetch,
    logger,
    jar,
    setNow: (ms) => {
      now = ms
    },
  }
}

/** 换 ticket 的标准成功响应，顺带给 WBI key */
const ticketOk = { code: 0, data: { ticket: 'tk', ttl: 259_200, nav: { img: { img_url: IMG }, sub: { sub_url: SUB } } } }

describe('infra/bili HTTP 客户端：身份与信封', () => {
  it('每个请求都带上稳定的浏览器身份和 cookie', async () => {
    const r = rig({}, { SESSDATA: 'sess', bili_jct: 'jct' })
    r.fetch.on('/x/test', { data: { hello: 1 } })

    const res = await r.http.get<{ hello: number }>('https://api.bilibili.com/x/test')
    assert.ok(res.ok)
    assert.deepEqual(res.value, { hello: 1 })

    const req = r.fetch.requests[0]!
    assert.match(req.headers['user-agent']!, /Chrome\/\d+/)
    // UA 与客户端提示头必须咬合，否则这套身份本身就是风控信号
    const major = /Chrome\/(\d+)/.exec(req.headers['user-agent']!)![1]!
    assert.ok(req.headers['sec-ch-ua']!.includes(`v="${major}"`))
    assert.equal(req.headers['cookie'], 'SESSDATA=sess; bili_jct=jct')
    assert.equal(req.headers['referer'], 'https://www.bilibili.com/')
  })

  it('业务码非 0 时按分类给出失败，而不是把 data 当成功值交出去', async () => {
    const r = rig()
    r.fetch.on('/x/test', { code: -101, message: '账号未登录' })

    const res = await r.http.get('https://api.bilibili.com/x/test')
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'auth-lost')
    assert.equal(res.failure.code, -101)
    assert.equal(res.failure.retryAfterMs, null)
  })

  it('HTTP 5xx 是 transient，412 是风控', async () => {
    const a = rig()
    a.fetch.on('/x/a', { status: 503 })
    const resA = await a.http.get('https://api.bilibili.com/x/a', {}, { noRetry: true })
    assert.ok(!resA.ok)
    assert.equal(resA.failure.kind, 'transient')

    const b = rig()
    b.fetch.on('/x/b', { status: 412 })
    const resB = await b.http.get('https://api.bilibili.com/x/b', {}, { noRetry: true })
    assert.ok(!resB.ok)
    assert.equal(resB.failure.kind, 'risk-control')
  })

  it('网络异常收成 transient，不往外抛', async () => {
    const r = rig()
    r.fetch.on('/x/test', () => {
      throw new Error('ECONNRESET')
    })
    const res = await r.http.get('https://api.bilibili.com/x/test')
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'transient')
    assert.match(res.failure.message, /ECONNRESET/)
  })

  it('响应不是信封格式时是 fatal，并保留一段原文用于排查', async () => {
    const r = rig()
    r.fetch.on('/x/test', { raw: { unexpected: true } })
    const res = await r.http.get('https://api.bilibili.com/x/test')
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'fatal')
    assert.match(res.failure.message, /unexpected/)
  })

  it('即使业务码失败也会收下 Set-Cookie —— B 站会顺手换 buvid', async () => {
    const r = rig()
    r.fetch.on('/x/test', { code: -352, message: '风控校验失败', setCookie: ['buvid3=xyz; Path=/'] })
    r.fetch.on('GenWebTicket', ticketOk)

    await r.http.get('https://api.bilibili.com/x/test')
    assert.equal(r.jar.get('buvid3'), 'xyz')
  })
})

describe('infra/bili HTTP 客户端：WBI 签名', () => {
  it('opts.wbi 时先取 key 再签名，并把 wts/w_rid 带上', async () => {
    const r = rig()
    r.fetch.on('GenWebTicket', ticketOk)
    r.fetch.on('/x/space', { data: { list: [] } })

    const res = await r.http.get('https://api.bilibili.com/x/space', { mid: 1 }, { wbi: true })
    assert.ok(res.ok)

    const signed = r.fetch.requests.find((q) => q.url.includes('/x/space'))!
    assert.equal(signed.query.get('mid'), '1')
    assert.match(signed.query.get('w_rid')!, /^[0-9a-f]{32}$/)
    assert.equal(signed.query.get('wts'), '1700000000')
  })

  it('WBI key 会缓存，第二次调用不再打 ticket/nav', async () => {
    const r = rig()
    r.fetch.on('GenWebTicket', ticketOk)
    r.fetch.on('/x/space', { data: null })

    await r.http.get('https://api.bilibili.com/x/space', { mid: 1 }, { wbi: true })
    await r.http.get('https://api.bilibili.com/x/space', { mid: 2 }, { wbi: true })
    assert.equal(r.fetch.countOf('GenWebTicket'), 1)
    assert.equal(r.fetch.countOf('/x/space'), 2)
  })

  it('ticket key 没配就退回 nav 取 WBI key', async () => {
    const r = rig({ ticket: { keyId: '', hmacKey: '' } })
    r.fetch.on('/x/web-interface/nav', {
      code: -101,
      message: '账号未登录',
      data: { wbi_img: { img_url: IMG, sub_url: SUB } },
    })
    r.fetch.on('/x/space', { data: null })

    const res = await r.http.get('https://api.bilibili.com/x/space', { mid: 1 }, { wbi: true })
    assert.ok(res.ok)
    assert.equal(r.fetch.countOf('GenWebTicket'), 0)
    // nav 回 -101 不影响取 key：wbi_img 是公开的
    assert.equal(r.fetch.countOf('/x/web-interface/nav'), 1)
  })

  it('混淆表没配时直接 fatal，一个请求都不发', async () => {
    const r = rig({ wbiMixinTable: [] })
    r.fetch.on('GenWebTicket', ticketOk)

    const res = await r.http.get('https://api.bilibili.com/x/space', { mid: 1 }, { wbi: true })
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'fatal')
    assert.match(res.failure.message, /混淆表/)
    assert.equal(r.fetch.countOf('/x/space'), 0)
  })
})

describe('infra/bili HTTP 客户端：风控重试一次', () => {
  it('风控后清 key、重取 ticket、重试一次就成功', async () => {
    const r = rig()
    r.fetch.on('GenWebTicket', ticketOk)
    r.fetch.onSequence('/x/space', [
      { code: -352, message: '风控校验失败' },
      { data: { list: [1] } },
    ])

    const res = await r.http.get<{ list: number[] }>(
      'https://api.bilibili.com/x/space',
      { mid: 1 },
      { wbi: true },
    )
    assert.ok(res.ok)
    assert.deepEqual(res.value.list, [1])
    assert.equal(r.fetch.countOf('/x/space'), 2)
    // 第一次取 key + 风控后重取，正好两次
    assert.equal(r.fetch.countOf('GenWebTicket'), 2)
  })

  it('只重试一次；第二次还是风控就把风控失败交给调用方退避', async () => {
    const r = rig()
    r.fetch.on('GenWebTicket', ticketOk)
    r.fetch.on('/x/space', { code: -352, message: '风控校验失败' })

    const res = await r.http.get('https://api.bilibili.com/x/space', { mid: 1 }, { wbi: true })
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'risk-control')
    assert.equal(res.failure.retryAfterMs, 5 * 60_000)
    assert.equal(r.fetch.countOf('/x/space'), 2)
  })

  it('重取 ticket 失败时沿用原始风控失败 —— 结论不变，退避依据不丢', async () => {
    const r = rig({ ticket: { keyId: '', hmacKey: '' } })
    r.fetch.on('/x/web-interface/nav', { data: { wbi_img: { img_url: IMG, sub_url: SUB } } })
    r.fetch.on('/x/space', { code: -352, message: '风控校验失败' })

    const res = await r.http.get('https://api.bilibili.com/x/space', { mid: 1 }, { wbi: true })
    assert.ok(!res.ok)
    assert.equal(res.failure.kind, 'risk-control')
    assert.equal(r.fetch.countOf('/x/space'), 1)
  })

  it('鉴权失效不触发重试 —— 重试一万次也没用，该停下来等重登', async () => {
    const r = rig()
    r.fetch.on('/x/test', { code: -101, message: '账号未登录' })
    await r.http.get('https://api.bilibili.com/x/test')
    assert.equal(r.fetch.countOf('/x/test'), 1)
  })

  it('noRetry 的调用不会被自动重放（带副作用的请求必须如此）', async () => {
    const r = rig()
    r.fetch.on('/x/write', { code: -352, message: '风控校验失败' })
    const res = await r.http.postForm('https://api.bilibili.com/x/write', { a: '1' }, { noRetry: true })
    assert.ok(!res.ok)
    assert.equal(r.fetch.countOf('/x/write'), 1)
  })
})

describe('infra/bili HTTP 客户端：POST 表单', () => {
  it('body 是 urlencoded，头也对得上', async () => {
    const r = rig({}, { bili_jct: 'jct' })
    r.fetch.on('/x/relation/modify', { data: null })

    const res = await r.http.postForm('https://api.bilibili.com/x/relation/modify', {
      fid: '123',
      act: '1',
      csrf: 'jct',
    })
    assert.ok(res.ok)
    const req = r.fetch.requests[0]!
    assert.equal(req.method, 'POST')
    assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded')
    assert.equal(new URLSearchParams(req.body!).get('fid'), '123')
  })
})
