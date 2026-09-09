import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  Inbox,
  Loader2,
  Radio,
  RefreshCw,
  Stethoscope,
  UserRound,
  Workflow,
  XCircle,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import type { DeliveryEntry, FaultKind, OverviewResponse } from '#shared/contract/api.ts'
import { AUTH_STATE_LABEL, FAULT_LABEL, POLL_STATUS_LABEL } from '#shared/contract/api.ts'
import { DELIVERY_KIND_LABEL } from '#shared/contract/job.ts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatCount, formatSpan, formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { cn } from '@/lib/utils'

export function OverviewPage() {
  const overview = useQuery({ queryKey: keys.overview, queryFn: api.overview })

  return (
    <div className="h-[calc(100dvh-var(--appbar-h))] overflow-hidden p-4 sm:p-5 lg:p-6">
      <div className="flex h-full min-h-0 flex-col">
        <header className="mb-4 flex shrink-0 items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold tracking-tight">总览</h1>
            <span className="text-muted-foreground text-xs">实时</span>
          </div>
          {overview.data !== undefined && (
            <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
              {formatTime(overview.data.now)}
            </span>
          )}
        </header>

        {overview.isPending ? (
          <OverviewSkeleton />
        ) : overview.isError ? (
          <div className="border-destructive/30 bg-destructive/5 rounded-xl border px-5 py-4">
            <p className="text-destructive text-sm font-medium">状态读取失败</p>
            <p className="text-muted-foreground mt-1 text-sm">{overview.error.message}</p>
          </div>
        ) : (
          <Body data={overview.data} />
        )}
      </div>
    </div>
  )
}

function Body(props: { data: OverviewResponse }) {
  const qc = useQueryClient()
  const { data } = props
  const attention = getAttention(data)
  const isHealthy = attention.length === 0

  const check = useMutation({
    mutationFn: api.checkHealth,
    onSuccess: (snap) => {
      void qc.invalidateQueries({ queryKey: keys.overview })
      toast.success(
        snap.faults.length === 0 ? '自查通过' : `发现 ${snap.faults.length} 项故障`,
        snap.faults.length === 0 ? undefined : { description: snap.faults[0]!.message },
      )
    },
    onError: (err: Error) => toast.error('无法自查', { description: err.message }),
  })

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4">
      <section
        className={cn(
          'relative overflow-hidden rounded-xl border px-5 py-4',
          isHealthy ? 'bg-muted/30' : 'border-destructive/25 bg-destructive/[0.035]',
        )}
      >
        <div
          className={cn(
            'pointer-events-none absolute -top-16 right-10 size-44 rounded-full blur-3xl',
            isHealthy ? 'bg-brand/10' : 'bg-destructive/10',
          )}
          aria-hidden
        />
        <div className="relative flex items-center gap-5">
          <StatusOrb healthy={isHealthy} />

          <div className="min-w-44 shrink-0">
            <div className="flex items-center gap-2">
              <p className="text-lg font-semibold tracking-tight">
                {isHealthy ? '运行中' : attention[0]!.title}
              </p>
              {!isHealthy && (
                <span className="bg-destructive/10 text-destructive rounded-sm px-1.5 py-0.5 text-[10px] font-medium">
                  {attention.length}
                </span>
              )}
            </div>
            <p className="text-muted-foreground mt-1 max-w-72 truncate text-xs">
              {isHealthy
                ? data.poll.lastRunAt === null
                  ? '等待首次拉取'
                  : `上次拉取 ${formatTime(data.poll.lastRunAt)}`
                : attention[0]!.detail}
            </p>
          </div>

          <dl className="grid min-w-0 flex-1 grid-cols-4">
            <Metric icon={Inbox} label="待处理" value={`${data.queue.pending}`} />
            <Metric icon={Workflow} label="进行中" value={`${data.queue.running}`} />
            <Metric icon={Bot} label="今日调用" value={`${data.usage.today.calls}`} />
            <Metric icon={Clock3} label="运行时长" value={formatSpan(data.uptimeMs)} />
          </dl>

          <div className="flex shrink-0 items-center gap-2">
            {!isHealthy && (
              <Button asChild size="sm">
                <Link to={attention[0]!.to}>
                  处理
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            )}
            <Button
              variant="outline"
              size="icon-sm"
              title="立即自查"
              aria-label="立即自查"
              onClick={() => check.mutate()}
              disabled={check.isPending}
            >
              {check.isPending ? (
                <Loader2 className="size-3.5 motion-safe:animate-spin" />
              ) : (
                <RefreshCw className="size-3.5 transition-transform duration-300 hover:rotate-45" />
              )}
            </Button>
          </div>
        </div>
      </section>

      <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1.5fr)_minmax(17rem,0.85fr)]">
        <Deliveries entries={data.deliveries} />
        <StatusPanel data={data} attention={attention} />
      </div>
    </div>
  )
}

