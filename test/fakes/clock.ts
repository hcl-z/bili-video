import { checkCronExpression } from '../../src/server/infra/clock/system-clock.ts'
import type { Cancel, Clock } from '../../src/server/types/platform.ts'

/** 可控时钟。cron 不做真解析：`schedule` 只把任务挂起来，靠 `tick()` 手动触发一轮 —— 我们要测的是「一轮做了什么」和「遇到了要跳过」，不是 croner 的解析正确性 */

export const CLOCK_START = Date.UTC(2026, 8, 7, 12, 0, 0)

export class FakeClock implements Clock {
  #now: number
  readonly scheduled: { cron: string; task: () => void | Promise<void> }[] = []
  readonly slept: number[] = []

  constructor(startAt = CLOCK_START) {
    this.#now = startAt
  }

  now(): number {
    return this.#now
  }

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms)
    this.#now += ms
  }

  schedule(cron: string, task: () => void | Promise<void>): Cancel {
    const entry = { cron, task }
    this.scheduled.push(entry)
    return () => {
      const i = this.scheduled.indexOf(entry)
      if (i >= 0) this.scheduled.splice(i, 1)
    }
  }

  /** 延时任务按到期时刻排队。`advance` 跨过到期时刻时触发，跟真实时钟的语义一致 */
  after(ms: number, task: () => void | Promise<void>): Cancel {
    const entry = { due: this.#now + ms, task }
    this.timers.push(entry)
    return () => {
      const i = this.timers.indexOf(entry)
      if (i >= 0) this.timers.splice(i, 1)
    }
  }

  readonly timers: { due: number; task: () => void | Promise<void> }[] = []

  /** 排程不解析 cron，但校验必须是真的：非法表达式当场被拒是要测的行为之一 */
  checkCron(cron: string): string | null {
    return checkCronExpression(cron)
  }


  advance(ms: number): void {
    this.#now += ms
    this.fireDue()
  }

  set(at: number): void {
    this.#now = at
    this.fireDue()
  }

  private fireDue(): void {
    for (const entry of [...this.timers]) {
      if (entry.due > this.#now) continue
      const i = this.timers.indexOf(entry)
      if (i >= 0) this.timers.splice(i, 1)
      void entry.task()
    }
  }

  /** 触发所有已注册的 cron 任务一轮 */
  async tick(): Promise<void> {
    for (const { task } of [...this.scheduled]) await task()
  }
}
