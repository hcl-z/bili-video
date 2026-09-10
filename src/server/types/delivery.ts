import type { DeliveryKind } from '#shared/contract/job.ts'

/** 渠道是一个接口的多个实现，以后加 Bark / Telegram 不用改编排逻辑 */
export interface Notifier {
  readonly channel: NotifyChannel
  send(msg: NotifyMessage): Promise<DeliveryResult>
  /** 页面上「发送测试」按钮走应项 */
  test(): Promise<DeliveryResult>
}

export type NotifyChannel = 'wxpusher' | 'pushplus' | 'ntfy' | 'feishu' | 'webhook'

export interface NotifyMessage {
  kind: DeliveryKind
  title: string

  body: string

  url: string | null

  imageUrl: string | null

  group: string | null
}

export interface DeliveryResult {
  ok: boolean

  externalId: string | null
  error: string | null
}

/** 总结落盘。返回真实写入的路径 —— 「文件到底在哪」是要显示给查看的， 不应让调用方再自己拼一次目录 */
export interface MarkdownWriter {
  write(name: string, content: string): Promise<string>
}

/** 磁盘占用。是依赖接口而不是直接 statSync：系统页要显示「库和产物一共吃了多少」， 而这几个路径只有组装根知道 —— 让路由层自己去拼 dataDir 会把布局知识散出去 */
export interface StorageStats {
  usage(): Promise<DiskUsage>
}

export interface DiskUsage {
  /** 数据库文件本体加 WAL/SHM —— 它们一起决定「库占了多大」 */
  dbBytes: number
  audioBytes: number
  markdownBytes: number
  audioDir: string
  markdownDir: string
}
