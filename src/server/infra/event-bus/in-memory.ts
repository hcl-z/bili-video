import type { AppEvent, LogLine } from '#shared/contract/events.ts'
import type { Cancel } from '../../ports/clock.ts'
import type { EventBus } from '../../ports/event-bus.ts'

/**
 * 单进程内的发布订阅。SSE 只是它的一个订阅者 —— 业务代码不认识 SSE。
 *
 * 一个订阅者抛异常不能带倒别人（一个卡住的 SSE 连接不该让轮询失败），所以逐个 try。
 */
export class InMemoryEventBus implements EventBus {
  readonly #handlers = new Set<(e: AppEvent) => void>()
  readonly #logHandlers = new Set<(l: LogLine) => void>()
  /** 订阅者抛出的错误存这里，测试可以断言「没有静默吞掉」。 */
  readonly errors: unknown[] = []

  emit(event: AppEvent): void {
    for (const h of this.#handlers) {
      try {
        h(event)
      } catch (err) {
        this.errors.push(err)
      }
    }
  }

  on(handler: (event: AppEvent) => void): Cancel {
    this.#handlers.add(handler)
    return () => this.#handlers.delete(handler)
  }

  emitLog(line: LogLine): void {
    for (const h of this.#logHandlers) {
      try {
        h(line)
      } catch (err) {
        this.errors.push(err)
      }
    }
  }

  onLog(handler: (line: LogLine) => void): Cancel {
    this.#logHandlers.add(handler)
    return () => this.#logHandlers.delete(handler)
  }

  get subscriberCount(): number {
    return this.#handlers.size
  }
}
