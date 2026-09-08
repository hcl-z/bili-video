import { useQuery } from '@tanstack/react-query'
import { Ban, ExternalLink, FileQuestion, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import type { SummaryDetailResponse } from '#shared/contract/api.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import { JOB_STAGE_LABEL } from '#shared/contract/job.ts'
import { DEGRADE_LABEL } from '#shared/contract/summary.ts'
import { chapterLink, hms, videoUrl } from '#shared/format.ts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatCount, formatDuration, formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { useRetryJob } from '@/lib/use-retry-job'

/** 右栏：把总结当文章读。限宽 720px，与原型 variant=B 一致。 */
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
      return d.job === null ? <NotInDb bvid={d.bvid} /> : <Failed job={d.job} />
    case 'pending':
    case 'running':
      // 重跑：库里还留着上一次的总结，先给旧文章看，别把页面清空。
      return d.summary !== null ? (
        <Article detail={d} rerunning />
      ) : (
        <Empty icon={Loader2} spin title={`正在${JOB_STAGE_LABEL[d.job?.stage ?? 'queued']}`}>
          跑完这里就会变成文章。队列页能看到同一条的实时阶段。
        </Empty>
      )
    case 'none':
      return d.update === null ? (
        <NotInDb bvid={d.bvid} />
      ) : (
        <Empty icon={FileQuestion} title="这条没进队列">
          要么这个 UP 的 AI 开关关着，要么 AI 总开关关着。去「AI 与 ASR」或「UP 主」页打开，
          之后新动态就会自动总结。
        </Empty>
      )
  }
}

function Article(props: { detail: SummaryDetailResponse; rerunning?: boolean }) {
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

      {summary.confidence === 'low' && (
        <p className="border-destructive/40 bg-destructive/5 mb-6 rounded-lg border px-4 py-3 text-sm">
          没拿到语音内容，以下是基于标题与简介的推测。
        </p>
      )}

      <p className="border-brand/25 bg-brand/[0.07] mb-7 rounded-lg border px-5 py-4 text-lg leading-relaxed font-medium">
        {summary.tldr}
      </p>

      <SectionLabel>核心要点</SectionLabel>
      <ol className="mb-8">
        {summary.points.map((p, i) => (
          <li
            key={p}
            className="text-foreground/90 grid grid-cols-[26px_1fr] gap-3.5 border-t py-3 text-[15px] leading-relaxed last:border-b"
          >
            <span className="text-brand-ink font-mono text-[13px] font-bold tabular-nums">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span>{p}</span>
          </li>
        ))}
      </ol>

      {summary.chapters.length > 0 && (
        <>
          <SectionLabel>分段导读，点任意一段跳到 B 站对应时间点</SectionLabel>
          <div className="mb-8 grid gap-0.5">
            {summary.chapters.map((ch) => (
              <a
                key={`${ch.startSec}-${ch.title}`}
                href={chapterLink(bvid, ch.startSec)}
                target="_blank"
                rel="noreferrer"
                className="hover:bg-muted group grid grid-cols-[56px_1fr_auto] items-center gap-3 rounded-md px-3 py-2.5"
              >
                <time className="text-brand-ink font-mono text-[13px] font-semibold tabular-nums">
                  {hms(ch.startSec)}
                </time>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{ch.title}</span>
                  {ch.desc !== null && (
                    <span className="text-muted-foreground block truncate text-[13px]">
                      {ch.desc}
                    </span>
                  )}
                </span>
                <ExternalLink className="text-muted-foreground size-4 opacity-0 group-hover:opacity-100" />
              </a>
            ))}
          </div>
        </>
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

/** 推送状态一句话。两票推送还没做，所以「未推送」是常态而不是异常。 */
function pushLabel(deliveries: SummaryDetailResponse['deliveries']): string {
  if (deliveries.length === 0) return '未推送'
  const failed = deliveries.filter((d) => d.status === 'failed').length
  const sent = deliveries.filter((d) => d.status === 'sent').length
  if (failed > 0) return `${failed} 处失败`
  if (sent === deliveries.length) return `已推 ${sent} 处`
  return `${sent}/${deliveries.length} 已推`
}

function Failed(props: { job: SummaryJob }) {
  const { job } = props
  const retry = useRetryJob(job.id)

  return (
    <Empty icon={TriangleAlert} title="这条没总结成">
      <p className="bg-muted/60 rounded-md px-3 py-2 text-left text-sm">
        停在「{JOB_STAGE_LABEL[job.stage]}」：{job.error ?? '原因不明'}
      </p>
      <p className="mt-3">重跑是幂等的，同一条任务、同一份总结，不会产生第二条数据。</p>
      <Button className="mt-4" size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
        {retry.isPending ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        再跑一次
      </Button>
    </Empty>
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
