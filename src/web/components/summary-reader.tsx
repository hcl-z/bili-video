import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileQuestion,
  Loader2,
  Play,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import type { SummaryDetailResponse } from '#shared/contract/api.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import { JOB_STAGE_LABEL } from '#shared/contract/job.ts'
import { DEGRADE_LABEL, TRANSCRIPT_SOURCE_LABEL } from '#shared/contract/summary.ts'
import { chapterLink, videoUrl } from '#shared/format.ts'
import { Markdown } from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatCount, formatDuration, formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { useRetryJob } from '@/lib/use-retry-job'


export function SummaryReader(props: { bvid: string }) {
  const q = useQuery({
    queryKey: [...keys.summaries, props.bvid],
    queryFn: () => api.summary(props.bvid),
  })

  if (q.isPending) {
    return (
      <Inner>
        <Skeleton className="mb-5 aspect-video w-full" />
        <Skeleton className="mb-3 h-8 w-3/4" />
        <Skeleton className="h-24 w-full" />
      </Inner>
    )
  }
  if (q.isError) {
    return (
      <Empty icon={TriangleAlert} title="读不出这条">
        {q.error.message}
      </Empty>
    )
  }

  const d = q.data
  switch (d.state) {
    case 'filtered':
      return <Filtered detail={d} />
    case 'done':
      return <Article detail={d} />
    case 'failed':
      if (d.job === null) return <NotInDb bvid={d.bvid} />
      // 重跑挂了但库里还留着上一次的好总结：给文章，失败原因挂在顶上
      return d.summary !== null && d.summary.degradePath !== 'link-only' ? (
        <Article detail={d} notice={<FailNotice job={d.job} />} />
      ) : (
        <Failed detail={d} job={d.job} />
      )
    case 'pending':
    case 'running':
      // 重跑：库里还留着上一次的总结，先给旧文章看，避免把页面清空
      return d.summary !== null ? (
        <Article detail={d} rerunning />
      ) : (
        <Empty icon={Loader2} spin title={`正在${JOB_STAGE_LABEL[d.job?.stage ?? 'queued']}`}>
          跑完这里就会变成文章。队列页能看到同一条的实时阶段。
        </Empty>
      )
    case 'none':
      return d.update === null ? <NotInDb bvid={d.bvid} /> : <NotQueued bvid={d.bvid} />
  }
}

