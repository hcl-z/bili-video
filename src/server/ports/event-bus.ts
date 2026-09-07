import type { AppEvent, LogLine } from '#shared/contract/events.ts'
import type { Cancel } from './clock.ts'

/** SSE 只是它的一个订阅者，业务代码不认识 SSE。 */
export interface EventBus {
  emit(event: AppEvent): void
  on(handler: (event: AppEvent) => void): Cancel
  /** 日志走独立通道，避免刷日志把主流量挤爆。 */
  emitLog(line: LogLine): void
  onLog(handler: (line: LogLine) => void): Cancel
}
