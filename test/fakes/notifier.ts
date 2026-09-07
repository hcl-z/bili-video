import type {
  DeliveryResult,
  Notifier,
  NotifyChannel,
  NotifyMessage,
} from '../../src/server/ports/notifier.ts'

/**
 * 记录型通知器。两段推送、投递去重、免扰时段、告警只发一次 —— 这些全靠断言它收到了什么。
 */
export class RecordingNotifier implements Notifier {
  readonly channel: NotifyChannel
  readonly sent: NotifyMessage[] = []
  /** 置为非 null 时，send 一律失败，用来测重试与投递记账。 */
  failWith: string | null = null

  constructor(channel: NotifyChannel = 'ntfy') {
    this.channel = channel
  }

  async send(msg: NotifyMessage): Promise<DeliveryResult> {
    if (this.failWith !== null) {
      return { ok: false, externalId: null, error: this.failWith }
    }
    this.sent.push(msg)
    return { ok: true, externalId: `fake-${this.sent.length}`, error: null }
  }

  async test(): Promise<DeliveryResult> {
    return this.send({
      kind: 'alert',
      title: 'test',
      body: 'test',
      url: null,
      group: null,
    })
  }

  titles(): string[] {
    return this.sent.map((m) => m.title)
  }
}
