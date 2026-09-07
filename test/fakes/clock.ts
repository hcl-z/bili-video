import type { Cancel, Clock } from '../../src/server/ports/clock.ts'

/**
 * 可控时钟。cron 不做真解析：`schedule` 只把任务挂起来，靠 `tick()` 手动触发一轮 ——
 * 我们要测的是「一轮做了什么」和「撞上了要跳过」，不是 croner 的解析正确性。
 */
export class FakeClock implements Clock {
  #now: number
  readonly scheduled: { cron: string; task: () => void | Promise<void> }[] = []
  readonly slept: number[] = []

  constructor(startAt = Date.UTC(2026, 8, 7, 12, 0, 0)) {
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

  /** 把时间往前推，不触发任何任务。 */
  advance(ms: number): void {
    this.#now += ms
  }

  set(at: number): void {
    this.#now = at
  }

  /** 触发所有已注册的 cron 任务一轮。 */
  async tick(): Promise<void> {
    for (const { task } of [...this.scheduled]) await task()
  }
}
