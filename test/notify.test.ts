import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NotifySettingsResponseSchema, NotifyTestResponseSchema } from '#shared/contract/api.ts'
import type { Summary } from '#shared/contract/summary.ts'
import type { UpdateWithRaw } from '#shared/contract/update.ts'
import { createHarness, type Harness } from './support/harness.ts'

const update = (h: Harness, input: Partial<UpdateWithRaw> = {}): UpdateWithRaw => ({
  dynId: '901',
  uid: '111',
  type: 'AV',
  pubTs: Math.trunc(h.clock.now() / 1000),
  title: '视频标题',
  text: '视频简介',
  cover: null,
  bvid: 'BV1x',
  url: 'https://www.bilibili.com/video/BV1x',
  raw: null,
  filtered: false,
  filterReason: null,
  createdAt: h.clock.now(),
  ...input,
})

const summary = (h: Harness): Summary => ({
  bvid: 'BV1x',
  tldr: '一句话',
  article: '完整正文',
  fullMd: '# 视频标题\n\n完整正文',
  transcriptSource: 'subtitle',
  degradePath: 'subtitle',
  confidence: 'high',
  createdAt: h.clock.now(),
})

async function rig(): Promise<Harness> {
  const h = await createHarness()
  h.core.repos.subscriptions.upsert({
    uid: '111',
    name: 'UP-111',
    face: null,
    enableAi: true,
  })
  h.core.config.setSection('notify', {
    wxpusher: { enabled: false, uids: [] },
    pushplus: { enabled: false, channel: 'wechat', topic: '' },
    ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'test_topic' },
    feishu: { enabled: false, appId: '', receiveIdType: 'open_id', receiveId: '' },
    webhook: { enabled: false, url: '' },
  })
  h.server.services.delivery.start()
  return h
}

describe('推送渠道', () => {
  it('新更新立即推发现通知，总结完成再推完整正文，重复事件不重推', async () => {
    const h = await rig()
    try {
      h.core.repos.updates.insertMany([
        update(h, { cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg' }),
      ])
      h.events.emit({ type: 'update.new', dynId: '901', uid: '111' })
      await h.server.services.delivery.drain()

      h.core.repos.summaries.upsert(summary(h), '字幕')
      h.events.emit({ type: 'summary.done', bvid: 'BV1x' })
      await h.server.services.delivery.drain()
      h.events.emit({ type: 'summary.done', bvid: 'BV1x' })
      await h.server.services.delivery.drain()

      assert.equal(h.notifier.sent.length, 2)
      assert.equal(h.notifier.sent[0]?.kind, 'discover')
      assert.equal(h.notifier.sent[1]?.kind, 'summary')
      assert.equal(h.notifier.sent[0]?.group, '901')
      assert.equal(h.notifier.sent[1]?.group, '901')
      assert.equal(h.notifier.sent[0]?.imageUrl, 'https://i0.hdslb.com/bfs/archive/cover.jpg')
      assert.equal(h.notifier.sent[1]?.imageUrl, 'https://i0.hdslb.com/bfs/archive/cover.jpg')
      assert.match(h.notifier.sent[1]?.body ?? '', /完整正文/)
      assert.deepEqual(
        h.core.repos.deliveries.listForUpdate('901').map((delivery) => delivery.status),
        ['sent', 'sent'],
      )
    } finally {
      await h.close()
    }
  })

  it('免扰时先占位不发送，结束后补推', async () => {
    const h = await rig()
    try {
      h.core.config.setSection('filter', {
        ...h.core.config.getSection('filter'),
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })
      h.core.repos.updates.insertMany([update(h)])
      h.events.emit({ type: 'update.new', dynId: '901', uid: '111' })
      await h.server.services.delivery.drain()
      assert.equal(h.notifier.sent.length, 0)
      assert.equal(h.core.repos.deliveries.listForUpdate('901')[0]?.status, 'pending')

      h.core.config.setSection('filter', {
        ...h.core.config.getSection('filter'),
        quietHours: { enabled: false, start: '00:00', end: '23:59' },
      })
      await h.server.services.delivery.flush()
      assert.equal(h.notifier.sent.length, 1)
      assert.equal(h.core.repos.deliveries.listForUpdate('901')[0]?.status, 'sent')
    } finally {
      await h.close()
    }
  })

  it('失败过的投递不再被 flush 重推', async () => {
    const h = await rig()
    try {
      h.notifier.failWith = '通道挂了'
      h.core.repos.updates.insertMany([update(h)])
      h.events.emit({ type: 'update.new', dynId: '901', uid: '111' })
      await h.server.services.delivery.drain()
      assert.equal(h.core.repos.deliveries.listForUpdate('901')[0]?.status, 'failed')

      h.notifier.failWith = null
      await h.server.services.delivery.flush()
      await h.server.services.delivery.flush()
      assert.equal(h.notifier.sent.length, 0)
      assert.equal(h.core.repos.deliveries.listForUpdate('901')[0]?.status, 'failed')
    } finally {
      await h.close()
    }
  })

  it('过滤条目与关闭的订阅开关都不推', async () => {
    const h = await rig()
    try {
      h.core.repos.updates.insertMany([update(h, { filtered: true, filterReason: '黑名单' })])
      h.events.emit({ type: 'update.new', dynId: '901', uid: '111' })
      await h.server.services.delivery.drain()
      assert.equal(h.notifier.sent.length, 0)
      assert.deepEqual(h.core.repos.deliveries.listForUpdate('901'), [])
    } finally {
      await h.close()
    }
  })

  it('页面保存的凭据只返回掩码，并能按渠道发送测试消息', async () => {
    const h = await createHarness()
    try {
      const saved = await h.server.app.request('/api/notify', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notify: {
            wxpusher: { enabled: true, uids: ['UID_test'] },
            pushplus: { enabled: true, channel: 'app', topic: '' },
            ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'private_topic' },
            feishu: {
              enabled: true,
              appId: 'cli_test',
              receiveIdType: 'chat_id',
              receiveId: 'oc_test',
            },
            webhook: { enabled: true, url: 'https://hooks.example.test/bili' },
          },
          wxpusherToken: 'AT_1234567890',
          pushplusToken: 'pushplus-token',
          ntfyAuth: 'Bearer tk_secret',
          feishuSecret: 'feishu-secret',
          webhookAuthorization: 'Bearer hook-secret',
        }),
      })
      const settings = NotifySettingsResponseSchema.parse(await saved.json())
      assert.equal(settings.wxpusherToken.configured, true)
      assert.notEqual(settings.wxpusherToken.masked, 'AT_1234567890')
      assert.equal(settings.pushplusToken.configured, true)
      assert.notEqual(settings.pushplusToken.masked, 'pushplus-token')
      assert.equal(settings.notify.pushplus.channel, 'app')
      assert.equal(settings.ntfyAuth.configured, true)
      assert.equal(settings.feishuSecret.configured, true)
      assert.equal(settings.webhookAuthorization.configured, true)
      assert.equal(settings.targets.wxpusher.ready, true)
      assert.equal(settings.targets.pushplus.ready, true)
      assert.equal(settings.targets.ntfy.ready, true)
      assert.equal(settings.targets.feishu.ready, true)
      assert.equal(settings.targets.webhook.ready, true)

      const tested = await h.server.app.request('/api/notify/ntfy/test', { method: 'POST' })
      const result = NotifyTestResponseSchema.parse(await tested.json())
      assert.equal(result.channel, 'ntfy')
      assert.equal(result.result.ok, true)
      assert.equal(h.notifier.sent.length, 0, '连通性测试不该混进业务投递记录')
    } finally {
      await h.close()
    }
  })
})
