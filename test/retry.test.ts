import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AppEvent } from '#shared/contract/events.ts'
import type { FakeFetch } from './fakes/bili-fetch.ts'
import { avItem, bili, llmOk, player, rig, ZH_TRACK } from './support/queue-rig.ts'

const steps = (job: { steps: { step: string; status: string }[] }) =>
  Object.fromEntries(job.steps.map((s) => [s.step, s.status]))

/**
 * 失败重试的编排：排下一次、到点被取走、预算用尽推错误提示。
 * 时间用假时钟推进 —— 重试间隔本来就是「等一会儿」，真等就没法测了。
 */

const llmFail = { status: 500, raw: { error: { message: '上游炸了' } } }

/** 把推送渠道打开，错误提示才有地方可发 */
function enablePush(h: Awaited<ReturnType<typeof rig>>['h']): void {
  h.core.config.setSection('notify', {
    ...h.core.config.getSection('notify'),
    ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'test_topic' },
  })
}

describe('失败重试', () => {
  it('首次失败后排下一次，到点自动接着跑并成功', async () => {
    const fetch: FakeFetch = bili([llmFail, llmOk])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      h.core.config.setSection('queue', { maxRetries: 2, retryIntervalMs: 60_000 })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()

      const parked = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(parked?.status, 'pending', '失败后留在队列里等着重跑')
      assert.equal(parked?.retries, 1)
      assert.equal(parked?.resumeFrom, 'reduce', '从失败的那一步接着跑，不重头来')
      assert.ok((parked?.nextAttemptAt ?? 0) > h.clock.now())

      // 还没到点，取不走
      await h.server.services.queue.drain()
      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.retries, 1)

      h.clock.advance(60_000)
      await h.server.services.queue.drain()

      const done = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(done?.status, 'done')
      // 转写那段没有重跑：复用的是第一次留下的产物。
      assert.equal(fetch.countOf('sub.test/zh.json'), 1)
      assert.equal(h.core.repos.summaries.get('BV1x')?.degradePath, 'subtitle')
    } finally {
      await h.close()
    }
  })

  it('重试预算用尽后落 failed，并推一条错误提示而不是空总结', async () => {
    const fetch = bili([llmFail])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      enablePush(h)
      h.core.config.setSection('queue', { maxRetries: 2, retryIntervalMs: 60_000 })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()

      // 两次重试都到点，仍失败
      for (let i = 0; i < 2; i += 1) {
        h.clock.advance(60_000)
        await h.server.services.queue.drain()
      }

      const job = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(job?.status, 'failed')
      assert.equal(job?.retries, 2, '重试次数用满即停')
      assert.match(job?.error ?? '', /上游炸了/)

      // 没有任何总结内容被推出去
      assert.equal(h.core.repos.summaries.get('BV1x'), null)
      assert.equal(
        h.notifier.sent.filter((m) => m.kind === 'summary').length,
        0,
        '没有可推的总结就不该推',
      )

      const alerts = h.notifier.sent.filter((m) => m.kind === 'alert')
      assert.equal(alerts.length, 1)
      assert.match(alerts[0]?.title ?? '', /失败/)
      assert.match(alerts[0]?.body ?? '', /上游炸了/)
      assert.match(alerts[0]?.body ?? '', /已重试 2 次/)
    } finally {
      await h.close()
    }
  })

  it('maxRetries=0 时首次失败即定局，不排重试', async () => {
    const fetch = bili([llmFail])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      h.core.config.setSection('queue', { maxRetries: 0, retryIntervalMs: 60_000 })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()

      const job = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(job?.status, 'failed')
      assert.equal(job?.retries, 0)
      assert.equal(job?.nextAttemptAt, null)
    } finally {
      await h.close()
    }
  })

  it('手动重跑清零配额，不吃自动重试剩下的次数', async () => {
    const fetch = bili([llmFail, llmFail, llmOk])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      // 只给一次自动重试：用完后任务落 failed，手动重跑才拿得回来。
      h.core.config.setSection('queue', { maxRetries: 1, retryIntervalMs: 60_000 })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()
      h.clock.advance(60_000)
      await h.server.services.queue.drain()

      const failed = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(failed?.status, 'failed')
      assert.equal(failed?.retries, 1)

      // 手动重跑：配额归零，用户重新拿到完整预算，于是这一次能成功。
      const res = await h.server.app.request(`/api/jobs/${failed?.id}/retry`, { method: 'POST' })
      assert.equal(res.status, 200)
      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.retries, 0)

      await h.server.services.queue.drain()
      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'done')
    } finally {
      await h.close()
    }
  })

  it('重跑成功后重新推送，不会因为上次已推送就沈默', async () => {
    const fetch = bili([llmOk, llmOk])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      enablePush(h)
      // 发现通知是投递服务发的事件监听发的，总结推送走流水线。两边都要开着才都能断言。
      h.server.services.delivery.start()

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()
      await h.server.services.delivery.drain()
      assert.equal(h.notifier.sent.filter((m) => m.kind === 'summary').length, 1)
      assert.equal(h.notifier.sent.filter((m) => m.kind === 'discover').length, 1)

      // 用户从 reduce 重跑：这是新生成的内容，应该重新推一次。
      const job = h.core.repos.jobs.getByBvid('BV1x')
      const res = await h.server.app.request(`/api/jobs/${job?.id}/retry?from=reduce`, {
        method: 'POST',
      })
      assert.equal(res.status, 200)
      await h.server.services.queue.drain()

      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'done')
      await h.server.services.delivery.drain()
      assert.equal(
        h.notifier.sent.filter((m) => m.kind === 'summary').length,
        2,
        '重跑出新内容就该再推一次',
      )
      // 发现通知没有因为总结重跑而重发。
      assert.equal(h.notifier.sent.filter((m) => m.kind === 'discover').length, 1)
    } finally {
      await h.close()
    }
  })

  it('静默时段里推送标跳过并留待补推，不要让任务失败', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      enablePush(h)
      h.core.config.setSection('filter', {
        ...h.core.config.getSection('filter'),
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()

      // 静默不是失败：任务照样 done，投递记录留着 pending 等 flush 补推。
      const job = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(job?.status, 'done')
      assert.equal(steps(job!)['push'], 'skipped')
      assert.equal(h.notifier.sent.length, 0)
      assert.equal(h.core.repos.deliveries.listForUpdate('901')[0]?.status, 'pending')

      // 静默结束后补推出去。
      h.core.config.setSection('filter', {
        ...h.core.config.getSection('filter'),
        quietHours: { enabled: false, start: '00:00', end: '23:59' },
      })
      await h.server.services.delivery.flush()
      assert.equal(h.notifier.sent.filter((m) => m.kind === 'summary').length, 1)
    } finally {
      await h.close()
    }
  })

  it('静默期间耗尽重试，错误提示要挂住等静默结束补推', async () => {
    const fetch = bili([llmFail])
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      enablePush(h)
      h.core.config.setSection('queue', { maxRetries: 0, retryIntervalMs: 60_000 })
      h.core.config.setSection('filter', {
        ...h.core.config.getSection('filter'),
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()
      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'failed')
      assert.equal(h.notifier.sent.length, 0, '静默期间不发')

      // 静默结束：那条错误提示不能永远丢掉。
      h.core.config.setSection('filter', {
        ...h.core.config.getSection('filter'),
        quietHours: { enabled: false, start: '00:00', end: '23:59' },
      })
      await h.server.services.delivery.flush()
      const alerts = h.notifier.sent.filter((m) => m.kind === 'alert')
      assert.equal(alerts.length, 1, '静默结束后应当补推错误提示')
      assert.match(alerts[0]?.body ?? '', /上游炸了/)
    } finally {
      await h.close()
    }
  })

  it('推送失败时不先发一个假的 done 事件', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      enablePush(h)
      h.core.config.setSection('queue', { maxRetries: 0, retryIntervalMs: 60_000 })
      h.notifier.failWith = '通道挂了'

      const events: AppEvent[] = []
      h.events.on((e) => events.push(e))

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()

      // 任务最终是 failed，中间不该冒出 done —— 页面会据此闪一下假成功。
      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'failed')
      assert.equal(events.filter((e) => e.type === 'job.changed' && e.status === 'done').length, 0)
    } finally {
      await h.close()
    }
  })

  it('推送失败也重试：只重发，不重新调 LLM', async () => {
    const fetch = bili()
    fetch.on('player/wbi/v2', player([ZH_TRACK]))
    const { h } = await rig(fetch)
    try {
      enablePush(h)
      h.core.config.setSection('queue', { maxRetries: 1, retryIntervalMs: 60_000 })
      h.notifier.failWith = '通道挂了'

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()

      const parked = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(parked?.status, 'pending', '推送失败也进重试')
      assert.equal(parked?.resumeFrom, 'push', '只重跑推送这一步')
      // 正文已经落库了，重试不该把它弄没
      assert.equal(h.core.repos.summaries.get('BV1x')?.degradePath, 'subtitle')
      const llmCalls = fetch.countOf('/chat/completions')

      h.notifier.failWith = null
      h.clock.advance(60_000)
      await h.server.services.queue.drain()

      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'done')
      assert.equal(fetch.countOf('/chat/completions'), llmCalls, '重发不该重调 LLM')
      assert.equal(h.notifier.sent.filter((m) => m.kind === 'summary').length, 1)
    } finally {
      await h.close()
    }
  })

  it('转写一直拿不到内容时重试也救不回来，用尽后推错误提示', async () => {
    const fetch = bili()
    // 既没有字幕，也没接 ASR —— 转写这级必定失败
    fetch.on('player/wbi/v2', player([]))
    const { h } = await rig(fetch)
    try {
      enablePush(h)
      h.core.config.setSection('queue', { maxRetries: 1, retryIntervalMs: 5_000 })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()
      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.resumeFrom, 'subtitle')

      h.clock.advance(5_000)
      await h.server.services.queue.drain()

      const job = h.core.repos.jobs.getByBvid('BV1x')
      assert.equal(job?.status, 'failed')
      assert.equal(h.core.repos.summaries.get('BV1x'), null)

      const alerts = h.notifier.sent.filter((m) => m.kind === 'alert')
      assert.equal(alerts.length, 1)
      assert.match(alerts[0]?.body ?? '', /官方字幕|语音转写/)
    } finally {
      await h.close()
    }
  })

  it('重试排到未来时不再占着任务位，同批其他视频照常跑完', async () => {
    const fetch = bili([llmOk], undefined, [avItem('BV1x', '901'), avItem('BV1y', '902')])
    // BV1x 没字幕（去转写，而进程没接 ASR，必失败），BV1y 有字幕，能跑完。
    fetch.on('player/wbi/v2', (req) =>
      player(req.query.get('bvid') === 'BV1x' ? [] : [ZH_TRACK]),
    )
    const { h } = await rig(fetch)
    try {
      h.core.config.setSection('queue', { maxRetries: 3, retryIntervalMs: 600_000 })

      await h.server.services.poll.pollOnce()
      await h.server.services.queue.drain()

      // 第一条在等重试窗口，第二条已经真的做完了 —— 排队中的重试没把队列堵住。
      assert.equal(h.core.repos.jobs.getByBvid('BV1x')?.status, 'pending')
      assert.equal(h.core.repos.jobs.getByBvid('BV1y')?.status, 'done')
      assert.equal(h.core.repos.summaries.get('BV1y')?.degradePath, 'subtitle')
    } finally {
      await h.close()
    }
  })
})
