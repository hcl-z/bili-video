import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseUid } from '../src/server/domain/subscription.ts'
import { FakeFetch } from './fakes/bili-fetch.ts'
import { createHarness, type Harness } from './support/harness.ts'

/**
 * 订阅与自动关注。走主测试缝（真 SQLite、真限流、真审计），只有 fetch 是假的。
 *
 * 重点只有一条：**先批量查关系，只对没关注的发写请求**。写接口是全系统唯一的
 * 风控高危面，多发一次就是白冒一次风险。
 */

/** 订阅默认形状，直接往库里塞订阅时用。 */
const row = (uid: string, name: string) => ({
  uid,
  name,
  face: null,
  enableAi: true,
})

function bili(followed: string[] = []): FakeFetch {
  return new FakeFetch()
    .on('search/type', (req) => {
      const keyword = req.query.get('keyword') ?? ''
      return {
        data: {
          result: [
            {
              mid: 123,
              uname: keyword,
              upic: 'https://i0.hdslb.com/123.jpg',
              usign: '签名',
              fans: 456,
            },
            {
              mid: 456,
              uname: `${keyword}同名`,
              upic: '',
              usign: '',
              fans: 12,
            },
          ],
        },
      }
    })
    .on('web-interface/card', (req) => {
      const mid = req.query.get('mid') ?? ''
      if (mid === '404404') return { code: -404, message: '啥都木有' }
      return { data: { card: { mid, name: `UP-${mid}`, face: `https://i0.hdslb.com/${mid}.jpg` } } }
    })
    .on('relation/relations', (req) => {
      const fids = (req.query.get('fids') ?? '').split(',')
      const data: Record<string, { attribute: number }> = {}
      // 没关注的人 B 站干脆不给条目，假件也照这个形状来。
      for (const fid of fids) if (followed.includes(fid)) data[fid] = { attribute: 2 }
      return { data }
    })
    .on('relation/modify', { code: 0 })
}

/** 带上 bili_jct 的 harness：没有 csrf 的话写请求根本发不出去。 */
async function rig(followed: string[] = []): Promise<Harness> {
  const h = await createHarness({ fetch: bili(followed) })
  h.core.cookies.setFromResponse(
    ['SESSDATA=fake; Path=/; Domain=.bilibili.com', 'bili_jct=csrf-1; Path=/; Domain=.bilibili.com'],
    h.clock.now(),
  )
  return h
}

describe('domain/subscription uid 识别', () => {
  it('认得 uid、UID:、空间页链接与一整段分享文本', () => {
    assert.equal(parseUid('123456'), '123456')
    assert.equal(parseUid('UID:123456'), '123456')
    assert.equal(parseUid('https://space.bilibili.com/123456/dynamic'), '123456')
    assert.equal(parseUid('【某某的个人空间】https://m.bilibili.com/space/123456 快来'), '123456')
    // 认不出来就是 null，绝不猜 —— 猜错会去关注一个陌生人。
    assert.equal(parseUid('小明'), null)
    assert.equal(parseUid('https://www.bilibili.com/video/BV1xx411c7mD'), null)
  })
})

