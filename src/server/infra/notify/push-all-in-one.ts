import type { SendResponse, WxPusherResponse } from 'push-all-in-one'
import { WxPusher } from 'push-all-in-one'

import type { NotifyConfig } from '#shared/contract/config.ts'
import type { Logger } from '../../ports/logger.ts'
import type { DeliveryResult, Notifier, NotifyMessage } from '../../ports/notifier.ts'

interface PushNotifierDeps {
  config: () => NotifyConfig
  wxpusherToken: () => string | null
  pushplusToken?: () => string | null
  ntfyAuth: () => string | null
  feishuSecret: () => string | null
  webhookAuthorization: () => string | null
  fetch: typeof fetch
  logger: Logger
}

export function makePushNotifiers(deps: PushNotifierDeps): Notifier[] {
  return [
    new WxPusherNotifier(deps),
    new PushPlusNotifier(deps),
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
      const response = await client.send(message.title, wxpusherBody(message), {
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

class PushPlusNotifier implements Notifier {
  readonly channel = 'pushplus' as const
  private readonly deps: PushNotifierDeps

  constructor(deps: PushNotifierDeps) {
    this.deps = deps
  }

  async send(message: NotifyMessage): Promise<DeliveryResult> {
    const config = this.deps.config().pushplus
    const token = this.deps.pushplusToken?.() ?? null
    if (!config.enabled) return failed('PushPlus 已关闭')
    if (token === null || token === '') return failed('PushPlus token 未配置')

    try {
      const response = await this.deps.fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          token,
          title: message.title,
          content: pushplusBody(message),
          template: 'markdown',
          channel: config.channel,
          ...(config.topic === '' ? {} : { topic: config.topic }),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      return await pushplusResult(response)
    } catch (error) {
      return caught(this.deps.logger, this.channel, error)
    }
  }

  test(): Promise<DeliveryResult> {
    return this.send(testMessage('PushPlus'))
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
      const headers: Record<string, string> = {
        'content-type': 'text/plain; charset=utf-8',
        'x-title': rfc2047(message.title),
        'x-markdown': 'true',
        ...(auth === null || auth === '' ? {} : { authorization: auth }),
        ...(message.url === null ? {} : { 'x-click': message.url }),
        ...(message.imageUrl === null
          ? {}
          : {
              'x-attach': message.imageUrl,
              'x-filename': imageFilename(message.imageUrl),
              'x-icon': message.imageUrl,
            }),
        ...(message.group === null ? {} : { 'x-tags': message.kind === 'alert' ? 'warning' : 'movie_camera' }),
      }
      const response = await this.deps.fetch(new URL(config.topic, trailingSlash(config.server)), {
        method: 'POST',
        headers,
        body: ntfyBody(message.body),
        signal: AbortSignal.timeout(15_000),
      })
      return await ntfyResult(response)
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
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0

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
      const accessToken = await this.token(config.appId, secret)
      const imageKey =
        message.imageUrl === null
          ? null
          : await this.uploadImage(accessToken, message.imageUrl).catch((error) => {
              this.deps.logger.warn(
                { channel: this.channel, imageUrl: message.imageUrl, err: errorMessage(error) },
                '通知图片上传失败，继续发送无图卡片',
              )
              return null
            })
      const url = new URL('https://open.feishu.cn/open-apis/im/v1/messages')
      url.searchParams.set('receive_id_type', config.receiveIdType)
      const response = await this.deps.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: config.receiveId,
          msg_type: 'interactive',
          content: JSON.stringify(feishuCard(message, imageKey)),
          ...(message.group === null ? {} : { uuid: `${message.group}:${message.kind}` }),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      return feishuResult(response, await response.json())
    } catch (error) {
      return caught(this.deps.logger, this.channel, error)
    }
  }

  test(): Promise<DeliveryResult> {
    return this.send(testMessage('飞书'))
  }

  private async token(appId: string, secret: string): Promise<string> {
    if (this.accessToken !== null && Date.now() < this.accessTokenExpiresAt) return this.accessToken
    const response = await this.deps.fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: secret }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    const data = (await response.json()) as FeishuTokenResponse
    if (!response.ok || data.code !== 0 || data.tenant_access_token === undefined) {
      throw new Error(data.msg || `飞书凭证请求失败：HTTP ${response.status}`)
    }
    this.accessToken = data.tenant_access_token
    this.accessTokenExpiresAt = Date.now() + Math.max(0, (data.expire ?? 7_200) - 60) * 1_000
    return this.accessToken
  }

  private async uploadImage(accessToken: string, imageUrl: string): Promise<string> {
    const source = await this.deps.fetch(imageUrl, {
      headers: { referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!source.ok) throw new Error(`通知图片下载失败：HTTP ${source.status}`)
    const form = new FormData()
    form.set('image_type', 'message')
    form.set('image', await source.blob(), imageFilename(imageUrl))
    const response = await this.deps.fetch('https://open.feishu.cn/open-apis/im/v1/images', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await response.json()) as FeishuImageResponse
    if (!response.ok || data.code !== 0 || data.data?.image_key === undefined) {
      throw new Error(data.msg || `飞书图片上传失败：HTTP ${response.status}`)
    }
    return data.data.image_key
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

interface FeishuTokenResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

interface FeishuImageResponse {
  code?: number
  msg?: string
  data?: { image_key?: string }
}

interface FeishuMessageResponse {
  code?: number
  msg?: string
  data?: { message_id?: string }
}

async function feishuResult(response: Response, data: unknown): Promise<DeliveryResult> {
  const result = data as FeishuMessageResponse
  if (!response.ok || result.code !== 0) {
    return failed(result.msg || `HTTP ${response.status} ${response.statusText}`.trim())
  }
  return { ok: true, externalId: result.data?.message_id ?? null, error: null }
}

function wxpusherResult(response: SendResponse<WxPusherResponse>): DeliveryResult {
  const data = response.data
  if (response.status < 200 || response.status >= 300 || !data.success || data.code !== 1000) {
    return failed(data.msg || `${response.status} ${response.statusText}`)
  }
  return { ok: true, externalId: String(data.data.messageId), error: null }
}

async function pushplusResult(response: Response): Promise<DeliveryResult> {
  const data = (await response.json()) as { code?: unknown; msg?: unknown; data?: unknown }
  if (!response.ok || data.code !== 200) {
    return failed(typeof data.msg === 'string' && data.msg !== '' ? data.msg : `HTTP ${response.status}`)
  }
  const externalId =
    typeof data.data === 'string' || typeof data.data === 'number' ? String(data.data) : null
  return { ok: true, externalId, error: null }
}

async function ntfyResult(response: Response): Promise<DeliveryResult> {
  const text = await response.text()
  let data: { id?: unknown; error?: unknown } = {}
  try {
    data = JSON.parse(text) as { id?: unknown; error?: unknown }
  } catch {
    // 非 JSON 错误页仍按 HTTP 状态返回。
  }
  if (!response.ok || typeof data.id !== 'string' || data.id === '') {
    const detail = typeof data.error === 'string' && data.error !== '' ? `：${data.error}` : ''
    return failed(`HTTP ${response.status} ${response.statusText}${detail}`.trim())
  }
  return { ok: true, externalId: data.id, error: null }
}

function pushplusBody(message: NotifyMessage): string {
  const parts = [message.body]
  if (message.imageUrl !== null) parts.push(`![${message.title}](${message.imageUrl})`)
  if (message.url !== null) parts.push(`[查看原内容](${message.url})`)
  return parts.filter((part) => part !== '').join('\n\n')
}

function wxpusherBody(message: NotifyMessage): string {
  if (message.imageUrl === null) return message.body
  return `![${message.title}](${message.imageUrl})\n\n${message.body}`
}

interface FeishuCard {
  schema: '2.0'
  config: { update_multi: true }
  header: {
    title: { tag: 'plain_text'; content: string }
    template: 'blue' | 'green' | 'red'
  }
  body: { elements: FeishuElement[] }
}

type FeishuElement =
  | { tag: 'markdown'; content: string }
  | { tag: 'img'; img_key: string; alt: { tag: 'plain_text'; content: string } }
  | {
      tag: 'button'
      text: { tag: 'plain_text'; content: string }
      type: 'primary'
      width: 'fill'
      behaviors: [{ type: 'open_url'; default_url: string }]
    }

function feishuCard(message: NotifyMessage, imageKey: string | null): FeishuCard {
  const elements: FeishuElement[] = []
  if (imageKey !== null) {
    elements.push({
      tag: 'img',
      img_key: imageKey,
      alt: { tag: 'plain_text', content: message.title },
    })
  }
  if (message.body !== '') elements.push({ tag: 'markdown', content: message.body })
  if (message.url !== null) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '查看原内容' },
      type: 'primary',
      width: 'fill',
      behaviors: [{ type: 'open_url', default_url: message.url }],
    })
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: message.title },
      template: message.kind === 'alert' ? 'red' : message.kind === 'summary' ? 'green' : 'blue',
    },
    body: { elements },
  }
}

function imageFilename(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').at(-1)
    return name === undefined || name === '' ? 'cover.jpg' : name
  } catch {
    return 'cover.jpg'
  }
}

function testMessage(channel: string): NotifyMessage {
  return {
    kind: 'alert',
    title: `Bili Video · ${channel} 测试`,
    body: '推送通道可用。',
    url: null,
    imageUrl: null,
    group: null,
  }
}

function summary(title: string): string {
  return title.length > 20 ? `${title.slice(0, 19)}…` : title
}

const NTFY_MESSAGE_BYTES = 4_096
const NTFY_TRUNCATED = '\n\n…（正文过长，已截断）'

function ntfyBody(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= NTFY_MESSAGE_BYTES) return value
  const bytes = Buffer.from(value, 'utf8')
  let end = NTFY_MESSAGE_BYTES - Buffer.byteLength(NTFY_TRUNCATED, 'utf8')
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}${NTFY_TRUNCATED}`
}

function rfc2047(value: string): string {
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
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
