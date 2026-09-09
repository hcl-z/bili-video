import type { VideoUsage } from '#shared/contract/api.ts'
import type { FilterRule, RuleKind, Subscription } from '#shared/contract/subscription.ts'
import type { Update, UpdateWithRaw } from '#shared/contract/update.ts'
import type {
  DeliveryKind,
  DeliveryStatus,
  JobStage,
  PipelineStep,
  StepStatus,
  SummaryJob,
} from '#shared/contract/job.ts'
import type { Summary } from '#shared/contract/summary.ts'
import type { ArtifactKind } from '../domain/pipeline.ts'
import type { NotifyChannel } from './notifier.ts'

/**
 * 8 个窄仓储，不是一个 Store 门面。门面会让 poll-once 在类型上拿到它不该碰的
 * SummaryRepo；窄接口的成本只是多几行类型声明。
 *
 * 全部同步 —— node:sqlite 是同步 API，包成 Promise 只会假装有异步边界。
 */

export interface SubscriptionRepo {
  list(): Subscription[]
  get(uid: string): Subscription | null
  upsert(sub: Omit<Subscription, 'followedAt'> & { followedAt?: number | null }): void
  remove(uid: string): void
  markFollowed(uid: string, at: number): void
}

export interface FilterRuleRepo {
  list(): FilterRule[]
  /** 'global' + 该 uid 两个 scope 的规则，实现 inherit-or-override。 */
  listEffective(uid: string): FilterRule[]
  add(rule: { scope: string; kind: RuleKind; pattern: string; enabled: boolean }): FilterRule
  setEnabled(id: number, enabled: boolean): void
  remove(id: number): void
}

/**
 * 锚点覆盖每一个订阅，哪怕推送开关关着也照常推进 —— 否则关掉开关再打开会炸出一堆积压旧动态。
 * 参考实现只有内存 Map，重启即丢，这是它的缺陷。
 */
export interface AnchorRepo {
  get(uid: string): number | null
  getAll(): Map<string, number>
  /** 只单调推进：传入的值不大于现值时忽略。 */
  advance(uid: string, pubTs: number, at: number): void
}

export interface UpdateRepo {
  /** 已存在的 dynId 直接跳过，重复轮询不会重复入库。 */
  insertMany(updates: UpdateWithRaw[]): { inserted: string[]; skipped: string[] }
  get(dynId: string): Update | null
  /** 总结是按 bvid 存的，阅读栏要反查这条视频的动态（封面、UP、被拦原因）。 */
  getByBvid(bvid: string): Update | null
  list(q: { uid?: string; includeFiltered?: boolean; limit: number; before?: number }): Update[]
  /** 按**发布时间**数，不是入库时间 —— 24h 补推窗口与溢出阈值判的是「这段时间里发了多少」。 */
  countSince(ts: number): number
  count(): number
}

export interface JobRepo {
  /** from = 这一轮从哪一步开始；缺省从头。 */
  enqueue(job: { bvid: string; updateId: string; at: number; from?: PipelineStep | null }): SummaryJob
  get(id: number): SummaryJob | null
  getByBvid(bvid: string): SummaryJob | null
  /** 取一条 pending 置为 running（单进程内加锁即可，不需要 SKIP LOCKED）。 */
  claimNext(at: number): SummaryJob | null
  setStage(id: number, stage: JobStage, at: number): void
  finish(id: number, outcome: { ok: true } | { ok: false; error: string }, at: number): void
  /** 启动时把崩在中途的 running 重置为 pending 续跑。 */
  resetRunning(at: number): number
  list(q: { status?: SummaryJob['status']; limit: number }): SummaryJob[]
  /** 各状态各几条。概览页要的是数字，不该为了数一下把几千行拉回来。 */
  counts(): Record<SummaryJob['status'], number>
  /** 在跑的任务停在哪几步。概览页据此把在飞的分到两条泳道上。 */
  runningStages(): JobStage[]

  /** 一步的状态。重跑时只复位 from 及其之后的几步，前面的留着给人看「上次到哪了」。 */
  setStep(jobId: number, step: PipelineStep, status: StepStatus, note: string | null, at: number): void
  resetStepsFrom(jobId: number, from: PipelineStep, at: number): void
  /**
   * 某一步最近几次的结果，新的在前。健康自查用它数「连续失败几次」。
   *
   * 落库而不是在内存里记计数：重启不该把「转写已经连着失败三次了」这件事忘掉。
   */
  recentSteps(step: PipelineStep, limit: number): JobStepOutcome[]
}

export interface JobStepOutcome {
  status: StepStatus
  note: string | null
  at: number
}

/**
 * 每一步的产物：转写文本、分段要点、待落库的草稿。
 *
 * 它就是「从任意一步重跑」的前提 —— 没有它，从 reduce 重跑还要重新取一遍字幕、
 * 重新调一遍分段。按 bvid 存，因为一个 bvid 只有一条任务。
 */
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
  /** transcript 单独传：它可能有几万字，不值得塞进到处传递的 Summary 里。 */
  upsert(summary: Summary, transcript?: string | null): void
  /** 完整字幕/转写全文。同样单独读，别让列表页顺手把几万字捎出来。 */
  transcript(bvid: string): string | null
  list(q: { limit: number; before?: number }): Summary[]
  count(): number
}

export interface DeliveryRepo {
  /** 唯一索引 (update_id, channel, kind)：重复投递直接被库挡掉，返回 false。 */
  claim(d: { updateId: string; channel: NotifyChannel; kind: DeliveryKind; at: number }): boolean
  settle(
    d: { updateId: string; channel: NotifyChannel; kind: DeliveryKind },
    outcome: { status: DeliveryStatus; error: string | null },
    at: number,
  ): void
  listForUpdate(updateId: string): DeliveryRecord[]
  /** 静默时段结束后再推；失败投递由下一轮显式 claim 增加 attempts 后重试。 */
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

/**
 * 写接口调用审计。和读接口彻底分开记：写接口的风控严得多，
 * 混在一起数就没法回答「这一小时到底发了几个写请求」。
 *
 * 它同时是限流的状态来源 —— 额度从这张表数出来，重启不会白送一轮额度。
 *
 * spec 的仓储清单只列了 8 个，这是第 9 个。理由是 spec 自己要求
 * `BiliRelationWriter`「单独限流与审计」，而审计要跨重启就得有张表；
 * 挂到别的仓储上会让「这一小时发了几个写请求」变成一句 SQL 猜谜。
 */
export interface WriteAuditRepo {
  record(call: NewWriteCall): void
  countSince(ts: number): number
  /** 最近一次写调用的时刻，用来卡最小间隔。null = 从来没写过。 */
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

/** 待写入的一笔。id 是库给的，别处不许自己编。 */
export type NewWriteCall = Omit<WriteCallRecord, 'id'>

/** 只记账不拦截。分段总结一次视频会调多次，逐次记才算得准。 */
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
