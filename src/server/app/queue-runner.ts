import type { Failure } from '#shared/contract/failure.ts'
import type { JobStage, SummaryJob } from '#shared/contract/job.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import type { Clock } from '../ports/clock.ts'
import type { ConfigStore } from '../ports/config-store.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Llm } from '../ports/llm.ts'
import type { Logger } from '../ports/logger.ts'
import type { JobRepo } from '../ports/repo.ts'
import { Lane } from './lane.ts'
import type { SummarizeVideo, Transcript } from './summarize-video.ts'

export interface QueueDeps {
  jobs: JobRepo
  summarize: SummarizeVideo
  /** ★ 总开关：null 表示 AI 关着，这时候只入队不消费。 */
  llm: () => Llm | null
  config: ConfigStore
  clock: Clock
  logger: Logger
  events: EventBus
}

/**
 * 总结队列。它和轮询完全解耦：轮询只管入队，抓取速度不受总结拖累。
 *
 * 没有定时器 —— 入队、启动、AI 配置变更这三处各踢一次 pump 就够了。
 */
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
    if (revived > 0) this.logger.info({ revived }, '重置中断的任务')

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
    this.emit(job.id, 'pending', 'queued')
    this.pump()
    return job
  }

  /** 重跑一条：把 failed/done 放回 pending。已完成的重跑会覆盖原来的总结。 */
  retry(id: number): 'ok' | 'missing' | 'busy' {
    const job = this.deps.jobs.get(id)
    if (job === null) return 'missing'
    if (job.status === 'running' || job.status === 'pending') return 'busy'
    this.deps.jobs.enqueue({ bvid: job.bvid, updateId: job.updateId, at: this.deps.clock.now() })
    this.emit(id, 'pending', 'queued')
    this.pump()
    return 'ok'
  }

  /** 等在跑的任务收尾。测试和优雅关停用；关停要给上限，LLM 那一步可能要几十秒。 */
  async drain(timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs
    while (this.running.size > 0) {
      if (deadline !== null && Date.now() >= deadline) {
        this.logger.warn({ inflight: this.running.size }, '还有任务没收尾，不再等了')
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
      this.emit(job.id, 'running', job.stage)
      const p = this.execute(job).finally(() => {
        this.running.delete(job.id)
        this.pump()
      })
      this.running.set(job.id, p)
    }
  }

  /** 绝不抛：一条任务炸掉不能把队列带走。 */
  private async execute(job: SummaryJob): Promise<void> {
    // 失败事件要报「停在哪一步」，所以跟着闭包记最后一步，别用 claimNext 那份快照。
    let at: JobStage = job.stage
    const stage = (s: JobStage): void => {
      at = s
      this.deps.jobs.setStage(job.id, s, this.deps.clock.now())
      this.emit(job.id, 'running', s)
    }
    try {
      // 转写不会「失败」，只会降级 —— 拿不到语音内容照样往下走，退到简介兜底。
      // 转写内部自己排队（并发 1），队列这层不拦，否则一条长视频会把有字幕的也堵住。
      const t: Transcript = await this.deps.summarize.transcribe(job.bvid, stage)

      const res = await this.llmLane.run(() => this.deps.summarize.summarize(job, t, stage))
      if (!res.ok) return this.fail(job, at, res.failure)

      this.deps.jobs.finish(job.id, { ok: true }, this.deps.clock.now())
      this.emit(job.id, 'done', 'persist')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.fail(job, at, fatalFailure(message))
    }
  }

  /** 分类先只落日志：按 kind 退避重试是限流那一票的事，这里不偷偷把它做掉。 */
  private fail(job: SummaryJob, at: JobStage, failure: Failure): void {
    try {
      this.deps.jobs.finish(job.id, { ok: false, error: failure.message }, this.deps.clock.now())
      this.emit(job.id, 'failed', at)
    } catch (err) {
      // 库都写不进去（多半是关停时连接已关），只剩日志这条路。
      this.logger.error({ id: job.id, err: String(err) }, '任务失败状态没写进库')
    }
    this.logger.warn(
      { id: job.id, bvid: job.bvid, stage: at, kind: failure.kind, error: failure.message },
      '任务失败',
    )
  }

  private emit(id: number, status: SummaryJob['status'], stage: JobStage): void {
    this.deps.events.emit({ type: 'job.changed', id, status, stage })
  }
}
