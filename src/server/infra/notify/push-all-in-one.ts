import type { NtfyResponse, SendResponse, WxPusherResponse } from 'push-all-in-one'
import { Feishu, Ntfy, WxPusher } from 'push-all-in-one'

import type { NotifyConfig } from '#shared/contract/config.ts'
import type { Logger } from '../../ports/logger.ts'
import type { DeliveryResult, Notifier, NotifyMessage } from '../../ports/notifier.ts'

interface PushNotifierDeps {
  config: () => NotifyConfig
  wxpusherToken: () => string | null
  ntfyAuth: () => string | null
  feishuSecret: () => string | null
  webhookAuthorization: () => string | null
  fetch: typeof fetch
  logger: Logger
}

export function makePushNotifiers(deps: PushNotifierDeps): Notifier[] {
  return [
    new WxPusherNotifier(deps),
    new NtfyNotifier(deps),
    new FeishuNotifier(deps),
    new WebhookNotifier(deps),
  ]
}

class WxPusherNotifier implements Notifier {
  readonly channel = 'wxpusher' as const
  private readonly deps: PushNotifierDeps

  constructor(deps: PushNotifierDeps) {
    this.deps = deps
  }

  async send(message: NotifyMessage): Promise<DeliveryResult> {
    const config = this.deps.config().wxpusher
    const token = this.deps.wxpusherToken()
    if (!config.enabled) return failed('WxPusher 已关闭')
    if (token === null || token === '') return failed('WxPusher appToken 未配置')
    if (config.uids.length === 0) return failed('WxPusher UID 未配置')

    try {
      const client = new WxPusher({ WX_PUSHER_APP_TOKEN: token, WX_PUSHER_UID: config.uids[0]! })
      const response = await client.send(message.title, message.body, {
        contentType: 3,
        summary: summary(message.title),
        uids: config.uids,
        ...(message.url === null ? {} : { url: message.url }),
      })
      return wxpusherResult(response)
    } catch (error) {
      return caught(this.deps.logger, this.channel, error)
    }
  }

  test(): Promise<DeliveryResult> {
    return this.send(testMessage('WxPusher'))
  }
}

class NtfyNotifier implements Notifier {
  readonly channel = 'ntfy' as const
  private readonly deps: PushNotifierDeps

  constructor(deps: PushNotifierDeps) {
    this.deps = deps
  }

  async send(message: NotifyMessage): Promise<DeliveryResult> {
    const config = this.deps.config().ntfy
    if (!config.enabled) return failed('ntfy 已关闭')
    if (config.server === '' || config.topic === '') return failed('ntfy server 或 topic 未配置')

    try {
      const auth = this.deps.ntfyAuth()
      const client = new Ntfy({
        NTFY_URL: trailingSlash(config.server),
        NTFY_TOPIC: config.topic,
        ...(auth === null || auth === '' ? {} : { NTFY_AUTH: auth }),
      })
      const response = await client.send(message.title, message.body, {
        markdown: true,
        ...(message.url === null ? {} : { click: message.url }),
        ...(message.group === null ? {} : { tags: message.kind === 'alert' ? 'warning' : 'movie_camera' }),
      })
      return ntfyResult(response)
    } catch (error) {
      return caught(this.deps.logger, this.channel, error)
    }
  }

  test(): Promise<DeliveryResult> {
    return this.send(testMessage('ntfy'))
  }
}

class FeishuNotifier implements Notifier {
  readonly channel = 'feishu' as const
  private readonly deps: PushNotifierDeps

  constructor(deps: PushNotifierDeps) {
    this.deps = deps
  }

  async send(message: NotifyMessage): Promise<DeliveryResult> {
    const config = this.deps.config().feishu
    const secret = this.deps.feishuSecret()
    if (!config.enabled) return failed('飞书已关闭')
    if (config.appId === '' || secret === null || secret === '') return failed('飞书应用凭据未配置')
    if (config.receiveId === '') return failed('飞书接收 ID 未配置')

    try {
      const client = new Feishu({ FEISHU_APP_ID: config.appId, FEISHU_APP_SECRET: secret })
      const response = await client.send(message.title, feishuBody(message), {
        receive_id_type: config.receiveIdType,
        receive_id: config.receiveId,
        msg_type: 'text',
        ...(message.group === null ? {} : { uuid: `${message.group}:${message.kind}` }),
      })
      return genericResult(response)
    } catch (error) {
      return caught(this.deps.logger, this.channel, error)
    }
  }

  test(): Promise<DeliveryResult> {
    return this.send(testMessage('飞书'))
  }
}

class WebhookNotifier implements Notifier {
  readonly channel = 'webhook' as const
  private readonly deps: PushNotifierDeps

  constructor(deps: PushNotifierDeps) {
    this.deps = deps
  }

  async send(message: NotifyMessage): Promise<DeliveryResult> {
    const config = this.deps.config().webhook
    if (!config.enabled) return failed('Webhook 已关闭')
    if (config.url === '') return failed('Webhook URL 未配置')

    try {
      const authorization = this.deps.webhookAuthorization()
      const response = await this.deps.fetch(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === null || authorization === '' ? {} : { authorization }),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(15_000),
      })
      const externalId = response.headers.get('x-request-id')
      if (!response.ok) return failed(`HTTP ${response.status} ${response.statusText}`.trim())
      return { ok: true, externalId, error: null }
    } catch (error) {
      return caught(this.deps.logger, this.channel, error)
    }
  }

  test(): Promise<DeliveryResult> {
    return this.send(testMessage('Webhook'))
  }
}

function wxpusherResult(response: SendResponse<WxPusherResponse>): DeliveryResult {
  const data = response.data
  if (response.status < 200 || response.status >= 300 || !data.success || data.code !== 1000) {
    return failed(data.msg || `${response.status} ${response.statusText}`)
  }
  return { ok: true, externalId: String(data.data.messageId), error: null }
}

function ntfyResult(response: SendResponse<NtfyResponse>): DeliveryResult {
  if (response.status < 200 || response.status >= 300 || response.data.id === '') {
    return failed(`${response.status} ${response.statusText}`.trim())
  }
  return { ok: true, externalId: response.data.id, error: null }
}

function genericResult(response: SendResponse): DeliveryResult {
  const data = response.data as { code?: number; msg?: string; data?: { message_id?: string } }
  if (response.status < 200 || response.status >= 300 || (data.code ?? 0) !== 0) {
    return failed(data.msg || `${response.status} ${response.statusText}`)
  }
  return { ok: true, externalId: data.data?.message_id ?? null, error: null }
}

function feishuBody(message: NotifyMessage): string {
  return [message.body, message.url].filter((part): part is string => part !== null && part !== '').join('\n\n')
}

function testMessage(channel: string): NotifyMessage {
  return {
    kind: 'alert',
    title: `Bili Video · ${channel} 测试`,
    body: '推送通道可用。',
    url: null,
    group: null,
  }
}

function summary(title: string): string {
  return title.length > 20 ? `${title.slice(0, 19)}…` : title
}

function trailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function caught(logger: Logger, channel: string, error: unknown): DeliveryResult {
  const reason = errorMessage(error)
  logger.warn({ channel, err: reason }, '推送请求失败')
  return failed(reason)
}

function failed(error: string): DeliveryResult {
  return { ok: false, externalId: null, error }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
