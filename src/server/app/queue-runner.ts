import type { Failure } from '#shared/contract/failure.ts'
import type { JobStage, PipelineStep, SummaryJob } from '#shared/contract/job.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import { staleArtifacts } from '../domain/pipeline.ts'
import { errFields, failureFields } from '../log-fields.ts'
import type { Clock } from '../ports/clock.ts'
import type { ConfigStore } from '../ports/config-store.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Llm } from '../ports/llm.ts'
import type { Logger } from '../ports/logger.ts'
import type { JobArtifactRepo, JobRepo } from '../ports/repo.ts'
import { Lane } from './lane.ts'
import type { StepHook, SummarizeVideo, Transcript } from './summarize-video.ts'

export interface QueueDeps {
  jobs: JobRepo
  artifacts: JobArtifactRepo
  summarize: SummarizeVideo
  /** ★ 总开关：null 表示 AI 关着，这时候只入队不消费。 */
  llm: () => Llm | null
  config: ConfigStore
  clock: Clock
  logger: Logger
  events: EventBus
}

/** 总结队列与轮询解耦；入队、启动和 AI 配置变更时触发 pump。 */
export class SummaryQueue {
  private readonly deps: QueueDeps
  private readonly logger: Logger
  private readonly llmLane: Lane
  private readonly running = new Map<number, Promise<void>>()
  private started = false
  private unsubscribe: (() => void) | null = null

  constructor(deps: QueueDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'queue' })
    this.llmLane = new Lane(() => deps.config.getSection('ai').llmConcurrency)
  }

  start(): void {
    if (this.started) return
    this.started = true
    // 崩在中途的 running 会永远占着位子，启动时先放回 pending。
    const revived = this.deps.jobs.resetRunning(this.deps.clock.now())
    if (revived > 0) this.logger.info({ revived }, '中断的任务已复位')

    // 订阅配置本身而不是 config.changed 事件：后者只有两条 HTTP 路径手动发。
    this.unsubscribe = this.deps.config.onChange((section) => {
      if (section !== 'ai' && section !== 'asr') return
      this.llmLane.admit()
      this.pump()
    })
    this.pump()
  }

  stop(): void {
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  enqueue(v: { bvid: string; updateId: string }): SummaryJob {
    const existing = this.deps.jobs.getByBvid(v.bvid)
    // 已有 pending 的也要踢一脚：它可能是 AI 关着的时候攒下来的。
    if (existing !== null && existing.status !== 'failed') {
      this.pump()
      return existing
    }

    const job = this.deps.jobs.enqueue({ ...v, at: this.deps.clock.now() })
    this.emit(job, 'pending', 'queued')
    this.pump()
    return job
  }

  /** 重跑 failed/done 任务；指定 from 时作废该步骤及后续产物，复用此前产物。 */
  retry(id: number, from?: PipelineStep): 'ok' | 'missing' | 'busy' {
    const job = this.deps.jobs.get(id)
    if (job === null) return 'missing'
    if (job.status === 'running' || job.status === 'pending') return 'busy'

    const at = this.deps.clock.now()
    if (from !== undefined) {
      this.deps.artifacts.drop(job.bvid, staleArtifacts(from))
      this.deps.jobs.resetStepsFrom(job.id, from, at)
    }
    this.deps.jobs.enqueue({
      bvid: job.bvid,
      updateId: job.updateId,
      at,
      from: from ?? null,
    })
    this.emit(job, 'pending', 'queued')
    this.pump()
    return 'ok'
  }

  /** 等在跑的任务收尾。测试和优雅关停用；关停要给上限，LLM 那一步可能要几十秒。 */
  async drain(timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs
    while (this.running.size > 0) {
      if (deadline !== null && Date.now() >= deadline) {
        this.logger.warn({ inflight: this.running.size, timeoutMs }, '关停超时，仍有任务在飞')
        return
      }
      await Promise.all([...this.running.values()])
    }
  }

  /**
   * 取活。在飞总数封在两条通道额度之和：取字幕不占额度，所以一条视频在等本机转写时，
   * 有字幕的视频照样能取字幕、照样能进 LLM 通道。
   */
  private pump(): void {
    if (!this.started) return
    if (this.deps.llm() === null) return // ★ 唯一的 AI 总开关闸门，见 AiService.llm

    const capacity =
      this.deps.config.getSection('asr').concurrency + this.deps.config.getSection('ai').llmConcurrency
    while (this.running.size < capacity) {
      const job = this.deps.jobs.claimNext(this.deps.clock.now())
      if (job === null) return
      this.emit(job, 'running', job.stage)
      const p = this.execute(job).finally(() => {
        this.running.delete(job.id)
        this.pump()
      })
      this.running.set(job.id, p)
    }
  }

  /** 绝不抛：一条任务炸掉不能把队列带走。 */
  private async execute(job: SummaryJob): Promise<void> {
    const from: PipelineStep = job.resumeFrom ?? 'subtitle'
    // 失败事件要报「停在哪一步」，所以跟着闭包记最后一步，别用 claimNext 那份快照。
    let at: JobStage = job.stage
    const hook: StepHook = (step, status, note) => {
      const now = this.deps.clock.now()
      this.deps.jobs.setStep(job.id, step, status, note ?? null, now)
      // 只有真在跑的那一步才算「卡在哪儿」；跳过和复用不改任务的当前位置。
      if (status === 'running') {
        at = step
        this.deps.jobs.setStage(job.id, step, now)
      }
      this.emit(job, 'running', at)
    }
    try {
      // 转写不会「失败」，只会降级 —— 拿不到语音内容照样往下走，退到简介兜底。
      // 转写内部自己排队（并发 1），队列这层不拦，否则一条长视频会把有字幕的也堵住。
      const t: Transcript = await this.deps.summarize.transcribe(job.bvid, from, hook)

      const res = await this.llmLane.run(() => this.deps.summarize.summarize(job, t, from, hook))
      if (!res.ok) return this.fail(job, at, res.failure)

      this.deps.jobs.finish(job.id, { ok: true }, this.deps.clock.now())
      this.emit(job, 'done', 'persist')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.fail(job, at, fatalFailure(message))
    }
  }

  /** 分类先只落日志：按 kind 退避重试是限流那一票的事，这里不偷偷把它做掉。 */
  private fail(job: SummaryJob, at: JobStage, failure: Failure): void {
    try {
      this.deps.jobs.finish(job.id, { ok: false, error: failure.message }, this.deps.clock.now())
      this.emit(job, 'failed', at)
    } catch (err) {
      // 库都写不进去（多半是关停时连接已关），只剩日志这条路。
      this.logger.error({ jobId: job.id, bvid: job.bvid, ...errFields(err) }, '任务状态写库失败')
    }
    this.logger.warn(
      { jobId: job.id, bvid: job.bvid, stage: at, attempts: job.attempts, ...failureFields(failure) },
      '任务失败',
    )
  }

  private emit(job: Pick<SummaryJob, 'id' | 'bvid'>, status: SummaryJob['status'], stage: JobStage): void {
    this.deps.events.emit({ type: 'job.changed', id: job.id, bvid: job.bvid, status, stage })
  }
}
