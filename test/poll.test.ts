import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PollResult, UpdatesResponse } from '#shared/contract/api.ts'
import { FakeFetch, type FakeResponse } from './fakes/bili-fetch.ts'
import { createHarness, type Harness } from './support/harness.ts'

/**
 * 轮询、五类解析、锚点。走主测试缝，只有 fetch 是假的 —— 于是解析、过滤、
 * 入库、锚点推进全都是真在跑。
 */

/**
 * 假件照着真 payload 的怪癖写：用不上的 major 分支是**显式 null**（不是缺字段），
 * `pub_ts` 是**字符串**，图文的正文在 `major.opus.summary` 里而 `desc` 是 null。
 * 这三点当初都写错过，结果是真环境下一条都解析不出来。
 */
const NULL_MAJOR = { archive: null, draw: null, article: null, opus: null, live_rcmd: null }

function major(type: string, text: string): unknown {
  switch (type) {
    case 'DYNAMIC_TYPE_AV':
      return {
        ...NULL_MAJOR,
        type: 'MAJOR_TYPE_ARCHIVE',
        archive: { bvid: 'BV1x', title: '视频标题', desc: '视频简介', cover: 'https://c/av.jpg' },
      }
    case 'DYNAMIC_TYPE_DRAW':
      return {
        ...NULL_MAJOR,
        type: 'MAJOR_TYPE_OPUS',
        opus: { title: '', summary: { text }, pics: [{ url: 'https://c/draw.jpg' }] },
      }
    case 'DYNAMIC_TYPE_ARTICLE':
      return {
        ...NULL_MAJOR,
        type: 'MAJOR_TYPE_ARTICLE',
        article: { title: '专栏标题', desc: '专栏摘要', covers: ['https://c/art.jpg'] },
      }
    default:
      return null
  }
}

function dyn(id: string, uid: string, type: string, pubTs: number, text = `正文-${id}`): unknown {
  // 图文的正文不在 desc 里，真接口就是这样。
  const desc = type === 'DYNAMIC_TYPE_DRAW' || type === 'DYNAMIC_TYPE_ARTICLE' ? null : { text }
  return {
    id_str: id,
    type,
    modules: {
      module_author: {
        mid: Number(uid),
        name: `UP-${uid}`,
        face: `https://f/${uid}.jpg`,
        pub_ts: String(pubTs),
      },
      module_dynamic: { desc, major: major(type, text) },
    },
  }
}

const feed = (items: unknown[], baseline = 'b1'): FakeResponse => ({
  data: { items, has_more: false, offset: '', update_baseline: baseline },
})

/**
 * 心跳恒说「有新的」+ 固定的一页聚合流。
 *
 * 心跳故意不回 0：回 0 会让第二轮在心跳那步就短路，那就测不到「重复的条目
 * 到底会不会再入库一次」—— 而那才是判据要的东西。
 */
const bili = (page: FakeResponse): FakeFetch =>
  new FakeFetch().on('feed/all/update', { data: { update_num: 3 } }).on('feed/all', page)

/** 登录着的 harness：poller 每轮开头就查登录态，没 cookie 会整轮跳过。 */
async function rig(fetch: FakeFetch, subs: string[]): Promise<Harness> {
  const h = await createHarness({
    fetch,
    cookies: ['SESSDATA=fake; Path=/; Domain=.bilibili.com'],
  })
  for (const uid of subs) {
    h.core.repos.subscriptions.upsert({
      uid,
      name: `UP-${uid}`,
      face: null,
      enableDynamic: true,
      enableVideo: true,
      enableAi: true,
    })
  }
  return h
}

