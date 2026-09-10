import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { JobsResponse } from '#shared/contract/api.ts'
import type { PipelineStep, StepStatus } from '#shared/contract/job.ts'
import { bili, llmOk, player, rig, ZH_TRACK } from './support/queue-rig.ts'

/** 六步流水线：每一步的状态落库，重跑能从任意一步起 —— 前面那几步的产物照用 */

const steps = (job: { steps: { step: PipelineStep; status: StepStatus }[] }) =>
  Object.fromEntries(job.steps.map((s) => [s.step, s.status]))

describe('任务流水线', () => {
  it('跑完一条：每一步的状态都落了库，没走的那几步标成跳过', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()

    const job = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(job?.status, 'done')
    assert.deepEqual(steps(job!), {
      subtitle: 'done',

      download: 'skipped',
      asr: 'skipped',
      chunk: 'skipped',
      reduce: 'done',
      persist: 'done',
    })
    // 每一步的产物都留着，下一次重跑才能挑起点
    assert.notEqual(h.core.repos.artifacts.get('BV1x', 'transcript'), null)
    assert.notEqual(h.core.repos.artifacts.get('BV1x', 'draft'), null)

    await h.close()
  })

  it('从 reduce 重跑：字幕一次都不重取，LLM 重新生成，落库照旧', async () => {
    const fetch = bili([llmOk, llmOk])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()
    const subtitleCalls = fetch.countOf('sub.test/zh.json')
    const llmCalls = fetch.countOf('/chat/completions')
    const job = h.core.repos.jobs.getByBvid('BV1x')

    const res = await h.server.app.request(`/api/jobs/${job?.id}/retry?from=reduce`, {
      method: 'POST',
    })
    assert.equal(res.status, 200)
    await h.server.services.queue.drain()

    // 转写那一段一个请求都没多发，生成那一段重跑了一次。
    assert.equal(fetch.countOf('sub.test/zh.json'), subtitleCalls)
    assert.equal(fetch.countOf('/chat/completions'), llmCalls + 1)

    const after = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(after?.status, 'done')
    assert.equal(after?.resumeFrom, 'reduce')
    // 复用和重跑在页面上是两种标记，别混成一个「完成」。
    const marks = steps(after!)
    assert.equal(marks['subtitle'], 'reused')
    assert.equal(marks['reduce'], 'done')
    assert.equal(marks['persist'], 'done')

    await h.close()
  })

  it('从 persist 重跑：连 LLM 都不调，直接用上次的草稿落库', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)

    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()
    const llmCalls = fetch.countOf('/chat/completions')
    const job = h.core.repos.jobs.getByBvid('BV1x')

    await h.server.app.request(`/api/jobs/${job?.id}/retry?from=persist`, { method: 'POST' })
    await h.server.services.queue.drain()

    assert.equal(fetch.countOf('/chat/completions'), llmCalls)
    const after = h.core.repos.jobs.getByBvid('BV1x')
    assert.equal(after?.status, 'done')
    assert.equal(steps(after!)['reduce'], 'reused')
    assert.equal(h.core.repos.summaries.get('BV1x')?.tldr, '这个视频讲清了一件事，并给出了结论。')

    await h.close()
  })

  it('认不出的起点回 400，不动队列', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    await h.server.services.poll.pollOnce()
    await h.server.services.queue.drain()
    const job = h.core.repos.jobs.getByBvid('BV1x')

    const res = await h.server.app.request(`/api/jobs/${job?.id}/retry?from=nope`, { method: 'POST' })
    assert.equal(res.status, 400)
    assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'done')

    const listed = (await (await h.server.app.request('/api/jobs')).json()) as JobsResponse
    assert.equal(listed.jobs[0]?.steps.length, 6)

    await h.close()
  })
})
