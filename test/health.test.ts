import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OverviewResponseSchema } from '#shared/contract/api.ts'
import { FakeFetch } from './fakes/bili-fetch.ts'
import { createHarness, type Harness } from './support/harness.ts'

/**
 * 健康自查与告警。可控时钟 + 记录型通知器：连续失败只推一条、恢复推一条，
 * 全靠断言那台假通知器收到了什么。
 */

/** -400 是 fatal：它不带退避建议，所以三轮失败能连着发生，不用等退避窗口。 */
const BROKEN = { code: -400, message: '请求错误' }
const OK_FEED = { data: { items: [], has_more: false, offset: '', update_baseline: 'b1' } }

async function rig(fetch: FakeFetch): Promise<Harness> {
  const h = await createHarness({
    fetch,
    cookies: ['SESSDATA=fake; Path=/; Domain=.bilibili.com'],
  })
  h.core.config.setSection('notify', {
    wxpusher: { enabled: false, uids: [] },
    pushplus: { enabled: false, channel: 'wechat', topic: '' },
    ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'test_topic' },
    feishu: { enabled: false, appId: '', receiveIdType: 'open_id', receiveId: '' },
    webhook: { enabled: false, url: '' },
  })
  h.core.repos.subscriptions.upsert({
    uid: '111',
    name: 'UP-111',
    face: null,
    enableDynamic: true,
    enableVideo: true,
    enableAi: true,
  })
  return h
}

describe('健康自查与故障告警', () => {
  it('连续三轮拉取失败只推一条告警，恢复后恰好一条恢复通知', async () => {
    const fetch = new FakeFetch().onSequence('feed/all', [BROKEN, BROKEN, BROKEN, OK_FEED])
    const h = await rig(fetch)
    try {
      const { poll, health } = h.server.services

      for (let i = 0; i < 3; i += 1) {
        const r = await poll.pollOnce()
        assert.equal(r.ok, false)
      }
      assert.equal(poll.snapshot().consecutiveFailures, 3)

      // 第一轮自查发现故障，推一条。
      const first = await health.checkNow()
      assert.deepEqual(
        first.faults.map((f) => f.kind),
        ['poll'],
      )
      assert.deepEqual(h.notifier.titles(), ['【故障】连续拉取失败'])

      // 故障还挂着，再查两轮也不该刷屏。
      h.clock.advance(30 * 60_000)
      await health.checkNow()
      h.clock.advance(30 * 60_000)
      await health.checkNow()
      assert.equal(h.notifier.sent.length, 1, '同一段故障推了多条')

      // 拉取恢复：连败清零，下一轮自查恰好推一条「已恢复」。
      assert.equal((await poll.pollOnce()).ok, true)
      assert.equal(poll.snapshot().consecutiveFailures, 0)
      const back = await health.checkNow()
      assert.deepEqual(back.faults, [])
      assert.deepEqual(h.notifier.titles(), ['【故障】连续拉取失败', '【已恢复】连续拉取失败'])

      // 恢复之后不再重复发。
      h.clock.advance(30 * 60_000)
      await health.checkNow()
      assert.equal(h.notifier.sent.length, 2)

      // 两条都进了投递账本，都记成 alert。
      const alerts = h.core.repos.deliveries.recent(10)
      assert.equal(alerts.length, 2)
      assert.ok(alerts.every((d) => d.kind === 'alert' && d.status === 'sent'))
    } finally {
      await h.close()
    }
  })

  it('鉴权失效各自算一类故障，和拉取失败互不影响', async () => {
    const fetch = new FakeFetch().onSequence('feed/all', [{ code: -101, message: '账号未登录' }])
    const h = await rig(fetch)
    try {
      await h.server.services.poll.pollOnce()
      const snap = await h.server.services.health.checkNow()
      assert.deepEqual(
        snap.faults.map((f) => f.kind),
        ['auth'],
      )
      assert.deepEqual(h.notifier.titles(), ['【故障】登录已失效'])
    } finally {
      await h.close()
    }
  })

  it('概览给出队列积压、今日与本月 token 用量和挂着的故障', async () => {
    const h = await createHarness()
    try {
      const now = h.clock.now()
      h.core.repos.updates.insertMany([
        {
          dynId: '901',
          uid: '111',
          type: 'AV',
          pubTs: Math.trunc(now / 1000),
          title: '视频标题',
          text: null,
          cover: null,
          bvid: 'BV1x',
          url: 'https://www.bilibili.com/video/BV1x',
          raw: null,
          filtered: false,
          filterReason: null,
          createdAt: now,
        },
      ])
      h.core.repos.jobs.enqueue({ bvid: 'BV1x', updateId: '901', at: now })
      h.core.repos.llmCalls.record({
        bvid: 'BV1x',
        stage: 'reduce',
        model: 'demo',
        inTokens: 1200,
        outTokens: 340,
        ms: 900,
        at: now,
      })

      const res = await h.server.app.request('/api/overview')
      assert.equal(res.status, 200)
      const body = OverviewResponseSchema.parse(await res.json())

      assert.equal(body.queue.pending, 1)
      assert.equal(body.queue.running, 0)
      assert.equal(body.usage.today.inTokens, 1200)
      assert.equal(body.usage.today.outTokens, 340)
      assert.equal(body.usage.month.calls, 1)
      assert.deepEqual(body.health.faults, [])
      assert.equal(body.health.lastCheckAt, null, '还没查过就该是「不知道」，不是 0')
      assert.deepEqual(body.deliveries, [])
    } finally {
      await h.close()
    }
  })

  it('日志走独立的一条 SSE，档位在服务端精确过滤（error 档连 fatal 一起收）', async () => {
    const h = await createHarness()
    try {
      h.events.emitLog({
        at: h.clock.now(),
        level: 'info',
        mod: 'poll',
        msg: '轮询完成',
        data: { found: 2 },
        err: null,
      })
      h.events.emitLog({
        at: h.clock.now(),
        level: 'warn',
        mod: 'poll',
        msg: '轮询退避',
        data: { waitMs: 10_000 },
        err: null,
      })
      h.events.emitLog({
        at: h.clock.now(),
        level: 'error',
        mod: 'queue',
        msg: '任务失败',
        data: { bvid: 'BV1x', stage: 'asr' },
        err: 'Error: 转写结果是空的',
      })
      h.events.emitLog({
        at: h.clock.now(),
        level: 'fatal',
        mod: 'boot',
        msg: '启动失败',
        data: {},
        err: 'Error: master key 读不出来',
      })

      const res = await h.server.app.request('/api/logs/stream?level=error')
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

      // 补历史是逐行写的，每行一个 chunk，所以要多读几次才拿得齐。
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let chunk = ''
      for (let i = 0; i < 8 && !chunk.includes('启动失败'); i += 1) {
        chunk += decoder.decode((await reader.read()).value)
      }
      await reader.cancel()

      assert.match(chunk, /任务失败/)
      // 结构化字段和错误摘要一起过来，否则日志页只剩一句话可看。
      assert.match(chunk, /BV1x/)
      assert.match(chunk, /转写结果是空的/)
      // fatal 比 error 更糟，看 error 的时候藏起来就是个 bug。
      assert.match(chunk, /启动失败/)
      // 精确过滤：选 error 就只有 error 那一档，别的档一行都不该漏出来。
      assert.doesNotMatch(chunk, /轮询完成/)
      assert.doesNotMatch(chunk, /轮询退避/, 'warn 档的行漏进了 error 档')
    } finally {
      await h.close()
    }
  })
})
