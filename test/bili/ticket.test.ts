import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  TICKET_URL,
  parseTicketResponse,
  ticketFormBody,
  ticketHexSign,
} from '../../src/server/infra/bili/ticket.ts'

const HMAC_KEY = 'test-hmac-key'

describe('infra/bili bili_ticket 签名', () => {
  it('是 HMAC-SHA256("ts" + ts) 的十六进制', () => {
    const expected = createHmac('sha256', HMAC_KEY).update('ts1700000000').digest('hex')
    assert.equal(ticketHexSign(HMAC_KEY, 1_700_000_000), expected)
    assert.match(ticketHexSign(HMAC_KEY, 1), /^[0-9a-f]{64}$/)
  })

  it('换 ts 换签名，换 key 也换签名', () => {
    const base = ticketHexSign(HMAC_KEY, 1)
    assert.notEqual(base, ticketHexSign(HMAC_KEY, 2))
    assert.notEqual(base, ticketHexSign('other', 1))
  })
})

describe('infra/bili bili_ticket 请求体', () => {
  it('带上 key_id / hexsign / context[ts] / csrf', () => {
    const body = new URLSearchParams(
      ticketFormBody({ keyId: 'ec02', hmacKey: HMAC_KEY }, 1_700_000_000, 'jct-value'),
    )
    assert.equal(body.get('key_id'), 'ec02')
    assert.equal(body.get('hexsign'), ticketHexSign(HMAC_KEY, 1_700_000_000))
    assert.equal(body.get('context[ts]'), '1700000000')
    assert.equal(body.get('csrf'), 'jct-value')
  })

  it('未登录时 csrf 传空串而不是漏掉这个字段', () => {
    const body = new URLSearchParams(ticketFormBody({ keyId: 'ec02', hmacKey: HMAC_KEY }, 1, ''))
    assert.equal(body.get('csrf'), '')
  })

  it('key 没配就抛 —— 否则会拿一个必然失败的签名去换 ticket', () => {
    assert.throws(() => ticketFormBody({ keyId: '', hmacKey: HMAC_KEY }, 1, ''), /未配置/)
    assert.throws(() => ticketFormBody({ keyId: 'ec02', hmacKey: '' }, 1, ''), /未配置/)
  })

  it('打的是 ticket 服务的地址', () => {
    assert.match(TICKET_URL, /^https:\/\/api\.bilibili\.com\/bapis\/.*GenWebTicket$/)
  })
})

describe('infra/bili bili_ticket 响应解析', () => {
  const nav = {
    img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png' },
    sub: { sub_url: 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png' },
  }

  it('顺手带出 nav 里的 WBI key —— 一次请求省掉一次 nav', () => {
    const out = parseTicketResponse({ ticket: 'tk', created_at: 100, ttl: 259200, nav }, 100_000)
    assert.ok(out.ok)
    assert.equal(out.value.ticket, 'tk')
    assert.equal(out.value.expiresAt, 100_000 + 259_200_000)
    assert.equal(out.value.keys?.imgKey, 'aaaaaaaabbbbbbbbccccccccdddddddd')
    assert.equal(out.value.keys?.subKey, '11111111222222223333333344444444')
    assert.equal(out.value.keys?.fetchedAt, 100_000)
  })

  it('nav 缺失时 keys 为 null，但 ticket 照样可用', () => {
    const out = parseTicketResponse({ ticket: 'tk', ttl: 60 }, 0)
    assert.ok(out.ok)
    assert.equal(out.value.keys, null)
    assert.equal(out.value.expiresAt, 60_000)
  })

  it('形状不对时给 fatal，不是抛异常', () => {
    const out = parseTicketResponse({ nope: 1 }, 0)
    assert.ok(!out.ok)
    assert.equal(out.failure.kind, 'fatal')
  })
})