describe('轮询与解析', () => {
  it('五类都解析入库、非订阅 uid 挡掉、锚点推到最新、第二轮不产新条目', async () => {
    const items = [
      dyn('901', '111', 'DYNAMIC_TYPE_AV', 1_700_000_100),
      dyn('902', '111', 'DYNAMIC_TYPE_DRAW', 1_700_000_200),
      dyn('903', '111', 'DYNAMIC_TYPE_WORD', 1_700_000_300),
      dyn('904', '222', 'DYNAMIC_TYPE_FORWARD', 1_700_000_400),
      dyn('905', '222', 'DYNAMIC_TYPE_ARTICLE', 1_700_000_500),
      // 没订阅的人，一条都不该入库。
      dyn('906', '999', 'DYNAMIC_TYPE_AV', 1_700_000_600),
      // 认不出的类型（直播推送之类）跳过，不该让整页作废。
      dyn('907', '111', 'DYNAMIC_TYPE_LIVE_RCMD', 1_700_000_700),
    ]
    const fetch = bili(feed(items))
    const h = await rig(fetch, ['111', '222'])

    const first = await h.server.services.poll.pollOnce()
    assert.equal(first.ok, true)
    assert.equal(first.found, 5)

    const stored = h.core.repos.updates.list({ limit: 50, includeFiltered: true })
    assert.equal(stored.length, 5)
    assert.deepEqual(
      stored.map((u) => u.type).sort(),
      ['AV', 'ARTICLE', 'DRAW', 'FORWARD', 'WORD'].sort(),
    )
    const av = stored.find((u) => u.dynId === '901')
    assert.equal(av?.title, '视频标题')
    assert.equal(av?.bvid, 'BV1x')
    assert.equal(av?.cover, 'https://c/av.jpg')
    assert.equal(av?.url, 'https://www.bilibili.com/video/BV1x')
    assert.equal(stored.find((u) => u.dynId === '903')?.text, '正文-903')
    // 图文：正文取自 opus.summary，封面取自 opus.pics。
    const draw = stored.find((u) => u.dynId === '902')
    assert.equal(draw?.text, '正文-902')
    assert.equal(draw?.cover, 'https://c/draw.jpg')

    // 锚点推到各自的最新一条，且只推到自己的。
    assert.equal(h.core.repos.anchors.get('111'), 1_700_000_300)
    assert.equal(h.core.repos.anchors.get('222'), 1_700_000_500)
    assert.equal(h.core.repos.anchors.get('999'), null)

    // 第二轮：同一份响应，一条新的都不该有。
    const second = await h.server.services.poll.pollOnce()
    assert.equal(second.found, 0)
    // 确实又拉了一次全量（不是在心跳那步短路掉的），所以「不重复」是锚点和 dyn_id 挡住的。
    assert.equal(fetch.countOf('feed/all?'), 2)
    assert.equal(h.core.repos.updates.list({ limit: 50, includeFiltered: true }).length, 5)

    await h.close()
  })

  it('重启后不重复处理已处理过的条目', async () => {
    const fetch = bili(feed([dyn('901', '111', 'DYNAMIC_TYPE_WORD', 1_700_000_100)]))
    const h = await rig(fetch, ['111'])
    assert.equal((await h.server.services.poll.pollOnce()).found, 1)

    const h2 = await h.restart()
    const events: string[] = []
    h2.events.on((e) => events.push(e.type))
    assert.equal((await h2.server.services.poll.pollOnce()).found, 0)
    // 没有新条目就没有 update.new，也就不会重复推送。
    assert.equal(events.filter((t) => t === 'update.new').length, 0)
    await h2.close()
  })

  it('有条目解析不出来时不推进心跳游标', async () => {
    const broken = { id_str: '910', type: 'DYNAMIC_TYPE_WORD', modules: { module_author: {}, module_dynamic: {} } }
    const fetch = bili(feed([dyn('901', '111', 'DYNAMIC_TYPE_WORD', 1_700_000_100), broken]))
    const h = await rig(fetch, ['111'])

    assert.equal((await h.server.services.poll.pollOnce()).found, 1)
    // 存了 baseline 的话，下一轮心跳就回 0，那条没解析出来的动态永远拉不回来。
    assert.equal(h.core.state.get('feed-baseline'), null)

    await h.close()
  })

  it('上一轮没跑完时这次直接跳过', async () => {
    const fetch = bili(feed([dyn('901', '111', 'DYNAMIC_TYPE_WORD', 1_700_000_100)]))
    const h = await rig(fetch, ['111'])
    const poll = h.server.services.poll

    const running = poll.pollOnce()
    const skipped = await poll.pollOnce()
    assert.match(skipped.reason ?? '', /上一轮还没跑完/)
    await running
    // 跳过意味着一个请求都没多发。
    assert.equal(fetch.countOf('feed/all'), 1)
    await h.close()
  })

  it('命中风控就退避，鉴权失效就停止轮询', async () => {
    const fetch = new FakeFetch().onSequence('feed/all', [
      { code: -352, message: '风控校验失败' },
      { code: -101, message: '账号未登录' },
    ])
    const h = await rig(fetch, ['111'])
    const poll = h.server.services.poll
    poll.start()

    const risky = await poll.pollOnce()
    assert.equal(risky.ok, false)
    assert.equal(poll.snapshot().status, 'backoff')
    assert.notEqual(poll.snapshot().resumeAt, null)

    // 退避窗口内的 tick 不发请求。
    const before = fetch.countOf('feed/all')
    await h.clock.tick()
    assert.equal(fetch.countOf('feed/all'), before)

    // 退避过了再跑，这次是鉴权失效：cron 被摘掉，状态转 auth-lost。
    h.clock.advance(6 * 60_000)
    await poll.pollOnce()
    assert.equal(poll.snapshot().status, 'auth-lost')
    assert.equal(h.clock.scheduled.length, 0)
    assert.match((await poll.pollOnce()).reason ?? '', /登录已失效/)

    await h.close()
  })
})

