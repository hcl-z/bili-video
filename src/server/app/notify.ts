import type {
  NotifySettingsResponse,
  NotifyTestResponse,
  PatchNotifySettingsRequest,
  SecretState,
} from '#shared/contract/api.ts'
import { NotifyConfigSchema } from '#shared/contract/config.ts'
import { secretWrite } from '../domain/secret-write.ts'
import type { ConfigStore } from '../ports/config-store.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Logger } from '../ports/logger.ts'
import type { Notifier, NotifyChannel } from '../ports/notifier.ts'
import type { SecretKey, SecretStore } from '../ports/secret-store.ts'

export const WXPUSHER_APP_TOKEN: SecretKey = 'wxpusher-app-token'
export const PUSHPLUS_TOKEN: SecretKey = 'pushplus-token'
export const NTFY_AUTH: SecretKey = 'ntfy-auth'
export const FEISHU_APP_SECRET: SecretKey = 'feishu-app-secret'
export const WEBHOOK_AUTHORIZATION: SecretKey = 'webhook-authorization'

export interface NotifyDeps {
  config: ConfigStore
  secrets: SecretStore
  notifiers: Notifier[]
  events: EventBus
  logger: Logger
}

export class NotifyService {
  private readonly deps: NotifyDeps
  private readonly logger: Logger

  constructor(deps: NotifyDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'notify' })
  }

  settings(): NotifySettingsResponse {
    const notify = this.deps.config.getSection('notify')
    const wxpusherToken = this.describe(WXPUSHER_APP_TOKEN)
    const pushplusToken = this.describe(PUSHPLUS_TOKEN)
    const ntfyAuth = this.describe(NTFY_AUTH)
    const feishuSecret = this.describe(FEISHU_APP_SECRET)
    const webhookAuthorization = this.describe(WEBHOOK_AUTHORIZATION)
    const configured = {
      wxpusher: wxpusherToken.configured && notify.wxpusher.uids.length > 0,
      pushplus: pushplusToken.configured,
      ntfy: notify.ntfy.server !== '' && notify.ntfy.topic !== '',
      feishu:
        feishuSecret.configured && notify.feishu.appId !== '' && notify.feishu.receiveId !== '',
      webhook: notify.webhook.url !== '',
    }
    return {
      notify,
      wxpusherToken,
      pushplusToken,
      ntfyAuth,
      feishuSecret,
      webhookAuthorization,
      targets: {
        wxpusher: state(notify.wxpusher.enabled, configured.wxpusher),
        pushplus: state(notify.pushplus.enabled, configured.pushplus),
        ntfy: state(notify.ntfy.enabled, configured.ntfy),
        feishu: state(notify.feishu.enabled, configured.feishu),
        webhook: state(notify.webhook.enabled, configured.webhook),
      },
    }
  }

  patch(patch: PatchNotifySettingsRequest): NotifySettingsResponse {
    if (patch.notify !== undefined) {
      const current = this.deps.config.getSection('notify')
      const merged = NotifyConfigSchema.parse({
        ...current,
        ...patch.notify,
        wxpusher: { ...current.wxpusher, ...patch.notify.wxpusher },
        pushplus: { ...current.pushplus, ...patch.notify.pushplus },
        ntfy: { ...current.ntfy, ...patch.notify.ntfy },
        feishu: { ...current.feishu, ...patch.notify.feishu },
        webhook: { ...current.webhook, ...patch.notify.webhook },
      })
      this.deps.config.setSection('notify', merged)
      this.deps.events.emit({ type: 'config.changed', section: 'notify' })
    }
    this.applySecret(WXPUSHER_APP_TOKEN, patch.wxpusherToken)
    this.applySecret(PUSHPLUS_TOKEN, patch.pushplusToken)
    this.applySecret(NTFY_AUTH, patch.ntfyAuth)
    this.applySecret(FEISHU_APP_SECRET, patch.feishuSecret)
    this.applySecret(WEBHOOK_AUTHORIZATION, patch.webhookAuthorization)
    return this.settings()
  }

  async test(channel: NotifyChannel): Promise<NotifyTestResponse> {
    const notifier = this.deps.notifiers.find((candidate) => candidate.channel === channel)
    const result =
      notifier === undefined
        ? { ok: false, externalId: null, error: `${channel} 适配器没接入这个进程` }
        : await notifier.test()
    this.logger.info({ channel, ok: result.ok, err: result.error }, '推送连通性测试完成')
    return { channel, result }
  }

  private applySecret(key: SecretKey, input: string | null | undefined): void {
    const write = secretWrite(input, this.deps.secrets.describe(key)?.masked ?? null)
    if (write.action === 'keep') return
    if (write.action === 'clear') {
      this.deps.secrets.delete(key)
      this.logger.info({ key }, '推送凭据已清空')
      return
    }
    this.deps.secrets.set(key, write.value)
    this.logger.info({ key }, '推送凭据已更新')
  }

  private describe(key: SecretKey): SecretState {
    const description = this.deps.secrets.describe(key)
    if (description === null) return { configured: false, masked: null, updatedAt: null }
    return {
      configured: true,
      masked: description.masked,
      updatedAt: description.updatedAt,
    }
  }
}

function state(enabled: boolean, configured: boolean) {
  return { enabled, configured, ready: enabled && configured }
}
