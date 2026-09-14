import { relative } from 'node:path'
import process from 'node:process'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'

import type { AiService } from '../app/ai.ts'
import type { AuthLifecycle } from '../app/auth-lifecycle.ts'
import type { BackupService } from '../app/backup.ts'
import type { HealthMonitor } from '../app/health.ts'
import type { NotifyService } from '../app/notify.ts'
import type { Poller } from '../app/poller.ts'
import type { SummaryQueue } from '../app/queue-runner.ts'
import type { RuleService } from '../app/rules.ts'
import type { SubscriptionService } from '../app/subscriptions.ts'
import type { UpFeedService } from '../app/up-feed.ts'
import type { ServerDeps } from '../types/index.ts'
import { errorBody, makeErrorHandler } from './errors.ts'
import { aiRoutes } from './routes/ai.ts'
import { configRoutes } from './routes/config.ts'
import { healthRoutes } from './routes/health.ts'
import { jobRoutes } from './routes/jobs.ts'
import { logRoutes, type LogBuffer } from './routes/logs.ts'
import { notifyRoutes } from './routes/notify.ts'
import { promptRoutes } from './routes/prompts.ts'
import { overviewRoutes } from './routes/overview.ts'
import { ruleRoutes } from './routes/rules.ts'
import { subscriptionRoutes } from './routes/subscriptions.ts'
import { summaryRoutes } from './routes/summaries.ts'
import { systemRoutes } from './routes/system.ts'
import { updateRoutes } from './routes/updates.ts'
import { upRoutes } from './routes/ups.ts'
import { eventRoutes } from './sse.ts'

export interface HttpOptions {
  startedAt: number

  webRoot: string | null
  /** app 层的登录态服务。null = 这个进程没装 B 站适配器 */
  auth: AuthLifecycle | null
  /** 订阅服务。仓储永远在，所以它不会是 null —— 关注适配器缺席只影响「关不上」 */
  subs: SubscriptionService
  poll: Poller
  rules: RuleService
  ai: AiService
  notify: NotifyService
  queue: SummaryQueue
  ups: UpFeedService
  health: HealthMonitor
  backup: BackupService

  logs: LogBuffer
}

/** Hono 装配：服务仅监听 127.0.0.1，安全边界是文件系统权限而非自写登录（spec Q31a）；改 host 前须重审此假设 */
export function createHttpApp(deps: ServerDeps, opts: HttpOptions): Hono {
  const app = new Hono()

  app.onError(makeErrorHandler(deps.logger))

  const api = new Hono()
  api.route('/health', healthRoutes(deps, opts.startedAt))
  api.route(
    '/system',
    systemRoutes(deps, {
      startedAt: opts.startedAt,
      auth: opts.auth,
      poll: opts.poll,
      backup: opts.backup,
    }),
  )
  api.route(
    '/overview',
    overviewRoutes(deps, {
      startedAt: opts.startedAt,
      auth: opts.auth,
      poll: opts.poll,
      health: opts.health,
    }),
  )
  api.route('/config', configRoutes(deps))
  api.route('/prompts', promptRoutes(deps))
  api.route('/subscriptions', subscriptionRoutes(opts.subs))
  api.route('/updates', updateRoutes(deps, opts.poll))
  api.route('/rules', ruleRoutes(opts.rules))
  api.route('/jobs', jobRoutes(deps, opts.queue))
  api.route('/summaries', summaryRoutes(deps, opts.queue))
  api.route('/ups', upRoutes(deps, opts.ups))
  api.route('/ai', aiRoutes(opts.ai))
  api.route('/notify', notifyRoutes(opts.notify))
  api.route('/events', eventRoutes(deps))

  api.route('/logs', logRoutes(deps.events, opts.logs))
  // 未匹配的 /api 路径统一返回结构化 404，不回退到静态 index.html
  api.all('*', (c) => c.json(errorBody('not-found', `没有这个端点：${c.req.path}`), 404))
  app.route('/api', api)

  if (opts.webRoot !== null) {
    // @hono/node-server 的 serveStatic root 必须相对 cwd；绝对路径会静默不伺服任何内容。
    const root = relative(process.cwd(), opts.webRoot) || '.'
    app.use('/*', serveStatic({ root }))
    // 前端为单页应用，深链接回退到 index.html 交由 react-router 处理。
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  app.notFound((c) => c.json(errorBody('not-found', `没有这个路径：${c.req.path}`), 404))
  return app
}
