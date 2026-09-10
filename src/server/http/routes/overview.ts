import { Hono } from 'hono'

import type {
  DeliveryEntry,
  OverviewResponse,
  QueueSnapshot,
  TokenUsage,
} from '#shared/contract/api.ts'
import { videoUrl } from '#shared/format.ts'
import type { AuthLifecycle } from '../../app/auth-lifecycle.ts'
import type { HealthMonitor } from '../../app/health.ts'
import type { Poller } from '../../app/poller.ts'
import type { ServerDeps } from '../../types/index.ts'
import { adapterMissingAuth } from '../auth-fallback.ts'


const TIMELINE_LIMIT = 12

export interface OverviewRouteDeps {
  startedAt: number
  auth: AuthLifecycle | null
  poll: Poller
  health: HealthMonitor
}

/** 一屏看出系统是不是活着：轮询、cookie、队列、今日与本月 token、最近推送、保持的故障。 一个端点给全，因为它们在页面上本来就是同一屏；拆成七八个只会变成七八次往返。 全是本地读（库 + 内存快照），所以刷新它不会打任何外部请求 */
export function overviewRoutes(server: ServerDeps, route: OverviewRouteDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const now = server.clock.now()
      const body: OverviewResponse = {
        auth: route.auth?.snapshot() ?? adapterMissingAuth(server, now),
        poll: route.poll.snapshot(),
        queue: queueSnapshot(server),
        health: route.health.snapshot(),
        usage: {
          today: usageSince(server, startOfDay(now)),
          month: usageSince(server, startOfMonth(now)),
        },
        deliveries: timeline(server),
        version: server.version,
        startedAt: route.startedAt,
        uptimeMs: now - route.startedAt,
        now,
      }
      return c.json(body)
    })

    // 手动跑一轮自查。cron 半小时一次，等不及的时候点它
    .post('/check', async (c) => c.json(await route.health.checkNow()))
}

function queueSnapshot(deps: ServerDeps): QueueSnapshot {
  const counts = deps.repos.jobs.counts()
  const stages = deps.repos.jobs.runningStages()
  const asr = stages.filter((s) => s === 'download' || s === 'asr').length
  return {
    ...counts,
    // 剩下的都在占 LLM 应项通道（取字幕不占额度，但它也不应算进 ASR 应项）
    inflight: { asr, llm: stages.length - asr },
  }
}


function startOfDay(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function startOfMonth(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

const usageSince = (deps: ServerDeps, ts: number): TokenUsage => deps.repos.llmCalls.usageSince(ts)


function timeline(deps: ServerDeps): DeliveryEntry[] {
  return deps.repos.deliveries.recent(TIMELINE_LIMIT).map((d) => {
    const update = d.updateId.startsWith('alert:') ? null : deps.repos.updates.get(d.updateId)
    return {
      updateId: d.updateId,
      channel: d.channel,
      kind: d.kind,
      status: d.status,
      at: d.at,
      error: d.error,
      title: update?.title ?? update?.text ?? null,
      url: update?.url ?? (update?.bvid == null ? null : videoUrl(update.bvid)),
    }
  })
}
