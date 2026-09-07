import type { AddressInfo } from 'node:net'
import process from 'node:process'
import { serve, type ServerType } from '@hono/node-server'
import type { Hono } from 'hono'

import { AuthLifecycle } from './app/auth-lifecycle.ts'
import { createHttpApp } from './http/app.ts'
import { renderQr } from './infra/bili/qr-terminal.ts'
import type { Ports } from './ports/index.ts'

/**
 * ★ 组装根。所有实现都从 ports 注入进来，这里不 new 任何适配器。
 *
 * 这是主测试缝：测试传假件拿到 app，用 app.request() 在进程内驱动，不起网络、不等真时间。
 * 因此这里绝不能出现模块级单例或 `import db from './db'` —— 那会让缝立刻失效。
 */
export interface Server {
  app: Hono
  /** app 层服务。启动流程和测试都要拿它做事，所以摆在外面而不是藏在闭包里。 */
  services: Services
  /** 起 HTTP 监听，返回实际绑定的地址（port 配 0 时才知道真端口）。 */
  start(): Promise<AddressInfo>
  /**
   * 起监听之后要做的事：核对登录态，需要时在终端出码。
   *
   * 刻意不在 start() 里 await —— 扫码要等人，工作台不该为此推迟到能打开。
   * 永不 reject：启动期的问题落日志和快照，不该把进程带走。
   */
  bootstrap(): Promise<void>
  stop(): Promise<void>
}

/** 组装出来的 app 层服务。null = 依赖的适配器还没接上。 */
export interface Services {
  auth: AuthLifecycle | null
}

export interface BuildOptions {
  webRoot?: string | null
  /** 二维码往哪儿写。默认 stdout —— 扫码是终端里的动作，不该被日志格式化。 */
  showQr?: (art: string, url: string) => void
}

export function buildServer(ports: Ports, opts: BuildOptions = {}): Server {
  const startedAt = ports.clock.now()
  const services: Services = { auth: makeAuthLifecycle(ports, opts) }
  const app = createHttpApp(ports, {
    startedAt,
    webRoot: opts.webRoot ?? null,
    auth: services.auth,
  })

  let listening: ServerType | null = null

  return {
    app,
    services,

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

    async bootstrap(): Promise<void> {
      const auth = services.auth
      if (auth === null) {
        ports.logger.warn({}, 'B 站适配器未接入，跳过登录态核对')
        return
      }
      try {
        const checked = await auth.ensureFresh()
        // 需要重新登录才出码。已经登录着的进程重启不该再打一张没人扫的码。
        if (checked.ok && checked.value.action === 'relogin') {
          ports.logger.info({ reason: checked.value.reason }, '需要扫码登录')
          await auth.loginByQr()
        }
      } catch (err) {
        ports.logger.error({ err: String(err) }, '启动期核对登录态出错')
      }
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

function makeAuthLifecycle(ports: Ports, opts: BuildOptions): AuthLifecycle | null {
  const auth = ports.external.biliAuth
  if (auth === null) return null
  return new AuthLifecycle({
    auth,
    cookies: ports.cookies,
    state: ports.state,
    clock: ports.clock,
    events: ports.events,
    logger: ports.logger,
    // 用时读配置：页面上改完提前续期的天数，下一轮就生效。
    refreshThresholdMs: () => ports.config.getSection('bili').refreshThresholdDays * 86_400_000,
    showQr: opts.showQr ?? defaultShowQr,
    renderQr,
  })
}

/** 字符画写 stdout，不走 logger —— 把二维码塞进日志文件对谁都没用。 */
function defaultShowQr(art: string, url: string): void {
  process.stdout.write(`\n${art}\n用 B 站 App 扫上面的二维码登录\n若终端显示不全，可打开：${url}\n\n`)
}
