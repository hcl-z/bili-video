import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import type { Ports } from '../ports/index.ts'

/** 每 25 秒一行注释行，免得代理或浏览器把静默的连接掐掉。 */
const HEARTBEAT_MS = 25_000

/** 事件流。业务代码只认识 EventBus，SSE 是它的一个订阅者。 */

export function eventRoutes(ports: Ports): Hono {
  return new Hono().get('/', (c) =>
    streamSSE(c, async (stream) => {
      let alive = true
      const off = ports.events.on((event) => {
        // 不 await：一个卡住的客户端不该让 emit 的调用方（轮询）跟着卡住。
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      })
      stream.onAbort(() => {
        alive = false
        off()
      })

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ type: 'hello', at: ports.clock.now() }),
      })
      while (alive) {
        await stream.sleep(HEARTBEAT_MS)
        if (!alive) break
        await stream.writeln(': ping')
      }
    }),
  )
}
