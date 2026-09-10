import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { makePushNotifiers } from '../src/server/infra/notify/push-all-in-one.ts'
import type { NotifyConfig } from '#shared/contract/config.ts'
import { CollectingLogger } from './fakes/logger.ts'

const baseConfig = (): NotifyConfig => ({
  wxpusher: { enabled: false, uids: [] },
  pushplus: { enabled: false, channel: 'wechat', topic: '' },
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
  feishu: { enabled: false, appId: '', receiveIdType: 'open_id', receiveId: '' },
  webhook: { enabled: true, url: 'https://hooks.example.test/bili' },
})

describe('通知推送适配器', () => {
  it('飞书先上传封面，再用 image_key 发送交互卡片', async () => {
    const requests: Request[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url.includes('/auth/v3/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 })
      }
      if (request.url === 'https://i0.hdslb.com/bfs/archive/cover.jpg') {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      if (request.url.includes('/im/v1/images')) {
        const form = await request.formData()
        assert.equal(form.get('image_type'), 'message')
        assert.equal((form.get('image') as File).name, 'cover.jpg')
        return Response.json({ code: 0, data: { image_key: 'img_v2_cover' } })
      }
      return Response.json({ code: 0, data: { message_id: 'om_1' } })
    }
    const config = baseConfig()
    config.webhook.enabled = false
    config.feishu = {
      enabled: true,
      appId: 'cli_test',
      receiveIdType: 'chat_id',
      receiveId: 'oc_test',
    }
    const notifier = makePushNotifiers({
      config: () => config,
      wxpusherToken: () => null,
      ntfyAuth: () => null,
      feishuSecret: () => 'secret',
      webhookAuthorization: () => null,
      fetch: fetcher,
      logger: new CollectingLogger(),
    }).find((candidate) => candidate.channel === 'feishu')!

    const result = await notifier.send({
      kind: 'discover',
      title: 'UP 发了《图文》',
      body: '图文正文',
      url: 'https://t.bilibili.com/901',
      imageUrl: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
      group: '901',
    })

    assert.deepEqual(result, { ok: true, externalId: 'om_1', error: null })
    assert.equal(requests.length, 4)
    const sent = (await requests[3]!.json()) as {
      msg_type: string
      content: string
      uuid: string
    }
    assert.equal(sent.msg_type, 'interactive')
    assert.equal(sent.uuid, '901:discover')
    assert.deepEqual(JSON.parse(sent.content), {
      schema: '2.0',
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: 'UP 发了《图文》' },
        template: 'blue',
      },
      body: {
        elements: [
          {
            tag: 'img',
            img_key: 'img_v2_cover',
            alt: { tag: 'plain_text', content: 'UP 发了《图文》' },
          },
          { tag: 'markdown', content: '图文正文' },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看原内容' },
            type: 'primary',
            width: 'fill',
            behaviors: [{ type: 'open_url', default_url: 'https://t.bilibili.com/901' }],
          },
        ],
      },
    })
  })

  it('PushPlus 使用 Markdown 模板发送正文、封面和原文链接', async () => {
    let request: Request | null = null
    const config = baseConfig()
    config.webhook.enabled = false
    config.pushplus = { enabled: true, channel: 'app', topic: 'investing' }
    const notifier = makePushNotifiers({
      config: () => config,
      wxpusherToken: () => null,
      pushplusToken: () => 'pushplus-token',
      ntfyAuth: () => null,
      feishuSecret: () => null,
      webhookAuthorization: () => null,
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({ code: 200, msg: '请求成功', data: 'message-1' })
      },
      logger: new CollectingLogger(),
    }).find((candidate) => candidate.channel === 'pushplus')!

    const result = await notifier.send({
      kind: 'summary',
      title: '标题',
      body: '正文',
      url: 'https://www.bilibili.com/video/BV1x',
      imageUrl: 'https://i0.hdslb.com/cover.jpg',
      group: 'BV1x',
    })

    assert.deepEqual(result, { ok: true, externalId: 'message-1', error: null })
    assert.equal(request!.url, 'https://www.pushplus.plus/send')
    assert.deepEqual(await request!.json(), {
      token: 'pushplus-token',
      title: '标题',
      content: '正文\n\n![标题](https://i0.hdslb.com/cover.jpg)\n\n[查看原内容](https://www.bilibili.com/video/BV1x)',
      template: 'markdown',
      channel: 'app',
      topic: 'investing',
    })
  })

  it('ntfy 在 UTF-8 字符边界截断长正文，并保留错误详情', async () => {
    const requests: Request[] = []
    const config = baseConfig()
    config.webhook.enabled = false
    config.ntfy = { enabled: true, server: 'https://ntfy.example.test', topic: 'bili' }
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (requests.length === 1) return Response.json({ id: 'ntfy-1' })
      return Response.json(
        { code: 40011, http: 400, error: 'invalid request: message must be UTF-8 encoded' },
        { status: 400, statusText: 'Bad Request' },
      )
    }
    const notifier = makePushNotifiers({
      config: () => config,
      wxpusherToken: () => null,
      ntfyAuth: () => 'Bearer token',
      feishuSecret: () => null,
      webhookAuthorization: () => null,
      fetch: fetcher,
      logger: new CollectingLogger(),
    }).find((candidate) => candidate.channel === 'ntfy')!
    const message = {
      kind: 'summary' as const,
      title: '标题',
      body: '中'.repeat(2_000),
      url: 'https://www.bilibili.com/video/BV1x',
      imageUrl: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
      group: 'BV1x',
    }

    assert.deepEqual(await notifier.send(message), { ok: true, externalId: 'ntfy-1', error: null })
    const body = await requests[0]!.text()
    assert.ok(Buffer.byteLength(body, 'utf8') <= 4_096)
    assert.equal(body.includes('�'), false)
    assert.match(body, /…（正文过长，已截断）$/)
    assert.equal(requests[0]!.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(requests[0]!.headers.get('authorization'), 'Bearer token')

    const failed = await notifier.send({ ...message, body: '短正文' })
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /40011|UTF-8 encoded/)
  })

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
      imageUrl: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
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
      imageUrl: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
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