function StatusOrb(props: { healthy: boolean }) {
  return (
    <div className="relative flex size-14 shrink-0 items-center justify-center" aria-hidden>
      <span
        className={cn(
          'absolute inset-0 rounded-full border motion-safe:animate-[ping_2.8s_cubic-bezier(0,0,0.2,1)_infinite]',
          props.healthy ? 'border-emerald-500/35' : 'border-destructive/35',
        )}
      />
      <span
        className={cn(
          'absolute inset-2 rounded-full border motion-safe:animate-[pulse_2s_ease-in-out_infinite]',
          props.healthy ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-destructive/25 bg-destructive/5',
        )}
      />
      <span
        className={cn(
          'relative flex size-8 items-center justify-center rounded-full shadow-sm',
          props.healthy
            ? 'bg-emerald-500 text-white shadow-emerald-500/20'
            : 'bg-destructive text-destructive-foreground shadow-destructive/20',
        )}
      >
        {props.healthy ? <Check className="size-4" strokeWidth={2.5} /> : <AlertTriangle className="size-4" />}
      </span>
    </div>
  )
}

function Deliveries(props: { entries: DeliveryEntry[] }) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border">
      <header className="flex shrink-0 items-center justify-between border-b px-5 py-3.5">
        <div>
          <h2 className="text-sm font-medium">最近推送</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">内容、告警与发送结果</p>
        </div>
        <Button asChild variant="ghost" size="xs">
          <Link to="/targets">
            渠道
            <ArrowRight />
          </Link>
        </Button>
      </header>

      {props.entries.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center">
          <Radio className="text-muted-foreground/40 size-6" />
          <p className="mt-3 text-sm font-medium">暂无推送</p>
          <p className="text-muted-foreground mt-1 text-xs">等待下一条动态</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain">
          {props.entries.map((entry) => (
            <DeliveryRow key={`${entry.updateId}-${entry.channel}-${entry.kind}`} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  )
}

function DeliveryRow(props: { entry: DeliveryEntry }) {
  const { entry } = props
  const content = (
    <>
      <span
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          entry.status === 'sent'
            ? 'bg-emerald-500'
            : entry.status === 'failed'
              ? 'bg-destructive'
              : 'bg-muted-foreground/45 motion-safe:animate-pulse',
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{entry.title ?? entry.updateId}</span>
        <span className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span>{DELIVERY_KIND_LABEL[entry.kind]}</span>
          <span>·</span>
          <span>{entry.channel}</span>
          <span>·</span>
          <span className="font-mono tabular-nums">{formatTime(entry.at)}</span>
        </span>
        {entry.status === 'failed' && entry.error !== null && (
          <span className="text-destructive mt-1 block truncate text-xs">{entry.error}</span>
        )}
      </span>
      {entry.status === 'sent' ? (
        <CheckCircle2 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      ) : entry.status === 'failed' ? (
        <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
      ) : (
        <Loader2 className="text-muted-foreground mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
      )}
    </>
  )

  const className =
    'hover:bg-muted/45 flex items-start gap-3 px-5 py-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50'

  return (
    <li>
      {entry.url === null ? (
        <div className={className}>{content}</div>
      ) : (
        <a href={entry.url} target="_blank" rel="noreferrer" className={className}>
          {content}
        </a>
      )}
    </li>
  )
}

function StatusPanel(props: { data: OverviewResponse; attention: Attention[] }) {
  const { auth, poll, queue, health, usage } = props.data
  const pollBad = poll.status === 'backoff' || poll.status === 'auth-lost'
  const authBad = auth.state !== 'logged-in'

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border">
      <header className="flex shrink-0 items-center justify-between border-b px-5 py-3.5">
        <div>
          <h2 className="text-sm font-medium">状态</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">各模块实时快照</p>
        </div>
        <Stethoscope className="text-muted-foreground size-4" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {props.attention.length > 0 && (
          <div className="border-b">
            {props.attention.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                className="bg-destructive/[0.035] hover:bg-destructive/[0.07] focus-visible:ring-ring/50 flex items-start gap-3 border-b px-5 py-3 last:border-b-0 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset"
              >
                <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.title}</span>
                  <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                    {item.detail}
                  </span>
                </span>
                <ArrowRight className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              </Link>
            ))}
          </div>
        )}

        <div className="divide-y">
          <StatusRow
            icon={Radio}
            label="动态轮询"
            value={POLL_STATUS_LABEL[poll.status]}
            detail={poll.lastRunAt === null ? '尚未拉取' : formatTime(poll.lastRunAt)}
            to="/updates"
            tone={pollBad ? 'bad' : poll.status === 'running' ? 'active' : 'ok'}
          />
          <StatusRow
            icon={UserRound}
            label="B 站账号"
            value={auth.uname ?? AUTH_STATE_LABEL[auth.state]}
            detail={auth.remainingMs === null ? AUTH_STATE_LABEL[auth.state] : formatSpan(auth.remainingMs)}
            to="/system"
            tone={authBad ? 'bad' : 'ok'}
          />
          <StatusRow
            icon={Workflow}
            label="总结队列"
            value={queue.failed > 0 ? `${queue.failed} 失败` : `${queue.pending + queue.running} 活跃`}
            detail={`ASR ${queue.inflight.asr} · LLM ${queue.inflight.llm}`}
            to="/jobs"
            tone={queue.failed > 0 ? 'bad' : queue.running > 0 ? 'active' : 'ok'}
          />
          <StatusRow
            icon={Stethoscope}
            label="自动自查"
            value={health.faults.length > 0 ? `${health.faults.length} 故障` : '正常'}
            detail={health.enabled ? health.cron : '已关闭'}
            to="/logs"
            tone={health.faults.length > 0 ? 'bad' : health.enabled ? 'ok' : 'muted'}
          />
        </div>
      </div>

      <footer className="text-muted-foreground grid shrink-0 grid-cols-2 border-t text-[11px] tabular-nums">
        <span className="border-r px-4 py-2.5">今日 {formatCount(usage.today.inTokens + usage.today.outTokens)} token</span>
        <span className="px-4 py-2.5">本月 {formatCount(usage.month.inTokens + usage.month.outTokens)} token</span>
      </footer>
    </section>
  )
}

