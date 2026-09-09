import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'

import type { Ports } from '../ports/index.ts'

/** 每 25 秒一行注释行，免得代理或浏览器把静默的连接掐掉。 */
const HEARTBEAT_MS = 25_000

/**
 * 心跳，并挂到连接断开为止。
 *
 * 定时器 unref：一条挂着的 SSE 不该成为「进程退不出去」的原因 ——
 * 真实连接由 socket 自己撑着，这个心跳只是往里写字节。
 */
export async function keepAlive(stream: SSEStreamingApi): Promise<void> {
  const timer = setInterval(() => void stream.writeln(': ping'), HEARTBEAT_MS)
  timer.unref()
  try {
    await new Promise<void>((resolve) => stream.onAbort(resolve))
  } finally {
    clearInterval(timer)
  }
}

/** 事件流。业务代码只认识 EventBus，SSE 是它的一个订阅者。 */
export function eventRoutes(ports: Ports): Hono {
  return new Hono().get('/', (c) =>
    streamSSE(c, async (stream) => {
      const off = ports.events.on((event) => {
        // 不 await：一个卡住的客户端不该让 emit 的调用方（轮询）跟着卡住。
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      })
      stream.onAbort(off)

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ type: 'hello', at: ports.clock.now() }),
      })
      await keepAlive(stream)
    }),
  )
}
