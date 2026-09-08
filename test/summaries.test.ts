import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  SummariesResponse,
  SummaryDetailResponse,
  TranscriptResponse,
} from '#shared/contract/api.ts'
import { FakeFetch, type FakeResponse } from './fakes/bili-fetch.ts'
import { createHarness } from './support/harness.ts'

/** 分栏阅读的数据面：索引每行的状态，以及阅读栏一次要齐的那一坨。 */

const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

const av = (id: string, bvid: string, title: string) => ({
  id_str: id,
  type: 'DYNAMIC_TYPE_AV',
  modules: {
    module_author: { mid: 111, name: 'UP-111', face: 'https://f/111.jpg', pub_ts: `17000001${id}` },
    module_dynamic: {
      desc: null,
      major: {
        type: 'MAJOR_TYPE_ARCHIVE',
        archive: { bvid, title, desc: '简介', cover: 'https://c/av.jpg' },
        draw: null,
        article: null,
        opus: null,
        live_rcmd: null,
      },
    },
  },
})

const REPLY = JSON.stringify({
  tldr: '一句话讲完',
  points: ['要点一', '要点二'],
  chapters: [{ startSec: 83, title: '正题', desc: null }],
})

const llmOk: FakeResponse = {
  raw: {
    choices: [{ message: { content: REPLY } }],
    usage: { prompt_tokens: 120, completion_tokens: 40 },
  },
}

