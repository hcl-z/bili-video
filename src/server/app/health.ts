import type { AuthSnapshot, Fault, FaultKind, HealthSnapshot, PollSnapshot } from '#shared/contract/api.ts'
import { FAULT_LABEL } from '#shared/contract/api.ts'
import { detectFaults, type DetectedFault } from '../domain/health.ts'
import { errFields } from '../log-fields.ts'
import type { Cancel, Clock } from '../ports/clock.ts'
import type { ConfigStore } from '../ports/config-store.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Logger } from '../ports/logger.ts'
import type { Notifier } from '../ports/notifier.ts'
import type { DeliveryRepo, JobRepo } from '../ports/repo.ts'

/** 数最近这么多次转写结果就够判连败了，再往前翻没有意义。 */
const ASR_WINDOW = 10

export interface HealthDeps {
  /** 当前登录态。为 null 表示这个进程没装 B 站适配器，登录那一类就不判。 */
  auth: () => AuthSnapshot | null
  poll: () => PollSnapshot
  jobs: JobRepo
  deliveries: DeliveryRepo
  notifiers: Notifier[]
  config: ConfigStore
  clock: Clock
  logger: Logger
  events: EventBus
}

/**
 * 定时自查 + 告警。
 *
 * 「只推一条」不是靠记「上次推过没」，而是靠**故障期**这个概念：一类故障从出现到消失
 * 是一段，一段只推一条，段结束再推一条恢复。故障期在内存里 —— 重启后重新告警是对的，
 * 那时候人确实需要再被提醒一次。
 */
export class HealthMonitor {
  private readonly deps: HealthDeps
  private readonly logger: Logger
  /** 正在进行中的故障期。key 是故障类型，值是这一段的开始时刻与当时的原因。 */
  private readonly active = new Map<FaultKind, Fault>()
  private lastCheckAt: number | null = null
  private cancelCron: Cancel | null = null
  private cancelConfig: Cancel | null = null
  private running = false

  constructor(deps: HealthDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'health' })
  }

  start(): void {
    this.schedule()
    this.cancelConfig = this.deps.config.onChange((section) => {
      if (section === 'health') this.schedule()
    })
  }

  stop(): void {
    this.cancelCron?.()
    this.cancelCron = null
    this.cancelConfig?.()
    this.cancelConfig = null
  }

  snapshot(): HealthSnapshot {
    const { enabled, cron } = this.deps.config.getSection('health')
    return {
      enabled,
      cron,
      lastCheckAt: this.lastCheckAt,
      faults: [...this.active.values()],
    }
  }

  /**
   * 跑一轮自查。**永不抛**：cron 的回调没人 catch，抛出去就是一次静默的进程级未处理拒绝。
   */
  async checkNow(): Promise<HealthSnapshot> {
    // 撞上就跳过：推送可能要等好几秒，重入只会把同一条告警发两遍。
    if (this.running) return this.snapshot()
    this.running = true
    try {
      const found = this.detect()
      const now = this.deps.clock.now()
      this.lastCheckAt = now

      for (const f of found) {
        if (this.active.has(f.kind)) continue
        const fault: Fault = { ...f, since: now }
        this.active.set(f.kind, fault)
        this.logger.error({ fault: f.kind, detail: f.message }, '健康自查发现故障')
        await this.push(fault, 'down')
      }

      for (const [kind, fault] of [...this.active]) {
        if (found.some((f) => f.kind === kind)) continue
        this.active.delete(kind)
        this.logger.info({ fault: kind, since: fault.since, downMs: now - fault.since }, '故障已恢复')
        await this.push(fault, 'up')
      }

      this.deps.events.emit({ type: 'health.checked', ok: this.active.size === 0 })
      return this.snapshot()
    } catch (err) {
      this.logger.error(errFields(err), '健康自查异常')
      return this.snapshot()
    } finally {
      this.running = false
    }
  }

  private detect(): DetectedFault[] {
    const auth = this.deps.auth()
    const asr = this.asrStreak()
    return detectFaults({
      auth: {
        state: auth?.state ?? 'logged-out',
        lastError: auth?.lastError ?? null,
      },
      poll: this.deps.poll(),
      asr,
    })
  }

  /** 从最近的转写结果里数连着失败几次。跳过的那些不算 —— 有字幕就不转写，不是失败。 */
  private asrStreak(): { consecutiveFailures: number; lastError: string | null } {
    const recent = this.deps.jobs.recentSteps('asr', ASR_WINDOW)
    let n = 0
    for (const step of recent) {
      if (step.status !== 'failed') break
      n += 1
    }
    return { consecutiveFailures: n, lastError: n === 0 ? null : (recent[0]?.note ?? null) }
  }

  /**
   * 一条告警发给每个渠道。投递表那条唯一索引是第二道闸：并发跑两轮自查也不会重复发。
   *
   * updateId 是编出来的（`alert:类型:故障开始时刻`），因为告警没有对应的动态；
   * 同一段故障算出来的是同一个 key，所以「只推一条」在库这一层也成立。
   */
  private async push(fault: Fault, phase: 'down' | 'up'): Promise<void> {
    const label = FAULT_LABEL[fault.kind]
    const title = phase === 'down' ? `【故障】${label}` : `【已恢复】${label}`
    const body =
      phase === 'down'
        ? `${fault.message}\n\n发现时间：${new Date(fault.since).toLocaleString('zh-CN')}`
        : `${label}已经恢复。\n\n故障从 ${new Date(fault.since).toLocaleString('zh-CN')} 开始。`
    const updateId = `alert:${fault.kind}:${fault.since}${phase === 'up' ? ':recovered' : ''}`

    for (const notifier of this.deps.notifiers) {
      const key = { updateId, channel: notifier.channel, kind: 'alert' as const }
      if (!this.deps.deliveries.claim({ ...key, at: this.deps.clock.now() })) continue
      const res = await notifier.send({ kind: 'alert', title, body, url: null, group: updateId })
      this.deps.deliveries.settle(
        key,
        { status: res.ok ? 'sent' : 'failed', error: res.error },
        this.deps.clock.now(),
      )
      if (!res.ok) {
        this.logger.warn(
          { channel: notifier.channel, fault: fault.kind, phase, err: res.error ?? '原因不明' },
          '告警投递失败',
        )
      }
    }
  }

  private schedule(): void {
    this.cancelCron?.()
    this.cancelCron = null
    const { enabled, cron } = this.deps.config.getSection('health')
    if (!enabled) return
    this.cancelCron = this.deps.clock.schedule(cron, async () => {
      await this.checkNow()
    })
    this.logger.info({ cron }, '健康自查已排程')
  }
}
