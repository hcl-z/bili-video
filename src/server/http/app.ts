import { relative } from 'node:path'
import process from 'node:process'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'

import type { AiService } from '../app/ai.ts'
import type { AuthLifecycle } from '../app/auth-lifecycle.ts'
import type { Poller } from '../app/poller.ts'
import type { SummaryQueue } from '../app/queue-runner.ts'
import type { RuleService } from '../app/rules.ts'
import type { SubscriptionService } from '../app/subscriptions.ts'
import type { Ports } from '../ports/index.ts'
import { errorBody, makeErrorHandler } from './errors.ts'
import { aiRoutes } from './routes/ai.ts'
import { configRoutes } from './routes/config.ts'
import { healthRoutes } from './routes/health.ts'
import { jobRoutes } from './routes/jobs.ts'
import { ruleRoutes } from './routes/rules.ts'
import { subscriptionRoutes } from './routes/subscriptions.ts'
import { summaryRoutes } from './routes/summaries.ts'
import { systemRoutes } from './routes/system.ts'
import { updateRoutes } from './routes/updates.ts'
import { eventRoutes } from './sse.ts'

export interface HttpOptions {
  startedAt: number
  /** 生产模式下托管 vite build 的产物；dev 期由 Vite 自己伺服，传 null。 */
  webRoot: string | null
  /** app 层的登录态服务。null = 这个进程没装 B 站适配器。 */
  auth: AuthLifecycle | null
  /** 订阅服务。仓储永远在，所以它不会是 null —— 关注适配器缺席只影响「关不上」。 */
  subs: SubscriptionService
  poll: Poller
  rules: RuleService
  ai: AiService
  queue: SummaryQueue
}

/**
 * Hono 实例装配。没有鉴权中间件 —— 服务只听 127.0.0.1，安全边界是文件系统权限
 * 而不是自写的登录（spec Q31a）。改 host 之前先把这句话读一遍。
 */
export function createHttpApp(ports: Ports, opts: HttpOptions): Hono {
  const app = new Hono()

  app.onError(makeErrorHandler(ports.logger))

  const api = new Hono()
  api.route('/health', healthRoutes(ports, opts.startedAt))
  api.route('/system', systemRoutes(ports, opts.startedAt, opts.auth, opts.poll))
  api.route('/config', configRoutes(ports))
  api.route('/subscriptions', subscriptionRoutes(opts.subs))
  api.route('/updates', updateRoutes(ports, opts.poll))
  api.route('/rules', ruleRoutes(opts.rules))
  api.route('/jobs', jobRoutes(ports, opts.queue))
  api.route('/summaries', summaryRoutes(ports, opts.queue))
  api.route('/ai', aiRoutes(opts.ai))
  api.route('/events', eventRoutes(ports))
  // /api 下没命中的一律结构化 404，绝不落到静态资源的 index.html 上去。
  api.all('*', (c) => c.json(errorBody('not-found', `没有这个端点：${c.req.path}`), 404))
  app.route('/api', api)

  if (opts.webRoot !== null) {
    // @hono/node-server 的 serveStatic 只认**相对 cwd** 的 root，给绝对路径会静默什么都不伺服。
    const root = relative(process.cwd(), opts.webRoot) || '.'
    app.use('/*', serveStatic({ root }))
    // 前端是单页应用，深链接要回 index.html 让 react-router 接手。
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  app.notFound((c) => c.json(errorBody('not-found', `没有这个路径：${c.req.path}`), 404))
  return app
}
