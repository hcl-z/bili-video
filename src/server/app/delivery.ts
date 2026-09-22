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

export class DeliveryService {
  private readonly deps: DeliveryDeps
  private readonly logger: Logger
  private readonly running = new Set<Promise<void>>()
  private cancelEvents: Cancel | null = null
  private cancelCron: Cancel | null = null

  constructor(deps: DeliveryDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'delivery' })
  }

  start(): void {
    if (this.cancelEvents !== null) return
    this.cancelEvents = this.deps.events.on((event) => {
      if (event.type === 'update.new') this.spawn(this.offerDiscover(event.dynId))
      if (event.type === 'summary.done') this.spawn(this.offerSummary(event.bvid))
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
    if (this.isQuiet()) return
    for (const delivery of this.deps.deliveries.pending(100)) {
      if (delivery.kind !== 'discover' && delivery.kind !== 'summary') continue
      if (!this.channelEnabled(delivery.channel)) continue
      await this.sendClaimed(delivery, this.message(delivery.updateId, delivery.kind))
    }
  }

  private async offerDiscover(dynId: string): Promise<void> {
    const update = this.deps.updates.get(dynId)
    if (update === null || !this.shouldNotify(update)) return
    await this.offer(update, 'discover', discoverMessage(update, this.upName(update.uid)))
  }

  private async offerSummary(bvid: string): Promise<void> {
    const update = this.deps.updates.getByBvid(bvid)
    const summary = this.deps.summaries.get(bvid)
    if (update === null || summary === null || !this.shouldNotify(update)) return
    await this.offer(update, 'summary', {
      kind: 'summary',
      title: `${this.upName(update.uid)} · ${update.title ?? bvid}`,
      body: summary.fullMd,
      url: update.url,
      imageUrl: update.cover,
      group: update.dynId,
    })
  }

  private async offer(update: Update, kind: 'discover' | 'summary', message: NotifyMessage): Promise<void> {
    for (const notifier of this.enabledNotifiers()) {
      const key = { updateId: update.dynId, channel: notifier.channel, kind }
      if (!this.deps.deliveries.claim({ ...key, at: this.deps.clock.now() })) continue
      if (this.isQuiet()) continue
      await this.sendClaimed(key, message)
    }
  }

  private async sendClaimed(delivery: Pick<DeliveryRecord, 'updateId' | 'channel' | 'kind'>, message: NotifyMessage | null): Promise<void> {
    const key = { updateId: delivery.updateId, channel: delivery.channel, kind: delivery.kind }
    const notifier = this.deps.notifiers.find((candidate) => candidate.channel === delivery.channel)
    if (notifier === undefined || message === null) {
      this.deps.deliveries.settle(key, { status: 'failed', error: '投递内容或渠道不存在' }, this.deps.clock.now())
      return
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
  }

  private message(updateId: string, kind: DeliveryKind): NotifyMessage | null {
    const update = this.deps.updates.get(updateId)
    if (update === null) return null
    if (kind === 'discover') return discoverMessage(update, this.upName(update.uid))
    if (kind !== 'summary' || update.bvid === null) return null
    const summary = this.deps.summaries.get(update.bvid)
    if (summary === null) return null
    return {
      kind,
      title: `${this.upName(update.uid)} · ${update.title ?? update.bvid}`,
      body: summary.fullMd,
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
