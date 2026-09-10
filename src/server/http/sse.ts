import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'

import type { ServerDeps } from '../types/index.ts'


const HEARTBEAT_MS = 25_000

/** 心跳，并挂到连接断开为止。 定时器 unref：单条保持的 SSE 不应成为「进程退不出去」的原因 —— 真实连接由 socket 自己撑着，这个心跳只是往里写字节 */
export async function keepAlive(stream: SSEStreamingApi): Promise<void> {
  const timer = setInterval(() => void stream.writeln(': ping'), HEARTBEAT_MS)
  timer.unref()
  try {
    await new Promise<void>((resolve) => stream.onAbort(resolve))
  } finally {
    clearInterval(timer)
  }
}

/** 事件流。业务代码只认识 EventBus，SSE 是它的一个订阅者 */
export function eventRoutes(deps: ServerDeps): Hono {
  return new Hono().get('/', (c) =>
    streamSSE(c, async (stream) => {
      const off = deps.events.on((event) => {

        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      })
      stream.onAbort(off)

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ type: 'hello', at: deps.clock.now() }),
      })
      await keepAlive(stream)
    }),
  )
}
