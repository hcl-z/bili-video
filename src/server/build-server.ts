import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import type { Hono } from 'hono'

import { createHttpApp } from './http/app.ts'
import type { Ports } from './ports/index.ts'

/**
 * ★ 组装根。所有实现都从 ports 注入进来，这里不 new 任何适配器。
 *
 * 这是主测试缝：测试传假件拿到 app，用 app.request() 在进程内驱动，不起网络、不等真时间。
 * 因此这里绝不能出现模块级单例或 `import db from './db'` —— 那会让缝立刻失效。
 */
export interface Server {
  app: Hono
  /** 起 HTTP 监听，返回实际绑定的地址（port 配 0 时才知道真端口）。 */
  start(): Promise<AddressInfo>
  stop(): Promise<void>
}

export interface BuildOptions {
  webRoot?: string | null
}

export function buildServer(ports: Ports, opts: BuildOptions = {}): Server {
  const startedAt = ports.clock.now()
  const app = createHttpApp(ports, { startedAt, webRoot: opts.webRoot ?? null })

  let listening: ServerType | null = null

  return {
    app,

    async start(): Promise<AddressInfo> {
      if (listening !== null) throw new Error('server already started')
      const { host, port } = ports.config.getSection('server')
      return await new Promise<AddressInfo>((resolve, reject) => {
        const srv = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
          ports.logger.info({ ...info, version: ports.version }, '工作台已启动')
          resolve(info)
        })
        srv.once('error', reject)
        listening = srv
      })
    },

    async stop(): Promise<void> {
      const srv = listening
      listening = null
      if (srv !== null) {
        await new Promise<void>((resolve) => srv.close(() => resolve()))
      }
      await ports.logger.close()
    },
  }
}
