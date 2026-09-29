import { inQuietHours } from '../domain/filter.ts'
import { errFields } from '../log-fields.ts'
import type { Cancel, Clock } from '../types/platform.ts'
import type { ConfigStore } from '../types/persistence.ts'
import type { EventBus } from '../types/platform.ts'
import type { Logger } from '../types/platform.ts'
import type { Notifier, NotifyChannel, NotifyMessage } from '../types/delivery.ts'
import type {
  DeliveryRecord,
  DeliveryRepo,
  SubscriptionRepo,
  SummaryRepo,
  UpdateRepo,
} from '../types/persistence.ts'
import type { DeliveryKind } from '#shared/contract/job.ts'
import type { Update } from '#shared/contract/update.ts'

export interface PushOutcome {
  sent: number
  failed: number
  /** 没发也没失败：静默时段占位、没有启用渠道、或这条不该推 */
  skipped: boolean
}

export interface DeliveryDeps {
  updates: UpdateRepo
  summaries: SummaryRepo
  subscriptions: SubscriptionRepo
  deliveries: DeliveryRepo
  notifiers: Notifier[]
  config: ConfigStore
  clock: Clock
  events: EventBus
  logger: Logger
}

/** 静默期间待补推的失败提示暂存上限，防无限增长 */
const ALERT_CACHE_MAX = 200

export class DeliveryService {
  private readonly deps: DeliveryDeps
  private readonly logger: Logger
  private readonly running = new Set<Promise<void>>()
  private readonly alerts = new Map<string, NotifyMessage>()
  private cancelEvents: Cancel | null = null
  private cancelCron: Cancel | null = null

