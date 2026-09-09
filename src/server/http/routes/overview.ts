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
import type { Ports } from '../../ports/index.ts'
import { adapterMissingAuth } from '../auth-fallback.ts'

/** 时间轴上列这么多条。再多也没人往下翻，那是日志的活。 */
const TIMELINE_LIMIT = 12

export interface OverviewRouteDeps {
  startedAt: number
  auth: AuthLifecycle | null
  poll: Poller
  health: HealthMonitor
}

/**
 * 一屏看出系统是不是活着：轮询、cookie、队列、今日与本月 token、最近推送、挂着的故障。
 *
 * 一个端点给全，因为它们在页面上本来就是同一屏；拆成七八个只会变成七八次往返。
 * 全是本地读（库 + 内存快照），所以刷新它不会打任何外部请求。
 */
export function overviewRoutes(ports: Ports, deps: OverviewRouteDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const now = ports.clock.now()
      const body: OverviewResponse = {
        auth: deps.auth?.snapshot() ?? adapterMissingAuth(ports, now),
        poll: deps.poll.snapshot(),
        queue: queueSnapshot(ports),
        health: deps.health.snapshot(),
        usage: {
          today: usageSince(ports, startOfDay(now)),
          month: usageSince(ports, startOfMonth(now)),
        },
        deliveries: timeline(ports),
        version: ports.version,
        startedAt: deps.startedAt,
        uptimeMs: now - deps.startedAt,
        now,
      }
      return c.json(body)
    })

    // 手动跑一轮自查。cron 半小时一次，等不及的时候点它。
    .post('/check', async (c) => c.json(await deps.health.checkNow()))
}

function queueSnapshot(ports: Ports): QueueSnapshot {
  const counts = ports.repos.jobs.counts()
  const stages = ports.repos.jobs.runningStages()
  const asr = stages.filter((s) => s === 'download' || s === 'asr').length
  return {
    ...counts,
    // 剩下的都在占 LLM 那条通道（取字幕不占额度，但它也不该算进 ASR 那条）。
    inflight: { asr, llm: stages.length - asr },
  }
}

/** 本地时间的当天与当月起点：人看的是「今天用了多少」，不是 UTC 的今天。 */
function startOfDay(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function startOfMonth(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

const usageSince = (ports: Ports, ts: number): TokenUsage => ports.repos.llmCalls.usageSince(ts)

/** 推送时间轴。标题从对应的更新反查；告警没有更新可查，标题留空由页面按类型显示。 */
function timeline(ports: Ports): DeliveryEntry[] {
  return ports.repos.deliveries.recent(TIMELINE_LIMIT).map((d) => {
    const update = d.updateId.startsWith('alert:') ? null : ports.repos.updates.get(d.updateId)
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
