/**
 * 一条并发通道。转写和 LLM 各占一条，因为贵的资源不是同一个：
 * 转写吃 CPU（本机 whisper 就一份），LLM 吃对方的限流。
 */
export class Lane {
  /** 额度是「用的时候读」的（配置随时能改），不是构造时抓一份存起来。 */
  private readonly limit: () => number
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(limit: () => number) {
    this.limit = limit
  }

  get free(): boolean {
    return this.active < Math.max(1, this.limit())
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free) this.active += 1
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      return await task()
    } finally {
      this.active -= 1
      this.admit()
    }
  }

  /** 额度调大时也要叫醒排队的，所以放开成独立方法。 */
  admit(): void {
    while (this.waiting.length > 0 && this.free) {
      this.active += 1
      this.waiting.shift()?.()
    }
  }
}