  constructor(deps: DeliveryDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'delivery' })
  }

  start(): void {
    if (this.cancelEvents !== null) return
    // 总结推送不在这里订阅事件：它是流水线的最后一步（push），由队列同步调 pushSummary。
    // 发现通知不在流水线里，仍然走事件。
    this.cancelEvents = this.deps.events.on((event) => {
      if (event.type === 'update.new') this.spawn(this.offerDiscover(event.dynId))
    })
    this.cancelCron = this.deps.clock.schedule('0 * * * * *', () => this.flush())
    this.spawn(this.flush())
  }

  stop(): void {
    this.cancelEvents?.()
    this.cancelEvents = null
    this.cancelCron?.()
    this.cancelCron = null
  }

  async drain(): Promise<void> {
    await Promise.all([...this.running])
  }

  async flush(): Promise<void> {
    // 静默与不静默只在这里判一次：循环中途跨过静默边界不该让同一次 flush 里的后半段行为不一致。
    const quiet = this.isQuiet()
    if (quiet) return
    for (const delivery of this.deps.deliveries.pending(100)) {
      if (delivery.kind === 'alert') {
        // 静默期间占位的失败提示。它不依赖 update 行，单独补发。
        await this.sendClaimed(delivery, this.alertMessage(delivery.updateId))
        continue
      }
      if (delivery.kind !== 'discover' && delivery.kind !== 'summary') continue
      if (!this.channelEnabled(delivery.channel)) continue
      await this.sendClaimed(delivery, this.message(delivery.updateId, delivery.kind))
    }
  }

  /**
   * 流水线最后一步调的同步推送。返回实际发送结果，调用方据此标 job_steps。
   * 静默时段不出网，只占位（deliveries 落 pending），由 flush 在静默结束后补推。
   */
  async pushSummary(bvid: string): Promise<PushOutcome> {
    const update = this.deps.updates.getByBvid(bvid)
    const fullMd = this.pushable(bvid)
    if (update === null || fullMd === null || !this.shouldNotify(update)) {
      return { sent: 0, failed: 0, skipped: true }
    }

    const enabled = this.enabledNotifiers()
    if (enabled.length === 0) return { sent: 0, failed: 0, skipped: true }

    const quiet = this.isQuiet()
    const message = this.summaryMessage(update, bvid, fullMd)
    let sent = 0
    let failed = 0
    for (const notifier of enabled) {
      const key = { updateId: update.dynId, channel: notifier.channel, kind: 'summary' as const }
      if (!this.deps.deliveries.claim({ ...key, at: this.deps.clock.now() })) {
        // 已发过的不再发：它上次成功了，重发是同一条内容。
        sent += 1
        continue
      }
      if (quiet) continue
      const ok = await this.sendClaimed(key, message)
      if (ok) sent += 1
      else failed += 1
    }
    return { sent, failed, skipped: quiet && sent === 0 && failed === 0 }
  }

  /**
   * 重试耗尽后的错误提示。键用 `job:${updateId}` 而不是视频的 dynId：
   * 它和这条视频的 discover / summary 是三条互不覆盖的记录，且同一视频反复失败只会推一条。
   */
  async notifyJobFailure(input: {
    updateId: string
    title: string
    reason: string
    retries: number
  }): Promise<void> {
    const body = `${input.reason}\n\n已重试 ${input.retries} 次仍未成功。`
    const keyId = `job:${input.updateId}`

    for (const notifier of this.enabledNotifiers()) {
      const key = { updateId: keyId, channel: notifier.channel, kind: 'alert' as const }
      if (!this.deps.deliveries.claim({ ...key, at: this.deps.clock.now() })) continue
      // 静默期间只占位：标题和正文能从备份里重建，所以丢了内容参数也不会丢这条提示。
      this.rememberAlert(keyId, {
        kind: 'alert',
        title: input.title,
        body,
        url: null,
        imageUrl: null,
        group: keyId,
      })
      if (this.isQuiet()) continue
      await this.sendClaimed(key, this.alertMessage(keyId, input.title, body))
    }
  }

  /** 失败提示的正文不落库，静默跨重启后重建成最小形式 —— 宁可少一句细节，也不能把提示弄丢。 */
  private alertMessage(updateId: string, title?: string, body?: string): NotifyMessage {
    const cached = this.alerts.get(updateId)
    const fallbackTitle = title ?? `【失败】${updateId.replace(/^job:/, '')}`
    return cached ?? {
      kind: 'alert',
      title: fallbackTitle,
      body: body ?? '这条没能生成总结，去流水线页看失败原因。',
      url: null,
      imageUrl: null,
      group: updateId,
    }
  }

  private rememberAlert(updateId: string, message: NotifyMessage): void {
    this.alerts.set(updateId, message)
    if (this.alerts.size > ALERT_CACHE_MAX) {
      const oldest = this.alerts.keys().next()
      if (oldest.done !== true) this.alerts.delete(oldest.value)
    }
  }

  private async offerDiscover(dynId: string): Promise<void> {
    const update = this.deps.updates.get(dynId)
    if (update === null || !this.shouldNotify(update)) return
    await this.offer(update, 'discover', discoverMessage(update, this.upName(update.uid)))
  }

  /**
   * 只有真拿到转写的总结才值得推。
   * meta-only / link-only 是升级前的历史记录，它们不该因为清理旧 pending 记录而被翻出来发出去。
   */
  private pushable(bvid: string): string | null {
    const summary = this.deps.summaries.get(bvid)
    if (summary === null) return null
    if (summary.degradePath === 'meta-only' || summary.degradePath === 'link-only') return null
    return summary.fullMd
  }

  private summaryMessage(update: Update, bvid: string, fullMd: string): NotifyMessage {
    return {
      kind: 'summary',
      title: `${this.upName(update.uid)} · ${update.title ?? bvid}`,
      body: fullMd,
      url: update.url,
      imageUrl: update.cover,
      group: update.dynId,
    }
  }

  private async offer(update: Update, kind: 'discover' | 'summary', message: NotifyMessage): Promise<void> {
    for (const notifier of this.enabledNotifiers()) {
      const key = { updateId: update.dynId, channel: notifier.channel, kind }
      if (!this.deps.deliveries.claim({ ...key, at: this.deps.clock.now() })) continue
      if (this.isQuiet()) continue
      await this.sendClaimed(key, message)
    }
  }

  private async sendClaimed(delivery: Pick<DeliveryRecord, 'updateId' | 'channel' | 'kind'>, message: NotifyMessage | null): Promise<boolean> {
    const key = { updateId: delivery.updateId, channel: delivery.channel, kind: delivery.kind }
    const notifier = this.deps.notifiers.find((candidate) => candidate.channel === delivery.channel)
    if (notifier === undefined || message === null) {
      this.deps.deliveries.settle(key, { status: 'failed', error: '投递内容或渠道不存在' }, this.deps.clock.now())
      return false
    }
    const result = await notifier.send(message)
    this.deps.deliveries.settle(
      key,
      { status: result.ok ? 'sent' : 'failed', error: result.error },
      this.deps.clock.now(),
    )
    if (result.ok) {
      this.logger.info({ channel: notifier.channel, kind: delivery.kind, updateId: delivery.updateId, externalId: result.externalId }, '推送成功')
    } else {
      this.logger.warn({ channel: notifier.channel, kind: delivery.kind, updateId: delivery.updateId, err: result.error }, '推送失败')
    }
    return result.ok
  }

  private message(updateId: string, kind: DeliveryKind): NotifyMessage | null {
    const update = this.deps.updates.get(updateId)
    if (update === null) return null
    if (kind === 'discover') return discoverMessage(update, this.upName(update.uid))
    if (kind !== 'summary' || update.bvid === null) return null
    const fullMd = this.pushable(update.bvid)
    if (fullMd === null) return null
    return {
      kind,
      title: `${this.upName(update.uid)} · ${update.title ?? update.bvid}`,
      body: fullMd,
      url: update.url,
      imageUrl: update.cover,
      group: update.dynId,
    }
  }

  private shouldNotify(update: Update): boolean {
    if (update.filtered) return false
    const subscription = this.deps.subscriptions.get(update.uid)
    if (subscription === null) return false
    return true
  }

  private enabledNotifiers(): Notifier[] {
    return this.deps.notifiers.filter((notifier) => this.channelEnabled(notifier.channel))
  }

  private channelEnabled(channel: NotifyChannel): boolean {
    const config = this.deps.config.getSection('notify')
    if (channel === 'wxpusher') return config.wxpusher.enabled
    if (channel === 'pushplus') return config.pushplus.enabled
    if (channel === 'ntfy') return config.ntfy.enabled
    if (channel === 'feishu') return config.feishu.enabled
    return config.webhook.enabled
  }

  private isQuiet(): boolean {
    const now = new Date(this.deps.clock.now())
    return inQuietHours(
      now.getHours() * 60 + now.getMinutes(),
      this.deps.config.getSection('filter').quietHours,
    )
  }

  private upName(uid: string): string {
    return this.deps.subscriptions.get(uid)?.name ?? `UID ${uid}`
  }

  private spawn(work: Promise<void>): void {
    const guarded = work.catch((error) => {
      this.logger.error(errFields(error), '推送编排异常')
    })
    this.running.add(guarded)
    void guarded.finally(() => this.running.delete(guarded))
  }
}

function discoverMessage(update: Update, upName: string): NotifyMessage {
  const title = `${upName} 发了《${update.title ?? typeLabel(update)}》`
  const body = [update.text, update.url].filter((part): part is string => part !== null && part !== '').join('\n\n')
  return {
    kind: 'discover',
    title,
    body,
    url: update.url,
    imageUrl: update.cover,
    group: update.dynId,
  }
}

function typeLabel(update: Update): string {
  if (update.type === 'DRAW') return '新图文'
  if (update.type === 'WORD') return '新动态'
  if (update.type === 'FORWARD') return '新转发'
  if (update.type === 'ARTICLE') return '新专栏'
  if (update.type === 'LIVE') return '新直播'
  return update.bvid ?? '新视频'
}
