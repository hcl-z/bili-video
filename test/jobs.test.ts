import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { AppEvent } from '#shared/contract/events.ts'
import type { JobsResponse } from '#shared/contract/api.ts'
import { FakeFetch, type FakeResponse } from './fakes/bili-fetch.ts'
import { createHarness, type Harness } from './support/harness.ts'

/**
 * 总结队列端到端：抓到视频 → 入队 → 取字幕 → 调 LLM → 落库落盘。
 * 假的只有 fetch，队列、并发、仓储、Markdown 渲染与落盘都是真在跑。
 */

const IMG = 'https://i0.hdslb.com/bfs/wbi/aaaaaaaabbbbbbbbccccccccdddddddd.png'
const SUB = 'https://i0.hdslb.com/bfs/wbi/11111111222222223333333344444444.png'

const AV_ITEM = {
  id_str: '901',
  type: 'DYNAMIC_TYPE_AV',
  modules: {
    module_author: { mid: 111, name: 'UP-111', face: 'https://f/111.jpg', pub_ts: '1700000100' },
    module_dynamic: {
      desc: null,
      // 用不上的 major 分支是显式 null，真 payload 就是这样（见 poll.test 的注释）。
      major: {
        type: 'MAJOR_TYPE_ARCHIVE',
        archive: { bvid: 'BV1x', title: '视频标题', desc: '视频简介', cover: 'https://c/av.jpg' },
        draw: null,
        article: null,
        opus: null,
        live_rcmd: null,
      },
    },
  },
}

const REPLY = JSON.stringify({
  tldr: '一句话讲完这个视频',
  points: ['要点一', '要点二', '要点三'],
  chapters: [{ startSec: 0, title: '开场', desc: null }, { startSec: 83, title: '正题', desc: '细说' }],
})

const llmOk: FakeResponse = {
  raw: { choices: [{ message: { content: REPLY } }], usage: { prompt_tokens: 120, completion_tokens: 40 } },
}

/** subtitles 为空 = 这个视频没字幕。 */
const player = (tracks: unknown[]): FakeResponse => ({ data: { subtitle: { subtitles: tracks } } })

const ZH_TRACK = { lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//sub.test/zh.json' }

function bili(): FakeFetch {
  return new FakeFetch()
    .on('feed/all/update', { data: { update_num: 1 } })
    .on('feed/all', { data: { items: [AV_ITEM], has_more: false, offset: '', update_baseline: 'b1' } })
    .on('web-interface/nav', { data: { wbi_img: { img_url: IMG, sub_url: SUB } } })
    .on('web-interface/view', { data: { cid: 555, pages: [{ cid: 555 }] } })
    .on('sub.test/zh.json', {
      raw: { body: [{ from: 0, to: 4, content: '大家好' }, { from: 83, to: 86, content: '进入正题' }] },
    })
    .on('/chat/completions', llmOk)
}

async function rig(fetch: FakeFetch): Promise<{ h: Harness; events: AppEvent[] }> {
  const h = await createHarness({ fetch, cookies: ['SESSDATA=fake; Path=/; Domain=.bilibili.com'] })
  h.core.repos.subscriptions.upsert({
    uid: '111',
    name: 'UP-111',
    face: null,
    enableDynamic: true,
    enableVideo: true,
    enableAi: true,
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
  const events: AppEvent[] = []
  h.events.on((e) => events.push(e))
  h.server.services.queue.start()
  return { h, events }
}

describe('总结队列', () => {
  it('抓到视频自动入队，跑完落库落盘，阶段与完成都发了 SSE', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h, events } = await rig(fetch)

    const poll = await h.server.services.poll.pollOnce()
    assert.equal(poll.found, 1)
    await h.server.services.queue.drain()

    const job = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(job?.status, 'done')
    assert.equal(job?.stage, 'persist')
    assert.equal(job?.error, null)

    const summary = h.core.repos.summaries.get('BV1x')
    assert.equal(summary?.tldr, '一句话讲完这个视频')
    assert.equal(summary?.points.length, 3)
    assert.equal(summary?.transcriptSource, 'subtitle')
    // 章节链接要能点回 B 站的那一秒。
    assert.match(summary?.fullMd ?? '', /\?t=83/)
    assert.match(summary?.fullMd ?? '', /## 核心要点/)

    const md = readFileSync(join(h.dataDir, 'summaries', 'BV1x.md'), 'utf8')
    assert.equal(md, summary?.fullMd)

    // token 记账逐次记，页面上的用量是从它数出来的。
    assert.equal(h.core.repos.llmCalls.usageSince(0).inTokens, 120)

    const stages = events.filter((e) => e.type === 'job.changed').map((e) => e.stage)
    assert.ok(stages.includes('subtitle') && stages.includes('reduce'))
    assert.ok(events.some((e) => e.type === 'job.changed' && e.status === 'done'))
    assert.ok(events.some((e) => e.type === 'summary.done' && e.bvid === 'BV1x'))

    await h.close()
  })

  it('没字幕的任务明确失败，重跑成功且不产生重复数据', async () => {
    const fetch = bili()
    // 第一次没字幕轨，重跑时有了 —— 第 10 票的音频兜底会替掉这条路。
    fetch.onSequence('player/wbi/v2', [player([]), player([ZH_TRACK])])
    const { h, events } = await rig(fetch)

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()

    const failed = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(failed?.status, 'failed')
    assert.match(failed?.error ?? '', /字幕/)
    assert.equal(h.core.repos.summaries.get('BV1x'), null)
    // 失败事件要说清卡在哪一步，不能报入队时的 queued。
    const failedEvent = events.find((e) => e.type === 'job.changed' && e.status === 'failed')
    assert.equal(failedEvent?.type === 'job.changed' ? failedEvent.stage : null, 'subtitle')

    assert.equal((await h.server.app.request('/api/jobs/9999/retry', { method: 'POST' })).status, 404)
    const retry = await h.server.app.request(`/api/jobs/${failed?.id}/retry`, { method: 'POST' })
    assert.equal(retry.status, 200)
    await h.server.services.queue.drain()

    const done = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(done?.status, 'done')
    // 同一个 bvid 始终一条任务、一份总结。
    assert.equal(done?.id, failed?.id)
    assert.equal(h.core.repos.jobs.list({ limit: 50 }).length, 1)

    const listed = (await (await h.server.app.request('/api/jobs')).json()) as JobsResponse
    assert.equal(listed.jobs.length, 1)
    assert.equal(listed.videos['BV1x']?.title, '视频标题')

    await h.close()
  })

  it('重启把中断的 running 任务放回待处理并续跑', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)

    h.core.repos.jobs.enqueue({ bvid: 'BV1x', updateId: '901', at: h.clock.now() })
    // 手动占住：等于上个进程崩在跑一半。
    const claimed = h.core.repos.jobs.claimNext(h.clock.now())
    assert.equal(claimed?.status, 'running')

    const h2 = await h.restart()
    h2.server.services.queue.start()
    await h2.server.services.queue.drain()

    assert.equal(h2.core.repos.jobs.getByBvid('BV1x')?.status, 'done')
    await h2.close()
  })
})