describe('总结分栏阅读', () => {
  it('索引区分「已总结」与「被拦下」，阅读栏一次给齐文章、byline 与用量', async () => {
    const fetch = new FakeFetch()
      .on('feed/all/update', { data: { update_num: 2 } })
      .on('feed/all', {
        data: {
          items: [av('01', 'BV1ok', '正常视频'), av('02', 'BV1no', '带广告的视频')],
          has_more: false,
          offset: '',
          update_baseline: 'b1',
        },
      })
      .on('web-interface/nav', { data: { wbi_img: { img_url: IMG, sub_url: SUB } } })
      .on('web-interface/view', { data: { cid: 555, pages: [{ cid: 555 }] } })
      .on('player/wbi/v2', {
        data: {
          subtitle: {
            subtitles: [
              { lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//sub.test/zh.json' },
            ],
          },
        },
      })
      .on('sub.test/zh.json', { raw: { body: [{ from: 83, to: 86, content: '进入正题' }] } })
      .on('/chat/completions', llmOk)

    const h = await createHarness({
      fetch,
      cookies: ['SESSDATA=fake; Path=/; Domain=.bilibili.com'],
    })
    h.core.repos.subscriptions.upsert({
      uid: '111',
      name: 'UP-111',
      face: 'https://f/111.jpg',
      enableDynamic: true,
      enableVideo: true,
      enableAi: true,
    })
    h.core.repos.rules.add({ scope: 'global', kind: 'keyword-deny', pattern: '广告', enabled: true })
    h.core.config.setSection('bili', {
      ...h.core.config.getSection('bili'),
      wbiMixinTable: Array.from({ length: 64 }, (_, i) => i),
    })
    h.core.config.setSection('ai', {
      ...h.core.config.getSection('ai'),
      enabled: true,
      baseURL: 'https://llm.test/v1',
      model: 'm1',
    })
    h.server.services.queue.start()

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()

    const list = (await (await h.server.app.request('/api/summaries')).json()) as SummariesResponse
    assert.equal(list.filteredCount, 1)
    assert.equal(list.ups['111']?.name, 'UP-111')
    const ok = list.items.find((i) => i.bvid === 'BV1ok')
    const blocked = list.items.find((i) => i.bvid === 'BV1no')
    assert.equal(ok?.state, 'done')
    assert.equal(ok?.degradePath, 'subtitle')
    assert.equal(blocked?.state, 'filtered')
    assert.match(blocked?.filterReason ?? '', /广告/)

    const detail = (await (
      await h.server.app.request('/api/summaries/BV1ok')
    ).json()) as SummaryDetailResponse
    assert.equal(detail.state, 'done')
    assert.equal(detail.summary?.tldr, '一句话讲完')
    assert.equal(detail.summary?.chapters[0]?.startSec, 83)
    assert.equal(detail.up?.name, 'UP-111')
    assert.equal(detail.update?.title, '正常视频')
    assert.equal(detail.job?.status, 'done')
    assert.equal(detail.usage.inTokens, 120)
    assert.equal(detail.usage.calls, 1)
    // 还没推过：推送那两票没做，页面据此显示「未推送」而不是空白。
    assert.deepEqual(detail.deliveries, [])

    // 库里没有的 bvid 也是 200：阅读栏要显示「还没总结」，不是报错。
    const unknown = (await (
      await h.server.app.request('/api/summaries/BV1none')
    ).json()) as SummaryDetailResponse
    assert.equal(unknown.state, 'none')
    assert.equal(unknown.summary, null)
    assert.equal(unknown.update, null)
    assert.equal(unknown.usage.calls, 0)

    // 不像 id 的路径段直接 400，别拿它去查库。
    const bad = await h.server.app.request('/api/summaries/..%2F..%2Fetc')
    assert.equal(bad.status, 400)

    await h.close()
  })

  it('没进过队列的视频能手动排一条；被拦下的和库里没有的都排不上', async () => {
    const fetch = new FakeFetch()
      .on('feed/all/update', { data: { update_num: 1 } })
      .on('feed/all', {
        data: {
          items: [av('01', 'BV1ok', '正常视频')],
          has_more: false,
          offset: '',
          update_baseline: 'b1',
        },
      })
      .on('web-interface/nav', { data: { wbi_img: { img_url: IMG, sub_url: SUB } } })
      .on('web-interface/view', { data: { cid: 555, pages: [{ cid: 555 }] } })
      .on('player/wbi/v2', {
        data: {
          subtitle: {
            subtitles: [
              { lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//sub.test/zh.json' },
            ],
          },
        },
      })
      .on('sub.test/zh.json', { raw: { body: [{ from: 83, to: 86, content: '进入正题' }] } })
      .on('/chat/completions', llmOk)

    const h = await createHarness({
      fetch,
      cookies: ['SESSDATA=fake; Path=/; Domain=.bilibili.com'],
    })
    // enableAi 关着抓一轮：这就是「一堆未总结」的来路。
    h.core.repos.subscriptions.upsert({
      uid: '111',
      name: 'UP-111',
      face: null,
      enableDynamic: true,
      enableVideo: true,
      enableAi: false,
    })
    h.core.config.setSection('bili', {
      ...h.core.config.getSection('bili'),
      wbiMixinTable: Array.from({ length: 64 }, (_, i) => i),
    })
    h.core.config.setSection('ai', {
      ...h.core.config.getSection('ai'),
      enabled: true,
      baseURL: 'https://llm.test/v1',
      model: 'm1',
    })
    h.server.services.queue.start()
    await h.server.services.poll.pollOnce()
    assert.equal(h.core.repos.jobs.getByBvid('BV1ok'), null)

    const run = await h.server.app.request('/api/summaries/BV1ok/run', { method: 'POST' })
    assert.equal(run.status, 200)
    await h.server.services.queue.drain()
    assert.equal(h.core.repos.jobs.getByBvid('BV1ok')?.status, 'done')
    assert.equal(h.core.repos.summaries.get('BV1ok')?.tldr, '一句话讲完')

    const missing = await h.server.app.request('/api/summaries/BV1none/run', { method: 'POST' })
    assert.equal(missing.status, 404)

    // 都总结过了，批量补队就没得补。
    const all = await h.server.app.request('/api/summaries/run-all', { method: 'POST' })
    assert.deepEqual(await all.json(), { queued: 0, skipped: 1 })

    // 完整字幕单独一个端点，带时间戳，原样存着。
    const tr = (await (
      await h.server.app.request('/api/summaries/BV1ok/transcript')
    ).json()) as TranscriptResponse
    assert.equal(tr.source, 'subtitle')
    assert.match(tr.text, /^\[01:23\] 进入正题$/)
    assert.equal((await h.server.app.request('/api/summaries/BV1none/transcript')).status, 404)

    await h.close()
  })
})
