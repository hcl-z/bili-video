import type { ProbeResult } from '#shared/contract/probe.ts'
import type { Asr, AudioDownloader, Llm } from './ai.ts'
import type { BiliAuth, BiliProfile, BiliReader, BiliRelationWriter, CookieJar, SubtitleFetcher } from './bili.ts'
import type { MarkdownWriter, Notifier, StorageStats } from './delivery.ts'
import type {
  AnchorRepo,
  ConfigStore,
  DeliveryRepo,
  FilterRuleRepo,
  JobArtifactRepo,
  JobRepo,
  LlmCallRepo,
  SecretStore,
  StateRepo,
  SubscriptionRepo,
  SummaryRepo,
  UpdateRepo,
  WriteAuditRepo,
} from './persistence.ts'
import type { Clock, EventBus, Logger, RuntimeInfo } from './platform.ts'

export type * from './ai.ts'
export type * from './bili.ts'
export type * from './delivery.ts'
export type * from './persistence.ts'
export type * from './platform.ts'

export interface Repos {
  subscriptions: SubscriptionRepo
  rules: FilterRuleRepo
  anchors: AnchorRepo
  updates: UpdateRepo
  jobs: JobRepo
  artifacts: JobArtifactRepo
  summaries: SummaryRepo
  deliveries: DeliveryRepo
  llmCalls: LlmCallRepo
  writeAudit: WriteAuditRepo
}

export interface ExternalDeps {
  notifiers: Notifier[]
  biliAuth: BiliAuth | null
  biliReader: BiliReader | null
  biliRelations: BiliRelationWriter | null
  biliProfile: BiliProfile | null
  subtitles: SubtitleFetcher | null
  asr: Asr | null
  llm: Llm | null
  audio: AudioDownloader | null
  probeAsr: (() => Promise<ProbeResult>) | null
}

export interface ServerDeps {
  version: string
  clock: Clock
  logger: Logger
  events: EventBus
  config: ConfigStore
  secrets: SecretStore
  repos: Repos
  state: StateRepo
  cookies: CookieJar
  markdown: MarkdownWriter
  storage: StorageStats
  runtime: RuntimeInfo
  external: ExternalDeps
}
