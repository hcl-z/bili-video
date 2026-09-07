import type { Asr } from './asr.ts'
import type { AudioDownloader } from './audio.ts'
import type { BiliAuth, BiliReader, BiliRelationWriter, SubtitleFetcher } from './bili.ts'
import type { Clock } from './clock.ts'
import type { ConfigStore } from './config-store.ts'
import type { EventBus } from './event-bus.ts'
import type { Llm } from './llm.ts'
import type { Logger } from './logger.ts'
import type { Notifier } from './notifier.ts'
import type {
  AnchorRepo,
  DeliveryRepo,
  FilterRuleRepo,
  JobRepo,
  LlmCallRepo,
  SubscriptionRepo,
  SummaryRepo,
  UpdateRepo,
} from './repo.ts'
import type { SecretStore } from './secret-store.ts'

export type * from './asr.ts'
export type * from './audio.ts'
export type * from './bili.ts'
export type * from './clock.ts'
export type * from './config-store.ts'
export type * from './event-bus.ts'
export type * from './llm.ts'
export type * from './logger.ts'
export type * from './notifier.ts'
export type * from './repo.ts'
export type * from './secret-store.ts'

/** 8 个窄仓储打成一包只是为了少写 8 个构造参数；它们仍然是 8 个独立接口。 */
export interface Repos {
  subscriptions: SubscriptionRepo
  rules: FilterRuleRepo
  anchors: AnchorRepo
  updates: UpdateRepo
  jobs: JobRepo
  summaries: SummaryRepo
  deliveries: DeliveryRepo
  llmCalls: LlmCallRepo
}

export interface BiliPorts {
  reader: BiliReader
  auth: BiliAuth
  relations: BiliRelationWriter
  subtitles: SubtitleFetcher
}

/**
 * 进程边界之外的适配器 —— 测试里全部换成假件的就是这一组。
 *
 * `| null` 不是「可选功能」，而是「这一票还没做」：每个后续 ticket 落地一个适配器就
 * 去掉一个 null，于是「系统还缺哪块」在类型上一眼可见，而不是散落在各处的 TODO。
 */
export interface ExternalPorts {
  notifiers: Notifier[]
  bili: BiliPorts | null
  asr: Asr | null
  llm: Llm | null
  audio: AudioDownloader | null
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
  external: ExternalPorts
}
