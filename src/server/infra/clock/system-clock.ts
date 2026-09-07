import { Cron } from 'croner'

import type { Cancel, Clock } from '../../ports/clock.ts'

/** 真时钟。cron 交给 croner —— 它支持 6 位含秒的表达式，轮询错峰到 :30 靠的就是这一位。 */
export class SystemClock implements Clock {
  readonly #jobs = new Set<Cron>()

  now(): number {
    return Date.now()
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  schedule(cron: string, task: () => void | Promise<void>): Cancel {
    // protect: true —— 上一轮没跑完时这一次 tick 直接跳过，不并发拉取把自己打成限流。
    const job = new Cron(cron, { protect: true }, task)
    this.#jobs.add(job)
    return () => {
      job.stop()
      this.#jobs.delete(job)
    }
  }

  /** 进程退出前停掉所有定时任务，否则 Node 不会退。 */
  stopAll(): void {
    for (const job of this.#jobs) job.stop()
    this.#jobs.clear()
  }
}
