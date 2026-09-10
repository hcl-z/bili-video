import type { DeliveryKind } from '#shared/contract/job.ts'

/** 渠道是一个接口的多个实现，以后加 Bark / Telegram 不用改编排逻辑。 */
export interface Notifier {
  readonly channel: NotifyChannel
  send(msg: NotifyMessage): Promise<DeliveryResult>
  /** 页面上「发送测试」按钮走这条。 */
  test(): Promise<DeliveryResult>
}

export type NotifyChannel = 'wxpusher' | 'pushplus' | 'ntfy' | 'feishu' | 'webhook'

export interface NotifyMessage {
  kind: DeliveryKind
  title: string
  /** Markdown。推送正文自带完整总结 —— 手机不需要访问这个服务。 */
  body: string
  /** 点击跳转地址，通常是 B 站链接。 */
  url: string | null
  /** 视频封面或图文首图；适配器按渠道能力渲染为卡片图片或附件。 */
  imageUrl: string | null
  /** 同一条更新的两段推送用同一个 group，客户端才会折叠成一组。 */
  group: string | null
}

export interface DeliveryResult {
  ok: boolean
  /** 渠道侧的消息 id，便于对账；没有就是 null。 */
  externalId: string | null
  error: string | null
}