function StatusRow(props: {
  icon: typeof Radio
  label: string
  value: string
  detail: string
  to: string
  tone: 'ok' | 'active' | 'bad' | 'muted'
}) {
  const Icon = props.icon
  return (
    <Link
      to={props.to}
      className="hover:bg-muted/45 focus-visible:ring-ring/50 flex items-center gap-3 px-5 py-3.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
        <Icon className="text-muted-foreground size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="text-muted-foreground mt-0.5 block truncate font-mono text-[11px] tabular-nums">
          {props.detail}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs font-medium">
        <span
          className={cn(
            'size-1.5 rounded-full',
            props.tone === 'bad'
              ? 'bg-destructive'
              : props.tone === 'active'
                ? 'bg-brand motion-safe:animate-pulse'
                : props.tone === 'ok'
                  ? 'bg-emerald-500'
                  : 'bg-muted-foreground/40',
          )}
          aria-hidden
        />
        {props.value}
      </span>
    </Link>
  )
}

function Metric(props: { icon: typeof Inbox; label: string; value: string }) {
  const Icon = props.icon
  return (
    <div className="border-border/70 border-l px-5">
      <dt className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        <Icon className="size-3" />
        {props.label}
      </dt>
      <dd className="mt-1 font-mono text-lg font-semibold tracking-tight tabular-nums">{props.value}</dd>
    </div>
  )
}

type Attention = { key: string; title: string; detail: string; to: string }

const FAULT_ROUTE: Record<FaultKind, string> = {
  auth: '/system',
  poll: '/logs',
  asr: '/jobs',
}

function getAttention(data: OverviewResponse): Attention[] {
  const items: Attention[] = data.health.faults.map((fault) => ({
    key: `fault-${fault.kind}`,
    title: FAULT_LABEL[fault.kind],
    detail: `${fault.message} · ${formatTime(fault.since)}`,
    to: FAULT_ROUTE[fault.kind],
  }))
  const faultKinds = new Set(data.health.faults.map((fault) => fault.kind))

  if (data.auth.state !== 'logged-in' && !faultKinds.has('auth')) {
    items.push({
      key: 'auth-state',
      title: AUTH_STATE_LABEL[data.auth.state],
      detail: data.auth.lastError ?? '需要重新登录',
      to: '/system',
    })
  }
  if (
    (data.poll.status === 'backoff' || data.poll.status === 'auth-lost') &&
    !faultKinds.has('poll')
  ) {
    items.push({
      key: 'poll-state',
      title: POLL_STATUS_LABEL[data.poll.status],
      detail: data.poll.lastError ?? '轮询暂停',
      to: data.poll.status === 'auth-lost' ? '/system' : '/logs',
    })
  }
  if (data.queue.failed > 0) {
    items.push({
      key: 'queue-failed',
      title: `${data.queue.failed} 个任务失败`,
      detail: '可从失败步骤重跑',
      to: '/jobs',
    })
  }

  const failedDeliveries = data.deliveries.filter((entry) => entry.status === 'failed')
  if (failedDeliveries.length > 0) {
    items.push({
      key: 'delivery-failed',
      title: `${failedDeliveries.length} 条推送失败`,
      detail: failedDeliveries[0]!.error ?? '检查渠道配置',
      to: '/targets',
    })
  }

  return items
}

function OverviewSkeleton() {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[7rem_minmax(0,1fr)] gap-4">
      <Skeleton className="h-full w-full rounded-xl" />
      <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1.5fr)_minmax(17rem,0.85fr)]">
        <Skeleton className="h-full w-full rounded-xl" />
        <Skeleton className="h-full w-full rounded-xl" />
      </div>
    </div>
  )
}
