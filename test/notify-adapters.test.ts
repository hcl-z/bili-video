import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { makePushNotifiers } from '../src/server/infra/notify/push-all-in-one.ts'
import type { NotifyConfig } from '#shared/contract/config.ts'
import { CollectingLogger } from './fakes/logger.ts'

const baseConfig = (): NotifyConfig => ({
  wxpusher: { enabled: false, uids: [] },
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
  feishu: { enabled: false, appId: '', receiveIdType: 'open_id', receiveId: '' },
  webhook: { enabled: true, url: 'https://hooks.example.test/bili' },
})

describe('Webhook 推送适配器', () => {
  it('POST 固定 JSON 并带可选 Authorization', async () => {
    let request: Request | null = null
    const fetcher: typeof fetch = async (input, init) => {
      request = new Request(input, init)
      return new Response(null, { status: 204, headers: { 'x-request-id': 'req-1' } })
    }
    const notifier = makePushNotifiers({
      config: baseConfig,
      wxpusherToken: () => null,
      ntfyAuth: () => null,
      feishuSecret: () => null,
      webhookAuthorization: () => 'Bearer hook-secret',
      fetch: fetcher,
      logger: new CollectingLogger(),
    }).find((candidate) => candidate.channel === 'webhook')!

    const result = await notifier.send({
      kind: 'summary',
      title: '标题',
      body: '正文',
      url: 'https://www.bilibili.com/video/BV1x',
      group: '901',
    })

    assert.equal(result.ok, true)
    assert.equal(result.externalId, 'req-1')
    assert.equal(request!.method, 'POST')
    assert.equal(request!.headers.get('authorization'), 'Bearer hook-secret')
    assert.deepEqual(await request!.json(), {
      kind: 'summary',
      title: '标题',
      body: '正文',
      url: 'https://www.bilibili.com/video/BV1x',
      group: '901',
    })
  })

  it('非 2xx 作为投递失败返回', async () => {
    const notifier = makePushNotifiers({
      config: baseConfig,
      wxpusherToken: () => null,
      ntfyAuth: () => null,
      feishuSecret: () => null,
      webhookAuthorization: () => null,
      fetch: async () => new Response('no', { status: 401, statusText: 'Unauthorized' }),
      logger: new CollectingLogger(),
    }).find((candidate) => candidate.channel === 'webhook')!

    const result = await notifier.test()
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /401 Unauthorized/)
  })
})