describe('过滤规则', () => {
  it('黑名单命中的条目照样入库，但标成被过滤并带上原因', async () => {
    const fetch = bili(
      feed([
        dyn('901', '111', 'DYNAMIC_TYPE_WORD', 1_700_000_100, '今天这条是恰饭'),
        dyn('902', '111', 'DYNAMIC_TYPE_WORD', 1_700_000_200, '正常内容'),
      ]),
    )
    const h = await rig(fetch, ['111'])
    h.core.repos.rules.add({ scope: 'global', kind: 'keyword-deny', pattern: '恰饭', enabled: true })

    const r = await h.server.services.poll.pollOnce()
    assert.equal(r.found, 2)
    assert.equal(r.blocked, 1)

    const res = await h.server.app.request('/api/updates')
    const body = (await res.json()) as UpdatesResponse
    const blocked = body.updates.find((u) => u.dynId === '901')
    assert.equal(blocked?.filtered, true)
    assert.match(blocked?.filterReason ?? '', /全局关键词黑名单「恰饭」/)
    assert.equal(body.updates.find((u) => u.dynId === '902')?.filtered, false)
    assert.equal(body.ups['111']?.name, 'UP-111')

    // 默认不列被过滤的那条
    const clean = (await (await h.server.app.request('/api/updates?filtered=0')).json()) as UpdatesResponse
    assert.deepEqual(clean.updates.map((u) => u.dynId), ['902'])

    await h.close()
  })

  it('样本测试框回「命中了哪些 + 最终判定」，坏正则加不进去', async () => {
    const h = await rig(new FakeFetch(), ['111'])

    const bad = await h.server.app.request('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', kind: 'regex-deny', pattern: '(' }),
    })
    assert.equal(bad.status, 400)

    await h.server.app.request('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', kind: 'keyword-deny', pattern: '恰饭' }),
    })
    const res = await h.server.app.request('/api/rules/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sample: '这条是恰饭视频' }),
    })
    const body = (await res.json()) as {
      hits: { label: string }[]
      verdict: { kind: string }
      used: unknown[]
    }
    assert.equal(body.verdict.kind, 'blocked')
    assert.deepEqual(body.hits.map((h2) => h2.label), ['全局关键词黑名单「恰饭」'])
    assert.equal(body.used.length, 1)

    await h.close()
  })

  it('手动催一轮：页面上不用等两分钟', async () => {
    const fetch = bili(feed([dyn('901', '111', 'DYNAMIC_TYPE_WORD', 1_700_000_100)]))
    const h = await rig(fetch, ['111'])
    const res = await h.server.app.request('/api/updates/poll', { method: 'POST' })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as PollResult).found, 1)
    await h.close()
  })
})
