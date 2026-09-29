import type { Failure } from '#shared/contract/failure.ts'
import type { JobStage, PipelineStep, SummaryJob } from '#shared/contract/job.ts'
import { JOB_STAGE_LABEL } from '#shared/contract/job.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import { staleArtifacts } from '../domain/pipeline.ts'
import { errFields, failureFields } from '../log-fields.ts'
import type { Clock } from '../types/platform.ts'
import type { ConfigStore } from '../types/persistence.ts'
import type { EventBus } from '../types/platform.ts'
import type { Llm } from '../types/ai.ts'
import type { Logger } from '../types/platform.ts'
import type { DeliveryRepo, JobArtifactRepo, JobRepo, UpdateRepo } from '../types/persistence.ts'
import type { DeliveryService } from './delivery.ts'
import { Lane } from './lane.ts'
import type { StepHook, SummarizeVideo, Transcript } from './summarize-video.ts'

export interface QueueDeps {
  jobs: JobRepo
  artifacts: JobArtifactRepo
  updates: UpdateRepo
  deliveries: DeliveryRepo
  summarize: SummarizeVideo
  /** 流水线最后一步用它把结果发出去。它同时承担重试耗尽后的错误提示 */
  delivery: () => DeliveryService | null

  llm: () => Llm | null
  config: ConfigStore
  clock: Clock
  logger: Logger
  events: EventBus
}


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

    const revived = this.deps.jobs.resetRunning(this.deps.clock.now())
    if (revived > 0) this.logger.info({ revived }, '中断的任务已复位')

    // 订阅配置本身而不是 config.changed 事件：后者只有两条 HTTP 路径手动发
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

    if (existing !== null && existing.status !== 'failed') {
      this.pump()
      return existing
    }

    const job = this.deps.jobs.enqueue({ ...v, at: this.deps.clock.now() })
    this.emit(job, 'pending', 'queued')
    this.pump()
    return job
  }

  /** 重跑 failed/done 任务；指定 from 时作废应步骤及后续产物，复用此前产物 */
  retry(id: number, from?: PipelineStep): 'ok' | 'missing' | 'busy' {
    const job = this.deps.jobs.get(id)
    if (job === null) return 'missing'
    if (job.status === 'running' || job.status === 'pending') return 'busy'

    const at = this.deps.clock.now()
    if (from !== undefined) {
      this.deps.artifacts.drop(job.bvid, staleArtifacts(from))
      this.deps.jobs.resetStepsFrom(job.id, from, at)
    }
    // 手动重跑后用户拿到完整重试预算，不吃自动重试的配额。
    this.deps.jobs.clearRetries(job.id, at)
    // 新生成的内容该能再推一次：上一次的「已发送」不能把重跑的结果拦下来。
    this.deps.deliveries.reopenSummary(job.updateId)
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

  /** 等在跑的任务收尾。测试和优雅关停用；关停要给上限，LLM 那一步可能要几十秒 */
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

  /** 取活。在飞总数封在两条通道额度之和：取字幕不占额度，所以单条视频在等本机转写时， 有字幕的视频照样能取字幕、照样能进 LLM 通道 */
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

  /** 绝不抛：单条任务失败不能把队列带走 */
  private async execute(job: SummaryJob): Promise<void> {
    const from: PipelineStep = job.resumeFrom ?? 'subtitle'

    let at: JobStage = job.stage
    const hook: StepHook = (step, status, note) => {
      const now = this.deps.clock.now()
      this.deps.jobs.setStep(job.id, step, status, note ?? null, now)

      if (status === 'running') {
        at = step
        this.deps.jobs.setStage(job.id, step, now)
      }
      this.emit(job, 'running', at)
    }
    try {
      // 转写不会抛，只会降级 —— 拿不到语音内容时 summarize 会返回失败，由 fail() 安排重试。
      // 转写内部自己排队（并发 1），队列这层不拦，否则单条长视频会把有字幕的也堵住
      const t: Transcript = await this.deps.summarize.transcribe(job.bvid, from, hook)

      const res = await this.llmLane.run(() => this.deps.summarize.summarize(job, t, from, hook))
      if (!res.ok) return this.fail(job, at, res.failure)

      this.deps.jobs.finish(job.id, { ok: true }, this.deps.clock.now())
      this.emit(job, 'done', 'persist')

      // 推送是流水线的最后一步：只有真生成了总结才走得到这里。
      // 它失败也进同一套重试 —— 从 push 重跑就是拿已有正文再发一次，不重调 LLM。
      const outcome = await this.push(job, hook)
      if (!outcome.ok) this.fail(job, 'push', fatalFailure(outcome.reason))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.fail(job, at, fatalFailure(message))
    }
  }

  /** 跑推送这一步，把结果写进 job_steps。没有接投递服务时算跳过，不算失败 */
  private async push(
    job: SummaryJob,
    hook: StepHook,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const delivery = this.deps.delivery()
    if (delivery === null) {
      hook('push', 'skipped', '投递服务未接入')
      return { ok: true }
    }

    hook('push', 'running')
    const outcome = await delivery.pushSummary(job.bvid)
    if (outcome.skipped) {
      hook('push', 'skipped', '没有可用的推送渠道')
      return { ok: true }
    }
    if (outcome.failed > 0 && outcome.sent === 0) {
      hook('push', 'failed', `${outcome.failed} 个渠道全部失败`)
      return { ok: false, reason: `推送失败：${outcome.failed} 个渠道都没发出去` }
    }
    hook('push', 'done', `已发 ${outcome.sent} 个渠道`)
    return { ok: true }
  }

  /**
   * 失败不是终点：还有重试预算就排下一次（从失败的那一步起跑，复用已有产物），
   * 预算用尽才落 failed 并把错误提示推给用户。
   */
  private fail(job: SummaryJob, at: JobStage, failure: Failure): void {
    try {
      const budget = this.deps.config.getSection('queue').maxRetries
      // 从库里重读：scheduleRetry 会自增 retries，内存里那份是入队时的快照。
      const used = this.deps.jobs.get(job.id)?.retries ?? job.retries
      if (used < budget) {
        const wait = Math.max(
          this.deps.config.getSection('queue').retryIntervalMs,
          failure.retryAfterMs ?? 0,
        )
        const now = this.deps.clock.now()
        this.deps.jobs.scheduleRetry(job.id, {
          from: resumeStep(at),
          nextAttemptAt: now + wait,
          error: failure.message,
          at: now,
        })
        this.logger.warn(
          {
            jobId: job.id,
            bvid: job.bvid,
            stage: at,
            retry: used + 1,
            budget,
            waitMs: wait,
            ...failureFields(failure),
          },
          '任务失败，已排下一次重试',
        )
        this.emit(job, 'pending', at)
        this.scheduleWake(wait)
        return
      }

      this.deps.jobs.finish(job.id, { ok: false, error: failure.message }, this.deps.clock.now())
      this.emit(job, 'failed', at)
      this.exhausted(job, at, failure, used)
    } catch (err) {
      this.logger.error({ jobId: job.id, bvid: job.bvid, ...errFields(err) }, '任务状态写库失败')
    }
  }

  /** 重试排到未来时，到点叫醒队列。用 Clock.after 而不是 setTimeout： 测试里的时钟是假的，真定时器在假时钟下永远不会到点 */
  private scheduleWake(waitMs: number): void {
    this.deps.clock.after(waitMs, () => this.pump())
  }

  /** 预算用尽：把失败原因推给用户，而不是推一条没有内容的总结。 */
  private exhausted(job: SummaryJob, at: JobStage, failure: Failure, retries: number): void {
    const delivery = this.deps.delivery()
    if (delivery === null) return

    const reason =
      at === 'push'
        ? `总结已生成，但推送失败：${failure.message}`
        : `总结没能生成，卡在「${JOB_STAGE_LABEL[at]}」：${failure.message}`
    void delivery
      .notifyJobFailure({
        updateId: job.updateId,
        title: this.failureTitle(job),
        reason,
        retries,
      })
      .catch((err: unknown) => {
        this.logger.error({ jobId: job.id, ...errFields(err) }, '失败提示推送异常')
      })

    this.logger.warn(
      { jobId: job.id, bvid: job.bvid, stage: at, retries, ...failureFields(failure) },
      '任务失败，已推错误提示',
    )
  }

  private failureTitle(job: SummaryJob): string {
    const title = this.titleOf(job)
    return title === null ? `【失败】${job.bvid}` : `【失败】${title}`
  }

  /** 标题只在 updates 里。查不到就退回 bvid，不让提示因为拿不到标题而发不出去。 */
  private titleOf(job: SummaryJob): string | null {
    const update = this.deps.updates.get(job.updateId)
    return update?.title ?? null
  }

  private emit(job: Pick<SummaryJob, 'id' | 'bvid'>, status: SummaryJob['status'], stage: JobStage): void {
    this.deps.events.emit({ type: 'job.changed', id: job.id, bvid: job.bvid, status, stage })
  }
}

/** 失败时停在的那一步就是下次重跑的起点。queued 不该出现在这里，真出现了就从头来 */
function resumeStep(at: JobStage): PipelineStep {
  return at === 'queued' ? 'subtitle' : at
}
