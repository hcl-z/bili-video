import type { VideoUsage } from '#shared/contract/api.ts'
import type { AppConfig, ConfigSection } from '#shared/contract/config.ts'
import type { DeliveryKind, DeliveryStatus, JobStage, PipelineStep, StepStatus, SummaryJob } from '#shared/contract/job.ts'
import type { FilterRule, RuleKind, Subscription } from '#shared/contract/subscription.ts'
import type { Summary } from '#shared/contract/summary.ts'
import type { Update, UpdateWithRaw } from '#shared/contract/update.ts'
import type { ArtifactKind } from '../domain/pipeline.ts'
import type { NotifyChannel } from './delivery.ts'
import type { Cancel } from './platform.ts'

/** 数据库是配置的唯一真相；消费方按需读取以获得热更新后的值 */
export interface ConfigStore {
  get(): AppConfig
  getSection<K extends ConfigSection>(section: K): AppConfig[K]
  /** 写库 + 重新解析 + 通知订阅者。不需要重启 */
  setSection<K extends ConfigSection>(section: K, value: AppConfig[K]): void
  onChange(handler: (section: ConfigSection, config: AppConfig) => void): Cancel
}


export type StateKey =
  /** 序列化的 BrowserIdentity。换 UA 等于在同一个 cookie 会话里换了台电脑 */
  | 'browser-identity'
  /** 登录账号的 uid 与昵称，给 /api/system 显示，省得每次去问 B 站 */
  | 'auth-uid'
  | 'auth-uname'
  /** 连续续期失败次数。到上限就转「登录已失效」，不再无效重试 */
  | 'refresh-failures'

  | 'feed-baseline'

export interface StateRepo {
  get(key: StateKey): string | null
  set(key: StateKey, value: string): void
}

/** SESSDATA、cookie、AI apiKey 都走这里，加密落库（AES-256-GCM + scrypt）。 get() 返回明文是有意的：服务端要拿它去调 B 站和 LLM。「读取永远返回掩码」应项约束 落在 HTTP 层 —— API 只吐 describe() 的结果，表单是 write-only（提交空值表示不修改） */
export interface SecretStore {
  get(key: SecretKey): string | null
  set(key: SecretKey, value: string): void
  delete(key: SecretKey): void
  has(key: SecretKey): boolean
  /** 给页面看的安全形态：只有掩码和长度，没有明文 */
  describe(key: SecretKey): SecretDescription | null

  keys(): SecretKey[]
}

export type SecretKey = string

export interface SecretDescription {
  key: SecretKey

  masked: string
  length: number
  updatedAt: number
}

/** 8 个窄仓储，不是一个 Store 门面。门面会让 poll-once 在类型上拿到它不应碰的 SummaryRepo；窄接口的成本只是多几行类型声明。 全部同步 —— node:sqlite 是同步 API，包成 Promise 只会假装有异步边界 */

export interface SubscriptionRepo {
  list(): Subscription[]
  get(uid: string): Subscription | null
  upsert(sub: Omit<Subscription, 'followedAt'> & { followedAt?: number | null }): void
  remove(uid: string): void
  markFollowed(uid: string, at: number): void
}

export interface FilterRuleRepo {
  list(): FilterRule[]

  listEffective(uid: string): FilterRule[]
  add(rule: { scope: string; kind: RuleKind; pattern: string; enabled: boolean }): FilterRule
  setEnabled(id: number, enabled: boolean): void
  remove(id: number): void
}

/** 锚点覆盖每一个订阅，哪怕推送开关关着也照常推进 —— 否则关掉开关再打开会失败出大量积压旧动态。 参考实现只有内存 Map，重启即丢，这是它的缺陷 */
export interface AnchorRepo {
  get(uid: string): number | null
  getAll(): Map<string, number>

  advance(uid: string, pubTs: number, at: number): void
}

export interface UpdateRepo {

  insertMany(
    updates: UpdateWithRaw[],
    opts?: { inFeed?: boolean },
  ): { inserted: string[]; skipped: string[] }
  get(dynId: string): Update | null

  getByBvid(bvid: string): Update | null
  list(q: {
    uid?: string
    includeFiltered?: boolean
    feedOnly?: boolean
    limit: number
    before?: number
  }): Update[]

  countSince(ts: number): number
  count(): number
}

export interface JobRepo {

