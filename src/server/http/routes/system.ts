import { Hono } from 'hono'

import type {
  AuthSnapshot,
  LoginStartResponse,
  QrResponse,
  RefreshResponse,
  StorageResponse,
  SystemResponse,
} from '#shared/contract/api.ts'
import type { AuthLifecycle } from '../../app/auth-lifecycle.ts'
import type { BackupService } from '../../app/backup.ts'
import type { Poller } from '../../app/poller.ts'
import { renderQrSvg } from '../../infra/bili/qr-svg.ts'
import type { Ports } from '../../ports/index.ts'
import { ADAPTER_MISSING, adapterMissingAuth } from '../auth-fallback.ts'
import { errorBody } from '../errors.ts'

/**
 * 系统状态与运维动作：登录态、扫码、手动续期、磁盘占用、备份导出。
 *
 * GET / 只读当前快照，不主动去问 B 站 —— 页面刷新不该顺手打一串外部请求。
 * 真正的核对由启动流程和 cron 做，这里看到的是它们留下的结论。
 */
export interface SystemRouteDeps {
  startedAt: number
  auth: AuthLifecycle | null
  poll: Poller
  backup: BackupService
}

export function systemRoutes(ports: Ports, deps: SystemRouteDeps): Hono {
  const log = ports.logger.child({ mod: 'http' })
  const snapshot = (): AuthSnapshot =>
    deps.auth === null ? adapterMissingAuth(ports, ports.clock.now()) : deps.auth.snapshot()

  return new Hono()
    .get('/', (c) => {
      const now = ports.clock.now()
      const body: SystemResponse = {
        auth: snapshot(),
        poll: deps.poll.snapshot(),
        version: ports.version,
        startedAt: deps.startedAt,
        uptimeMs: now - deps.startedAt,
        now,
      }
      return c.json(body)
    })

    // 不 await 登录：扫码要等人，这个请求只负责把码弄出来。
    .post('/login', (c) => {
      const auth = deps.auth
      if (auth === null) return c.json(errorBody('adapter-missing', ADAPTER_MISSING), 503)
      const started = auth.beginLogin()
      const body: LoginStartResponse = { started: started === 'started', auth: auth.snapshot() }
      return c.json(body)
    })

    .get('/qr', async (c) => {
      const url = snapshot().qrUrl
      if (url === null) return c.json(errorBody('no-qr', '现在没有等着被扫的二维码'), 404)
      const body: QrResponse = { url, svg: renderQrSvg(url) }
      return c.json(body)
    })

    // 续不动是 200：这是「续期没成」，不是「这个请求错了」，页面要照原样显示原因。
    .post('/refresh', async (c) => {
      const auth = deps.auth
      if (auth === null) return c.json(errorBody('adapter-missing', ADAPTER_MISSING), 503)
      const res = await auth.refreshNow()
      const body: RefreshResponse = {
        ok: res.ok,
        error: res.ok ? null : res.failure.message,
        auth: auth.snapshot(),
      }
      return c.json(body)
    })

    .get('/storage', async (c) => {
      const usage = await ports.storage.usage()
      const body: StorageResponse = {
        ...usage,
        updates: ports.repos.updates.count(),
        summaries: ports.repos.summaries.count(),
      }
      return c.json(body)
    })

    .get('/backup', (c) => {
      const file = deps.backup.build()
      log.info({ updates: file.updates.length, summaries: file.summaries.length }, '备份已导出')
      c.header('content-disposition', `attachment; filename="${deps.backup.fileName()}"`)
      return c.json(file)
    })
}
