import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, Stethoscope, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import type { DeliveryEntry, OverviewResponse } from '#shared/contract/api.ts'
import { AUTH_STATE_LABEL, FAULT_LABEL, POLL_STATUS_LABEL } from '#shared/contract/api.ts'
import { DELIVERY_KIND_LABEL } from '#shared/contract/job.ts'
import { Page } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatCount, formatSpan, formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { cn } from '@/lib/utils'

export function OverviewPage() {
  const overview = useQuery({ queryKey: keys.overview, queryFn: api.overview })

  return (
    <Page title="总览" hint="轮询、登录、队列、用量、推送，以及现在挂着的故障。">
      {overview.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : overview.isError ? (
        <p className="text-destructive text-sm">连不上后端：{overview.error.message}</p>
      ) : (
        <Body data={overview.data} />
      )}
    </Page>
  )
}

function Body(props: { data: OverviewResponse }) {
  const qc = useQueryClient()
  const { auth, poll, queue, health, usage } = props.data

  const check = useMutation({
    mutationFn: api.checkHealth,
    onSuccess: (snap) => {
      void qc.invalidateQueries({ queryKey: keys.overview })
      toast.success(
        snap.faults.length === 0 ? '自查通过' : `发现 ${snap.faults.length} 项故障`,
        snap.faults.length === 0 ? undefined : { description: snap.faults[0]!.message },
      )
    },
    onError: (err: Error) => toast.error('查不了', { description: err.message }),
  })

  return (
    <div className="space-y-4">
      {health.faults.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="space-y-2.5 py-4">
            {health.faults.map((f) => (
              <div key={f.kind} className="flex gap-2.5 text-sm">
                <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">{FAULT_LABEL[f.kind]}</p>
                  <p className="text-muted-foreground mt-0.5 break-words">{f.message}</p>
                  <p className="text-muted-foreground mt-0.5 font-mono text-xs tabular-nums">
                    自 {formatTime(f.since)} 起，已经推过一条通知
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="divide-y py-1">
          <Row label="轮询">
            <span className="flex items-center gap-2">
              <Badge variant={poll.status === 'idle' || poll.status === 'running' ? 'outline' : 'destructive'}>
                {POLL_STATUS_LABEL[poll.status]}
              </Badge>
              {poll.consecutiveFailures > 0 && (
                <span className="text-muted-foreground text-xs">
                  连续失败 {poll.consecutiveFailures} 次
                </span>
              )}
            </span>
          </Row>
          <Row label="上次拉取">
            {poll.lastRunAt === null ? (
              <span className="text-muted-foreground">本次启动后还没跑过</span>
            ) : (
              <span className="flex items-center gap-2">
                <Mono>{formatTime(poll.lastRunAt)}</Mono>
                {poll.lastOk === true ? (
                  <CheckCircle2 className="size-3.5 text-emerald-500" />
                ) : (
                  <XCircle className="text-destructive size-3.5" />
                )}
              </span>
            )}
          </Row>
          {poll.lastError !== null && <Row label="上次原因">{poll.lastError}</Row>}
          <Row label="登录">
            <span className="flex items-center gap-2">
              <Badge variant={auth.state === 'logged-in' ? 'outline' : 'destructive'}>
                {AUTH_STATE_LABEL[auth.state]}
              </Badge>
              {auth.uname !== null && <span>{auth.uname}</span>}
            </span>
          </Row>
          <Row label="cookie 剩余">
            {auth.remainingMs === null ? (
              <span className="text-muted-foreground">无从判断</span>
            ) : (
              <Mono
                className={cn(auth.remainingMs < 3 * 86_400_000 && 'text-destructive font-medium')}
              >
                {formatSpan(auth.remainingMs)}
              </Mono>
            )}
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="divide-y py-1">
          <Row label="队列待处理">
            <Mono>{queue.pending}</Mono>
          </Row>
          <Row label="进行中">
            <span className="flex items-center gap-2">
              <Mono>{queue.running}</Mono>
              <span className="text-muted-foreground flex gap-3 text-xs">
                <span>转写 {queue.inflight.asr}</span>
                <span>总结 {queue.inflight.llm}</span>
              </span>
            </span>
          </Row>
          <Row label="失败">
            <Mono className={cn(queue.failed > 0 && 'text-destructive font-medium')}>
              {queue.failed}
            </Mono>
          </Row>
          <Row label="已完成">
            <Mono>{queue.done}</Mono>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="divide-y py-1">
          <Row label="今日 token">
            <Usage usage={usage.today} />
          </Row>
          <Row label="本月 token">
            <Usage usage={usage.month} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <h2 className="mb-1 text-sm font-medium">最近推送</h2>
          {props.data.deliveries.length === 0 ? (
            <p className="text-muted-foreground text-sm">还没有推送记录。</p>
          ) : (
            <ul className="divide-y">
              {props.data.deliveries.map((d) => (
                <DeliveryRow key={`${d.updateId}-${d.channel}-${d.kind}`} entry={d} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Stethoscope className="size-4" />
          )}
          立即自查
        </Button>
        <p className="text-muted-foreground text-xs">
          {health.enabled ? `每 ${health.cron} 自动跑一轮` : '自动自查已关闭'}
          {health.lastCheckAt === null
            ? '，本次启动后还没查过'
            : `，上次 ${formatTime(health.lastCheckAt)}`}
        </p>
      </div>

      <div className="text-muted-foreground flex gap-3 text-xs">
        <span>v{props.data.version}</span>
        <span>已运行 {formatSpan(props.data.uptimeMs)}</span>
        <span>只听 127.0.0.1</span>
      </div>
    </div>
  )
}

function DeliveryRow(props: { entry: DeliveryEntry }) {
  const d = props.entry
  return (
    <li className="flex items-baseline gap-3 py-2 text-sm">
      <Mono className="text-muted-foreground w-24 shrink-0">{formatTime(d.at)}</Mono>
      <span className="text-muted-foreground w-8 shrink-0 text-xs">
        {DELIVERY_KIND_LABEL[d.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {d.url === null ? (
          (d.title ?? d.updateId)
        ) : (
          <a href={d.url} target="_blank" rel="noreferrer" className="hover:underline">
            {d.title ?? d.updateId}
          </a>
        )}
      </span>
      {d.status === 'sent' ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
      ) : d.status === 'failed' ? (
        <XCircle className="text-destructive size-3.5 shrink-0" />
      ) : (
        <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
      )}
    </li>
  )
}

function Usage(props: { usage: OverviewResponse['usage']['today'] }) {
  const u = props.usage
  return (
    <span className="flex items-baseline gap-3">
      <Mono>{formatCount(u.inTokens + u.outTokens)}</Mono>
      <span className="text-muted-foreground flex gap-3 text-xs">
        <span>入 {formatCount(u.inTokens)}</span>
        <span>出 {formatCount(u.outTokens)}</span>
        <span>{u.calls} 次调用</span>
      </span>
    </span>
  )
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
      <span className="text-muted-foreground shrink-0">{props.label}</span>
      <span className="min-w-0 text-right">{props.children}</span>
    </div>
  )
}

function Mono(props: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-xs tabular-nums', props.className)}>{props.children}</span>
  )
}