  enqueue(job: { bvid: string; updateId: string; at: number; from?: PipelineStep | null }): SummaryJob
  get(id: number): SummaryJob | null
  getByBvid(bvid: string): SummaryJob | null
  /** 取单条 pending 置为 running（单进程内加锁即可，不需要 SKIP LOCKED） */
  claimNext(at: number): SummaryJob | null
  setStage(id: number, stage: JobStage, at: number): void
  finish(id: number, outcome: { ok: true } | { ok: false; error: string }, at: number): void

  resetRunning(at: number): number
  list(q: { status?: SummaryJob['status']; limit: number }): SummaryJob[]

  counts(): Record<SummaryJob['status'], number>

  runningStages(): JobStage[]

  /** 一步的状态。重跑时只复位 from 及其之后的几步，前面的留着给查看「上次到哪了」 */
  setStep(jobId: number, step: PipelineStep, status: StepStatus, note: string | null, at: number): void
  resetStepsFrom(jobId: number, from: PipelineStep, at: number): void
  /** 某一步最近几次的结果，新的在前。健康自查用它数「连续失败几次」。 落库而不是在内存里记计数：重启不应把「转写已经连着失败三次了」这件事忘掉 */
  recentSteps(step: PipelineStep, limit: number): JobStepOutcome[]
}

export interface JobStepOutcome {
  status: StepStatus
  note: string | null
  at: number
}

/** 每一步的产物：转写文本、分段要点、待落库的草稿。 它就是「从任意一步重跑」的前提 —— 没有它，从 reduce 重跑还要重新取一次字幕、 重新调一次分段。按 bvid 存，因为一个 bvid 只有单条任务 */
export interface JobArtifactRepo {
  get(bvid: string, kind: ArtifactKind): JobArtifact | null
  put(bvid: string, kind: ArtifactKind, a: { payload: string; meta?: unknown; at: number }): void
  drop(bvid: string, kinds: readonly ArtifactKind[]): void
}

export interface JobArtifact {
  payload: string
  meta: unknown
  at: number
}

export interface SummaryRepo {
  get(bvid: string): Summary | null

  upsert(summary: Summary, transcript?: string | null): void

  transcript(bvid: string): string | null
  list(q: { limit: number; before?: number }): Summary[]
  count(): number
}

export interface DeliveryRepo {
  /** 唯一索引 (update_id, channel, kind)：重复投递直接被库挡掉，返回 false */
  claim(d: { updateId: string; channel: NotifyChannel; kind: DeliveryKind; at: number }): boolean
  settle(
    d: { updateId: string; channel: NotifyChannel; kind: DeliveryKind },
    outcome: { status: DeliveryStatus; error: string | null },
    at: number,
  ): void
  listForUpdate(updateId: string): DeliveryRecord[]
  /** 静默时段结束后再推；失败投递由下一轮显式 claim 增加 attempts 后重试 */
  retryable(limit: number): DeliveryRecord[]
  recent(limit: number): DeliveryRecord[]
}

export interface DeliveryRecord {
  id: number
  updateId: string
  channel: NotifyChannel
  kind: DeliveryKind
  status: DeliveryStatus
  attempts: number
  error: string | null
  at: number
}

/** 写接口调用审计。和读接口彻底分开记：写接口的风控严得多， 混在一起数就没法回答「这一小时到底发了几个写请求」。 它同时是限流的状态来源 —— 额度从这张表数出来，重启不会无效送一轮额度。 spec 的仓储清单只列了 8 个，这是第 9 个。理由是 spec 自己要求 `BiliRelationWriter`「单独限流与审计」，而审计要跨重启就得有张表； 挂到避免的仓储上会让「这一小时发了几个写请求」变成一句 SQL 猜谜 */
export interface WriteAuditRepo {
  record(call: NewWriteCall): void
  countSince(ts: number): number

  lastAt(): number | null
  recent(limit: number): WriteCallRecord[]
}

export interface WriteCallRecord {
  id: number
  at: number
  api: string
  target: string | null
  ok: boolean
  kind: string | null
  code: number | null
  message: string | null
}


export type NewWriteCall = Omit<WriteCallRecord, 'id'>


export interface LlmCallRepo {
  record(call: {
    bvid: string | null
    stage: string
    model: string
    inTokens: number
    outTokens: number
    ms: number
    at: number
  }): void
  usageSince(ts: number): { calls: number; inTokens: number; outTokens: number }
  usageForVideo(bvid: string): VideoUsage
}
