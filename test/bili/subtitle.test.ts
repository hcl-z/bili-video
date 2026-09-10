/** 和 http-client 那份测试同一个理由：假的只有 fetch，三跳链路、WBI 签名、字幕挑选跑的都是实际代码 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createBrowserIdentity } from '../../src/server/infra/bili/browser-identity.ts'
import { BiliHttp } from '../../src/server/infra/bili/http-client.ts'
import { BiliSubtitleClient } from '../../src/server/infra/bili/subtitle.ts'
import { FakeFetch } from '../fakes/bili-fetch.ts'
import { MemoryCookieJar } from '../fakes/cookie-jar.ts'
import { CollectingLogger } from '../fakes/logger.ts'

const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

function rig(): { client: BiliSubtitleClient; fetch: FakeFetch } {
  const fetch = new FakeFetch()
  const http = new BiliHttp({
    fetch: fetch.fetch,
    identity: createBrowserIdentity(() => 0.5),
    cookies: new MemoryCookieJar({ SESSDATA: 'sess' }),
    clock: { now: () => 1_700_000_000_000, sleep: async () => {}, schedule: () => () => {}, checkCron: () => null },
    logger: new CollectingLogger(),
    config: () => ({
      wbiMixinTable: Array.from({ length: 64 }, (_, i) => i),
      ticket: { keyId: 'ec02', hmacKey: 'hmac' },
    }),
  })
  fetch.on('/x/web-interface/nav', { data: { wbi_img: { img_url: IMG, sub_url: SUB } } })
  return { client: new BiliSubtitleClient(http, new CollectingLogger()), fetch }
}

describe('infra/bili 字幕', () => {
  it('view → player/v2 → 字幕 JSON，优先中文人工字幕', async () => {
    const r = rig()
    r.fetch.on('/x/web-interface/view', { data: { cid: 555, pages: [{ cid: 555 }] } })
    r.fetch.on('/x/player/wbi/v2', {
      data: {
        subtitle: {
          subtitles: [
            { lan: 'en', lan_doc: 'English', ai_type: 0, subtitle_url: '//x/en.json' },
            { lan: 'zh-CN', lan_doc: '中文（AI）', ai_type: 1, subtitle_url: '//x/ai.json' },
            { lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//x/zh.json' },
          ],
        },
      },
    })
    r.fetch.on('/x/zh.json', {
      raw: { body: [{ from: 1.2, to: 3, content: '开场' }, { from: 3, to: 5, content: '  ' }] },
    })

    const res = await r.client.fetch('BV1xx')
    assert.equal(res.ok, true)
    assert.deepEqual(res.ok && res.value, [{ from: 1.2, to: 3, text: '开场' }])
    // cid 必须来自 view，不能瞎猜；签名参数得真签上
    const player = r.fetch.requests.find((q) => q.url.includes('player/wbi/v2'))
    assert.equal(player?.query.get('cid'), '555')
    assert.ok(player?.query.get('w_rid'))
  })

  it('没有字幕轨时回 null，不当成失败', async () => {
    const r = rig()
    r.fetch.on('/x/web-interface/view', { data: { cid: 1, pages: [] } })
    r.fetch.on('/x/player/wbi/v2', { data: { subtitle: { subtitles: [] } } })

    const res = await r.client.fetch('BV1yy')
    assert.equal(res.ok, true)
    assert.equal(res.ok && res.value, null)
  })
})