describe('订阅与自动关注', () => {
  it('按名称只返回带 UID 的候选，不直接创建订阅', async () => {
    const h = await rig()
    const res = await h.server.app.request('/api/subscriptions/search?q=%E5%B0%8F%E6%98%8E')

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      items: [
        {
          uid: '123',
          name: '小明',
          face: 'https://i0.hdslb.com/123.jpg',
          signature: '签名',
          fans: 456,
        },
        { uid: '456', name: '小明同名', face: null, signature: '', fans: 12 },
      ],
    })
    assert.equal(h.core.repos.subscriptions.list().length, 0)
    assert.equal(h.fetch.countOf('web-interface/card'), 0)
    assert.equal(h.fetch.countOf('relation/modify'), 0)

    const searchRequest = h.fetch.requests.find((request) => request.url.includes('search/type'))
    assert.equal(searchRequest?.query.get('search_type'), 'bili_user')
    assert.equal(searchRequest?.query.get('keyword'), '小明')
    await h.close()
  })

  it('名称即使含数字也走名称搜索，不会被当成 UID', async () => {
    const h = await rig()
    const res = await h.server.app.request('/api/subscriptions/search?q=UP123')

    assert.equal(res.status, 200)
    assert.equal(h.fetch.countOf('search/type'), 1)
    assert.equal(h.fetch.countOf('web-interface/card'), 0)
    assert.equal(h.core.repos.subscriptions.list().length, 0)
    await h.close()
  })

  it('UID 查到时只返回唯一候选，不再按名称搜索', async () => {
    const h = await rig()
    const res = await h.server.app.request('/api/subscriptions/search?q=123')

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      items: [
        {
          uid: '123',
          name: 'UP-123',
          face: 'https://i0.hdslb.com/123.jpg',
          signature: '',
          fans: 0,
        },
      ],
    })
    assert.equal(h.fetch.countOf('web-interface/card'), 1)
    assert.equal(h.fetch.countOf('search/type'), 0)
    await h.close()
  })

  it('纯数字 UID 查不到时把原输入当名称搜索', async () => {
    const h = await rig()
    const res = await h.server.app.request('/api/subscriptions/search?q=404404')

    assert.equal(res.status, 200)
    const body = (await res.json()) as { items: { name: string }[] }
    assert.equal(body.items[0]?.name, '404404')
    assert.equal(h.fetch.countOf('web-interface/card'), 1)
    assert.equal(h.fetch.countOf('search/type'), 1)
    await h.close()
  })

  it('空间链接查不到时直接报错，不把整条链接当名称搜索', async () => {
    const h = await rig()
    const res = await h.server.app.request(
      '/api/subscriptions/search?q=https%3A%2F%2Fspace.bilibili.com%2F404404',
    )

    assert.equal(res.status, 400)
    assert.equal(h.fetch.countOf('web-interface/card'), 1)
    assert.equal(h.fetch.countOf('search/type'), 0)
    await h.close()
  })

  it('粘一个空间链接就完成订阅，并自动关注', async () => {
    const h = await rig()
    const res = await h.server.app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'https://space.bilibili.com/8888' }),
    })
    assert.equal(res.status, 201)

    const body = (await res.json()) as { sub: { uid: string; name: string; followedAt: number | null }; notice: string | null }
    assert.equal(body.sub.uid, '8888')
    assert.equal(body.sub.name, 'UP-8888')
    assert.notEqual(body.sub.followedAt, null)
    assert.equal(body.notice, null)

    assert.equal(h.fetch.countOf('relation/modify'), 1)
    // 写接口每一次调用都留痕，且只有写接口进这张表。
    const audit = h.core.repos.writeAudit.recent(10)
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.api, 'relation/modify')
    assert.equal(audit[0]!.target, '8888')
    assert.equal(audit[0]!.ok, true)

    await h.close()
  })

  it('已关注 A、未关注 B 时只对 B 发一次关注请求', async () => {
    const h = await rig(['11'])
    h.core.repos.subscriptions.upsert(row('11', 'A'))
    h.core.repos.subscriptions.upsert(row('22', 'B'))

    const r = await h.server.services.subs.ensureFollowed(['11', '22'])

    assert.deepEqual(r.followed, ['22'])
    assert.equal(r.notice, null)
    // 一个批量查询，一个写请求。
    assert.equal(h.fetch.countOf('relation/relations'), 1)
    assert.equal(h.fetch.countOf('relation/modify'), 1)
    const write = h.fetch.requests.find((q) => q.url.includes('relation/modify'))
    assert.match(write!.body!, /fid=22/)
    // A 也算已关注：库里要记上，否则每次启动都会再查一遍。
    assert.notEqual(h.core.repos.subscriptions.get('11')!.followedAt, null)
    assert.equal(h.core.repos.writeAudit.countSince(0), 1)

    await h.close()
  })

  it('AI、推送类别来源和 Prompt 改完就落库', async () => {
    const h = await rig()
    h.core.repos.subscriptions.upsert(row('33', 'C'))
    const pushKinds = {
      video: false,
      draw: true,
      word: true,
      forward: false,
      article: true,
      live: true,
      lottery: false,
      charge: true,
    }

    const res = await h.server.app.request('/api/subscriptions/33', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enableAi: false, pushKindMode: 'custom', pushKinds }),
    })
    assert.equal(res.status, 200)

    const stored = h.core.repos.subscriptions.get('33')!
    assert.equal(stored.enableAi, false)
    assert.equal(stored.pushKindMode, 'custom')
    assert.deepEqual(stored.pushKinds, pushKinds)

    await h.close()
  })

  it('UP 的规则模式和 Prompt 可独立保存并恢复继承', async () => {
    const h = await rig()
    h.core.repos.subscriptions.upsert(row('34', 'D'))
    const promptTemplate = '只写重点：{{text}}'

    const custom = await h.server.app.request('/api/subscriptions/34', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filterMode: 'custom', promptTemplate }),
    })
    assert.equal(custom.status, 200)
    assert.equal(h.core.repos.subscriptions.get('34')?.filterMode, 'custom')
    assert.equal(h.core.repos.subscriptions.get('34')?.promptTemplate, promptTemplate)

    const inherit = await h.server.app.request('/api/subscriptions/34', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filterMode: 'inherit', promptTemplate: null }),
    })
    assert.equal(inherit.status, 200)
    assert.equal(h.core.repos.subscriptions.get('34')?.filterMode, 'inherit')
    assert.equal(h.core.repos.subscriptions.get('34')?.promptTemplate, null)

    await h.close()
  })

  it('删除订阅不碰 B 站的关注（不发写请求）', async () => {
    const h = await rig()
    h.core.repos.subscriptions.upsert(row('44', 'D'))

    const res = await h.server.app.request('/api/subscriptions/44', { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()) as { subs: unknown[] }, { subs: [] })
    assert.equal(h.fetch.requests.length, 0)

    await h.close()
  })

  it('认不出 uid 时回 400，不落库也不发请求', async () => {
    const h = await rig()
    const res = await h.server.app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '这是谁' }),
    })
    assert.equal(res.status, 400)
    assert.equal(h.core.repos.subscriptions.list().length, 0)
    assert.equal(h.fetch.requests.length, 0)

    await h.close()
  })

  it('写接口的小时限额用满后不再发写请求，而是让人稍后重试', async () => {
    const h = await rig()
    const bili = h.core.config.getSection('bili')
    h.core.config.setSection('bili', {
      ...bili,
      write: { autoFollow: true, minIntervalMs: 0, maxPerHour: 1 },
    })
    h.core.repos.subscriptions.upsert(row('55', 'E'))
    h.core.repos.subscriptions.upsert(row('66', 'F'))

    const r = await h.server.services.subs.ensureFollowed(['55', '66'])

    assert.deepEqual(r.followed, ['55'])
    assert.match(r.notice!, /限额/)
    // 额度用满就不发第二个写请求 —— 限流是在发出去之前拦住的。
    assert.equal(h.fetch.countOf('relation/modify'), 1)

    await h.close()
  })

  it('并发关注不会各自绕过限额', async () => {
    const h = await rig()
    const bili = h.core.config.getSection('bili')
    h.core.config.setSection('bili', {
      ...bili,
      write: { autoFollow: true, minIntervalMs: 0, maxPerHour: 1 },
    })

    // 限流读的是审计表，而审计行要等请求回来才落。不串行的话这两个调用会
    // 各自读到「额度没用过」然后一起发出去 —— 启动期补关注撞上页面新增就是这样。
    const [a, b] = await Promise.all([
      h.core.biliRelations.follow('77'),
      h.core.biliRelations.follow('88'),
    ])

    assert.equal([a, b].filter((r) => r.ok).length, 1)
    assert.equal(h.fetch.countOf('relation/modify'), 1)

    await h.close()
  })

  it('关掉 autoFollow 后一个请求都不发，订阅照样加上', async () => {
    const h = await rig()
    const bili = h.core.config.getSection('bili')
    h.core.config.setSection('bili', { ...bili, write: { ...bili.write, autoFollow: false } })

    const res = await h.server.app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '99' }),
    })

    assert.equal(res.status, 201)
    const body = (await res.json()) as { sub: { uid: string; followedAt: number | null }; notice: string | null }
    assert.equal(body.sub.uid, '99')
    assert.equal(body.sub.followedAt, null)
    assert.match(body.notice!, /自动关注已关闭/)
    // 连查关系那个读请求都省了；名片是另一回事，那不是写接口。
    assert.equal(h.fetch.countOf('relation/relations'), 0)
    assert.equal(h.fetch.countOf('relation/modify'), 0)

    await h.close()
  })
})
