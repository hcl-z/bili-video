import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import { LOG_FILTERS, matchesFilter, type LogFilter, type LogLine } from '#shared/contract/events.ts'
import type { Cancel } from '../../types/platform.ts'
import type { EventBus } from '../../types/platform.ts'
import { keepAlive } from '../sse.ts'

const BUFFER_SIZE = 400

const isFilter = (s: string): s is LogFilter => (LOG_FILTERS as readonly string[]).includes(s)


export class LogBuffer {
  private readonly lines: LogLine[] = []
  private readonly size: number
  private readonly off: Cancel

  constructor(events: EventBus, size = BUFFER_SIZE) {
    this.size = size
    this.off = events.onLog((line) => {
      this.lines.push(line)
      if (this.lines.length > this.size) this.lines.shift()
    })
  }

  recent(): readonly LogLine[] {
    return this.lines
  }

  close(): void {
    this.off()
  }
}

/** `/api/logs/stream` 是**独立的单条** SSE，不复用 /api/events —— 日志一秒能刷几十行， 混在主流量里会把队列进度那类事件挤到看不见 */
export function logRoutes(events: EventBus, buffer: LogBuffer): Hono {
  return new Hono().get('/stream', (c) => {
    const raw = c.req.query('level') ?? 'all'
    const filter: LogFilter = isFilter(raw) ? raw : 'all'

    return streamSSE(c, async (stream) => {
      const write = (line: LogLine) => {
        if (!matchesFilter(line.level, filter)) return

        void stream.writeSSE({ event: 'log', data: JSON.stringify(line) })
      }

      const off = events.onLog(write)
      stream.onAbort(off)

      for (const line of buffer.recent()) write(line)
      await keepAlive(stream)
    })
  })
}