function Article(props: { detail: SummaryDetailResponse; rerunning?: boolean; notice?: ReactNode }) {
  const { summary, update, up, usage, deliveries, bvid } = props.detail
  if (summary === null) return null

  return (
    <Inner>
      {update?.cover != null && (
        // B 站图床按 Referer 挡外链。
        <img
          src={update.cover}
          alt=""
          referrerPolicy="no-referrer"
          className="bg-muted mb-5 aspect-video w-full rounded-lg border object-cover"
        />
      )}

      <h1 className="text-2xl leading-tight font-bold tracking-tight md:text-[27px]">
        {update?.title ?? bvid}
      </h1>

      <div className="mt-3 mb-6 flex items-center gap-2.5">
        {up?.face != null && (
          <img
            src={up.face}
            alt=""
            referrerPolicy="no-referrer"
            className="bg-muted size-8 rounded-full object-cover"
          />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {up?.name ?? `uid ${update?.uid ?? '?'}`}
          </p>
          <p className="text-muted-foreground font-mono text-xs tabular-nums">
            {formatTime(update === null ? summary.createdAt : update.pubTs * 1000)}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {summary.confidence === 'low' && <Badge variant="destructive">低置信度</Badge>}
          <Badge variant="outline">{DEGRADE_LABEL[summary.degradePath]}</Badge>
          <Button asChild variant="ghost" size="sm">
            <a href={videoUrl(bvid)} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              看原片
            </a>
          </Button>
        </div>
      </div>

      {props.rerunning === true && (
        <p className="text-muted-foreground mb-4 flex items-center gap-2 text-sm">
          <Loader2 className="size-3.5 motion-safe:animate-spin" />
          正在重跑，下面还是上一次的结果
        </p>
      )}

      {props.notice}

      {summary.confidence === 'low' && (
        <p className="border-destructive/40 bg-destructive/5 mb-6 rounded-lg border px-4 py-3 text-sm">
          没拿到语音内容，以下是基于标题与简介的推测。
        </p>
      )}

      <Markdown text={summary.article} />

      {summary.degradePath !== 'meta-only' && summary.degradePath !== 'link-only' && (
        <Transcript bvid={bvid} />
      )}

      <dl className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-lg border md:grid-cols-4">
        <Cell label="处理路径" value={DEGRADE_LABEL[summary.degradePath]} />
        <Cell label="tokens" value={formatCount(usage.inTokens + usage.outTokens)} />
        <Cell
          label="耗时"
          value={usage.ms === 0 ? '—' : formatDuration(usage.ms)}
          hint={usage.calls > 1 ? `${usage.calls} 次调用` : null}
        />
        <Cell label="推送" value={pushLabel(deliveries)} />
      </dl>
    </Inner>
  )
}

/** 完整字幕/转写全文。点开才拉：它可能有几万字。 */
function Transcript(props: { bvid: string }) {
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: [...keys.summaries, props.bvid, 'transcript'],
    queryFn: () => api.transcript(props.bvid),
    enabled: open,
  })

  return (
    <section className="mb-8">
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {open ? '收起全文' : '看完整字幕'}
        {q.data !== undefined && (
          <span className="text-muted-foreground font-normal">
            {TRANSCRIPT_SOURCE_LABEL[q.data.source]}
          </span>
        )}
      </Button>

      {open && (
        <div className="mt-3 rounded-lg border">
          {q.isPending ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
            </div>
          ) : q.isError ? (
            <p className="text-muted-foreground p-4 text-sm">{q.error.message}</p>
          ) : (
            <ScrollArea className="h-[420px]">
              <div className="p-2">
                {parseCues(q.data.text).map((line, i) => (
                  <p
                    key={`${line.sec}-${i}`}
                    className="hover:bg-muted/60 grid grid-cols-[58px_1fr] gap-2 rounded-md px-2 py-1"
                  >
                    {line.sec === null ? (
                      <span />
                    ) : (
                      <a
                        href={chapterLink(props.bvid, line.sec)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand-ink hover:underline font-mono text-[12.5px] tabular-nums"
                      >
                        {line.stamp}
                      </a>
                    )}
                    <span className="text-[14px] leading-relaxed">{line.text}</span>
                  </p>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}
    </section>
  )
}

/** 每行形如 `[mm:ss] 内容`（超过一小时是 `h:mm:ss`）。认不出时间戳就整行当正文。 */
function parseCues(text: string): Array<{ stamp: string; sec: number | null; text: string }> {
  return text.split('\n').map((raw) => {
    const m = /^\[(\d{1,2}(?::\d{2})+)\]\s*(.*)$/.exec(raw)
    if (m === null) return { stamp: '', sec: null, text: raw }
    const parts = m[1]!.split(':').map(Number)
    const sec = parts.reduce((acc, n) => acc * 60 + n, 0)
    return { stamp: m[1]!, sec, text: m[2] ?? '' }
  })
}

/** 推送状态一句话。两票推送还没做，所以「未推送」是常态而不是异常。 */
function pushLabel(deliveries: SummaryDetailResponse['deliveries']): string {
  if (deliveries.length === 0) return '未推送'
  const failed = deliveries.filter((d) => d.status === 'failed').length
  const sent = deliveries.filter((d) => d.status === 'sent').length
  if (failed > 0) return `${failed} 处失败`
  if (sent === deliveries.length) return `已推 ${sent} 处`
  return `${sent}/${deliveries.length} 已推`
}

/** 重跑失败时挂在旧文章顶上的那条：说清停在哪儿，并给一次再试的机会。 */
function FailNotice(props: { job: SummaryJob }) {
  const retry = useRetryJob(props.job.id)
  return (
    <div className="border-destructive/40 bg-destructive/5 mb-6 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm">
      <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        重跑没成，停在「{JOB_STAGE_LABEL[props.job.stage]}」：{props.job.error ?? '原因不明'}
        。下面是上一次的结果。
      </p>
      <Button size="sm" variant="outline" onClick={() => retry.mutate({})} disabled={retry.isPending}>
        {retry.isPending ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        再试
      </Button>
    </div>
  )
}

/** 失败也得留下能推出去的最小内容：封面、标题、链接、失败原因。 */
function Failed(props: { detail: SummaryDetailResponse; job: SummaryJob }) {
  const { job } = props
  const { summary, update, bvid } = props.detail
  const retry = useRetryJob(job.id)
  // link-only 的那条最小记录里，正文就是每退一级的原因。
  const trail = summary?.degradePath === 'link-only' ? summary.article : ''

  return (
    <Inner>
      {update?.cover != null && (
        <img
          src={update.cover}
          alt=""
          referrerPolicy="no-referrer"
          className="bg-muted mb-5 aspect-video w-full rounded-lg border object-cover"
        />
      )}

      <h1 className="text-2xl leading-tight font-bold tracking-tight md:text-[27px]">
        {update?.title ?? bvid}
      </h1>

      <div className="mt-3 mb-6 flex items-center gap-2.5">
        <Badge variant="destructive">没总结成</Badge>
        <p className="text-muted-foreground font-mono text-xs tabular-nums">
          {formatTime(update === null ? job.updatedAt : update.pubTs * 1000)}
        </p>
        <Button asChild variant="ghost" size="sm" className="ml-auto shrink-0">
          <a href={videoUrl(bvid)} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" />
            看原片
          </a>
        </Button>
      </div>

      <p className="border-destructive/40 bg-destructive/5 mb-5 flex gap-2.5 rounded-lg border px-4 py-3 text-sm">
        <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
        <span>
          停在「{JOB_STAGE_LABEL[job.stage]}」：{job.error ?? '原因不明'}
        </span>
      </p>

      {trail !== '' && (
        <>
          <SectionLabel>一路退到哪儿了</SectionLabel>
          <div className="mb-6">
            <Markdown text={trail} />
          </div>
        </>
      )}

      <p className="text-muted-foreground text-sm">
        重跑是幂等的，同一条任务、同一份总结，不会产生第二条数据。
      </p>
      <Button className="mt-4" size="sm" onClick={() => retry.mutate({})} disabled={retry.isPending}>
        {retry.isPending ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        再跑一次
      </Button>
    </Inner>
  )
}

function Filtered(props: { detail: SummaryDetailResponse }) {
  return (
    <Empty icon={Ban} title="这条被过滤了，没有调用 AI">
      <p className="bg-muted/60 rounded-md px-3 py-2 text-left text-sm">
        {props.detail.update?.filterReason ?? '命中了某条规则，但库里没记下是哪条'}
      </p>
      <p className="mt-3">
        既不总结也不推送，只留一行日志，所以不花 tokens。想放行就去规则页把关键词挪进白名单，
        或者对这个 UP 主单独关掉黑名单。
      </p>
      <Button asChild className="mt-4" size="sm" variant="outline">
        <Link to="/rules">打开规则页</Link>
      </Button>
    </Empty>
  )
}

/** 抓到过但没进队列：多半是开关后来才打开的，那一轮已经过去了，所以给一颗手动的按钮。 */
function NotQueued(props: { bvid: string }) {
  const qc = useQueryClient()
  const run = useMutation({
    mutationFn: () => api.runSummary(props.bvid),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.jobs })
      void qc.invalidateQueries({ queryKey: keys.summaries })
      toast.success('已排上队')
    },
    onError: (err: Error) => toast.error('没排上队', { description: err.message }),
  })
  return (
    <Empty icon={FileQuestion} title="这条没进队列">
      <p>
        抓到它的那一轮，要么这个 UP 的 AI 开关关着，要么 AI 总开关关着。现在就想要总结的话，
        点下面这颗按钮单独排一条。
      </p>
      <Button className="mt-4" size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
        {run.isPending ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" />
        ) : (
          <Play className="size-3.5" />
        )}
        现在就总结
      </Button>
      <p className="mt-3">
        想让以后的新动态自动总结，去「AI 与 ASR」或「UP 主」页把开关打开。
      </p>
    </Empty>
  )
}

const NotInDb = (props: { bvid: string }) => (
  <Empty icon={FileQuestion} title="库里没有这条">
    {props.bvid} 不在抓到过的动态里。轮询只从订阅的 UP 主那儿取动态，不按 BV 号抓视频。
  </Empty>
)

const Inner = (props: { children: ReactNode }) => (
  <div className="mx-auto w-full max-w-[720px] px-5 pt-7 pb-24 md:px-7">{props.children}</div>
)

const SectionLabel = (props: { children: ReactNode }) => (
  <p className="text-muted-foreground mb-3 text-xs font-bold tracking-wide">{props.children}</p>
)

function Cell(props: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-muted-foreground mb-1 text-[11.5px]">{props.label}</dt>
      <dd className="font-mono text-[13.5px] font-semibold tabular-nums">
        {props.value}
        {props.hint != null && (
          <span className="text-muted-foreground ml-1.5 font-sans text-xs font-normal">
            {props.hint}
          </span>
        )}
      </dd>
    </div>
  )
}

function Empty(props: { icon: LucideIcon; title: string; spin?: boolean; children: ReactNode }) {
  const Icon = props.icon
  return (
    <div className="text-muted-foreground mx-auto max-w-[520px] px-6 py-20 text-center text-sm">
      <Icon className={props.spin === true ? 'mx-auto size-9 motion-safe:animate-spin' : 'mx-auto size-9'} />
      <h2 className="text-foreground mt-3.5 mb-2 text-[17px] font-semibold">{props.title}</h2>
      {props.children}
    </div>
  )
}
