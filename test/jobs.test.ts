import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { JobsResponse } from '#shared/contract/api.ts'
import { bili, llmOk, player, rig, ZH_TRACK } from './support/queue-rig.ts'

/**
 * 总结队列端到端：抓到视频 → 入队 → 取字幕 → 调 LLM → 落库落盘。
 * 假的只有 fetch，队列、并发、仓储、Markdown 渲染与落盘都是真在跑。
 */

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

  it('LLM 挂了：任务失败但留下最小可推送内容，重跑成功且不产生重复数据', async () => {
    // 第一次鉴权就没过（不重试的那类错），重跑时正常。
    const fetch = bili([{ status: 401, raw: { error: { message: 'invalid api key' } } }, llmOk])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h, events } = await rig(fetch)

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()

    const failed = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(failed?.status, 'failed')
    // 全链路失败也要有能推的东西：标题、封面、链接、失败原因。
    const minimal = h.core.repos.summaries.get('BV1x')
    assert.equal(minimal?.degradePath, 'link-only')
    assert.match(minimal?.fullMd ?? '', /# 视频标题/)
    assert.match(minimal?.fullMd ?? '', /https:\/\/c\/av\.jpg/)
    assert.match(minimal?.fullMd ?? '', /生成总结：/)
    // 失败事件要说清卡在哪一步，不能报入队时的 queued。
    const failedEvent = events.find((e) => e.type === 'job.changed' && e.status === 'failed')
    assert.equal(failedEvent?.type === 'job.changed' ? failedEvent.stage : null, 'reduce')

    assert.equal((await h.server.app.request('/api/jobs/9999/retry', { method: 'POST' })).status, 404)
    const retry = await h.server.app.request(`/api/jobs/${failed?.id}/retry`, { method: 'POST' })
    assert.equal(retry.status, 200)
    await h.server.services.queue.drain()

    const done = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(done?.status, 'done')
    // 重跑要把那条最小内容换成真总结。
    assert.equal(h.core.repos.summaries.get('BV1x')?.degradePath, 'subtitle')
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
