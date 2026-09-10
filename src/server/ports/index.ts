import type { ProbeResult } from '#shared/contract/probe.ts'
import type { Asr } from './asr.ts'
import type { AudioDownloader } from './audio.ts'
import type {
  BiliAuth,
  BiliProfile,
  BiliReader,
  BiliRelationWriter,
  SubtitleFetcher,
} from './bili.ts'
import type { Clock } from './clock.ts'
import type { ConfigStore } from './config-store.ts'
import type { EventBus } from './event-bus.ts'
import type { Llm } from './llm.ts'
import type { Logger } from './logger.ts'
import type { RuntimeInfo } from './runtime.ts'
import type { MarkdownWriter } from './markdown.ts'
import type { Notifier } from './notifier.ts'
import type { StorageStats } from './storage.ts'
import type {
  AnchorRepo,
  DeliveryRepo,
  FilterRuleRepo,
  JobArtifactRepo,
  JobRepo,
  LlmCallRepo,
  SubscriptionRepo,
  SummaryRepo,
  UpdateRepo,
  WriteAuditRepo,
} from './repo.ts'
import type { CookieJar } from './cookie-jar.ts'
import type { SecretStore } from './secret-store.ts'
import type { StateRepo } from './state.ts'

export type * from './asr.ts'
export type * from './cookie-jar.ts'
export type * from './state.ts'
export type * from './audio.ts'
export type * from './bili.ts'
export type * from './clock.ts'
export type * from './command.ts'
export type * from './config-store.ts'
export type * from './event-bus.ts'
export type * from './llm.ts'
export type * from './logger.ts'
export type * from './markdown.ts'
export type * from './notifier.ts'
export type * from './repo.ts'
export type * from './runtime.ts'
export type * from './secret-store.ts'
export type * from './storage.ts'

/** 窄仓储打成一包只是为了少写一串构造参数；它们仍然是各自独立的接口。 */
export interface Repos {
  subscriptions: SubscriptionRepo
  rules: FilterRuleRepo
  anchors: AnchorRepo
  updates: UpdateRepo
  jobs: JobRepo
  /** 流水线每一步的产物。「从任意一步重跑」全靠它。 */
  artifacts: JobArtifactRepo
  summaries: SummaryRepo
  deliveries: DeliveryRepo
  llmCalls: LlmCallRepo
  /** 写接口的账本。只有「自动关注」往里写，读接口一条都不进。 */
  writeAudit: WriteAuditRepo
}

/**
 * 进程边界之外的适配器。测试里换掉的就是这一组（多数换假件，有几个用真适配器 + 假 fetch）。
 *
 * `| null` 不是「可选功能」，而是「这一票还没做」：每个后续 ticket 落地一个适配器就
 * 去掉一个 null，于是「系统还缺哪块」在类型上一眼可见，而不是散落在各处的 TODO。
 *
 * 四个 B 站适配器分别列在这里而不是打成一包：它们分属不同 ticket，
 * 打包会逼着「登录做完了但读接口还没做」也只能填 null，那个 null 就不再有信息量了。
 */
export interface ExternalPorts {
  notifiers: Notifier[]
  biliAuth: BiliAuth | null
  biliReader: BiliReader | null
  biliRelations: BiliRelationWriter | null
  /** UP 主名片（昵称、头像）。订阅页要显示它们。 */
  biliProfile: BiliProfile | null
  subtitles: SubtitleFetcher | null
  asr: Asr | null
  llm: Llm | null
  audio: AudioDownloader | null
  /**
   * ASR 的连通性测试。不放在 Asr 上：mlx-audio 那条路探的是本地 Python 模块，
   * 跟转写本身不是同一个边界，而 Asr 适配器要到票 10 才有。
   */
  probeAsr: (() => Promise<ProbeResult>) | null
}

/**
 * 组装根的全部入参。除了这里列出的东西，服务内部不许再 new 任何实现，
 * 也没有模块级单例 —— 这条是主测试缝能立住的前提。
 */
export interface Ports {
  version: string
  clock: Clock
  logger: Logger
  events: EventBus
  config: ConfigStore
  secrets: SecretStore
  repos: Repos
  /** 派生运行态：浏览器身份、登录账号、续期失败计数。不是配置。 */
  state: StateRepo
  /** cookie 罐。app 层要据此回答「还有多久到期」，所以它必须在组装根可见。 */
  cookies: CookieJar
  /** 总结落盘。不进 external 是因为它没有「这一票还没做」这个状态，永远在。 */
  markdown: MarkdownWriter
  /** 磁盘占用。系统页要显示库和产物一共吃了多少。 */
  storage: StorageStats
  runtime: RuntimeInfo
  external: ExternalPorts
}
