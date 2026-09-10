import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2, Play, RefreshCw, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import type { ParseState, ReaderItem, UpsMap } from '#shared/contract/api.ts'
import type { JobStage, SummaryJob } from '#shared/contract/job.ts'
import { JOB_STAGE_LABEL } from '#shared/contract/job.ts'
import { JobPipeline } from '@/components/job-pipeline'
import { TYPE_LABEL } from '@/components/reader-row'
import { SummaryReader } from '@/components/summary-reader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { useParseItem } from '@/lib/use-parse-item'

/**
 * 右栏：默认是原动态，解析完了才多一个「解析信息」的标签页。
 *
 * 没解析完不给第二个标签 —— 一个点不动的标签比没有标签更让人以为坏了。
 */
export function ReaderDetail(props: { item: ReaderItem; ups: UpsMap }) {
  const { item } = props
  /**
   * 解析状态只认详情这一份：它挂在 SSE 上，左栏那份是打开时的初值。
   * 两处各自判断的话，跑完之后左栏和右栏会说两句不一样的话。
   */
  const detail = useQuery({
    queryKey: [...keys.summaries, item.bvid],
    queryFn: () => api.summary(item.bvid ?? ''),
    enabled: item.bvid !== null,
  })
  const live = detail.data
  const state = live === undefined ? item.state : live.state === 'filtered' ? 'none' : live.state
  const parsed = state === 'done'

  // null = 还没手动切过，那就跟着状态走：跑完自动落到文章上，不用刷新。
  const [picked, setPicked] = useState<string | null>(null)
  const tab = picked ?? (parsed ? 'summary' : 'origin')

  const origin = (
    <Origin item={item} ups={props.ups} state={state} job={live?.job ?? null} stage={live?.job?.stage ?? item.jobStage} />
  )
  if (!parsed) return <div>{origin}</div>

  return (
    <Tabs value={tab} onValueChange={setPicked}>
      <div className="bg-background/85 sticky top-0 z-10 border-b px-5 py-2.5 backdrop-blur md:px-7">
        <TabsList>
          <TabsTrigger value="summary">解析信息</TabsTrigger>
          <TabsTrigger value="origin">{item.type === 'AV' ? '原视频' : '原动态'}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="summary">
        {item.bvid !== null && <SummaryReader key={item.bvid} bvid={item.bvid} />}
      </TabsContent>
      <TabsContent value="origin">{origin}</TabsContent>
    </Tabs>
  )
}

/** 原动态：B 站上那条长什么样，加上「要不要解析」这一个动作。 */
function Origin(props: {
  item: ReaderItem
  ups: UpsMap
  state: ParseState
  job: SummaryJob | null
  stage: JobStage | null
}) {
  const { item: it } = props
  const up = props.ups[it.uid]
  // 命中过规则（黑名单或免扰）。它拦的是自动解析与推送，不是这条视频。
  const blocked = it.filterReason

  return (
    <div className="mx-auto w-full max-w-[720px] px-5 pt-6 pb-24 md:px-7">
      {it.cover !== null && (
        // B 站图床按 Referer 挡外链。
        <img
          src={it.cover}
          alt=""
          referrerPolicy="no-referrer"
          className="bg-muted mb-5 aspect-video w-full rounded-lg border object-cover"
        />
      )}

      <h1 className="text-2xl leading-tight font-bold tracking-tight md:text-[27px]">
        {it.title ?? it.text ?? '(无标题)'}
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
          <p className="truncate text-sm font-semibold">{up?.name ?? `uid ${it.uid}`}</p>
          <p className="text-muted-foreground font-mono text-xs tabular-nums">
            {formatTime(it.pubTs * 1000)}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Badge variant="outline">{TYPE_LABEL[it.type]}</Badge>
          <Button asChild variant="ghost" size="sm">
            <a href={it.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              {it.type === 'AV' ? '看原片' : '去 B 站看'}
            </a>
          </Button>
        </div>
      </div>

      {blocked !== null && (
        <Notice tone="plain">
          <span className="min-w-0 flex-1">
            {blocked}。自动解析与推送跳过了这条，手动解析不受影响。
          </span>
          <Button asChild size="sm" variant="ghost" className="shrink-0">
            <Link to="/rules">规则页</Link>
          </Button>
        </Notice>
      )}

      {it.text !== null && (
        <div className="mb-6 space-y-3.5">
          {it.text
            .split(/\n+/)
            .map((para) => para.trim())
            .filter((para) => para !== '')
            .map((para) => (
              <p key={para} className="text-foreground/90 text-[15.5px] leading-[1.85] break-words">
                {para}
              </p>
            ))}
        </div>
      )}

      {it.desc !== null && it.desc !== it.text && (
        <section className="bg-card mb-6 rounded-lg border px-4 py-3.5">
          <h2 className="text-muted-foreground mb-2 text-[11.5px] font-bold tracking-wide">
            {it.type === 'AV' ? '视频简介' : '摘要'}
          </h2>
          <p className="text-foreground/90 text-[14.5px] leading-relaxed whitespace-pre-line">
            {it.desc}
          </p>
        </section>
      )}

      {it.pics.length > 1 && (
        <div className="mb-6 grid grid-cols-2 gap-2">
          {it.pics.map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              referrerPolicy="no-referrer"
              className="bg-muted w-full rounded-md border object-cover"
            />
          ))}
        </div>
      )}

      <ParseAction item={it} state={props.state} job={props.job} stage={props.stage} />
    </div>
  )
}

/** 解析这件事只对视频成立：其余四类既没字幕也没音轨，管线对它们无意义。 */
function ParseAction(props: {
  item: ReaderItem
  state: ParseState
  job: SummaryJob | null
  stage: JobStage | null
}) {
  const { item: it, job } = props
  const parse = useParseItem(it)
  if (it.bvid === null) return null

  const button = (label: string, icon: ReactNode) => (
    <Button size="sm" onClick={() => parse.mutate()} disabled={parse.isPending}>
      {parse.isPending ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : icon}
      {label}
    </Button>
  )
  const pipeline =
    job === null ? null : (
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <JobPipeline job={job} />
        <p className="text-muted-foreground text-xs">悬浮看详情，点刷新图标从该步重跑</p>
      </div>
    )

  switch (props.state) {
    case 'pending':
    case 'running':
      return (
        <div className="border-t pt-5">
          {pipeline}
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-3.5 motion-safe:animate-spin" />
            正在{JOB_STAGE_LABEL[props.stage ?? 'queued']}，跑完这里会多出「解析信息」标签页
          </p>
        </div>
      )
    case 'failed':
      return (
        <div className="border-t pt-5">
          {pipeline}
          <Notice tone="warn">
            <span>解析没成，停在「{JOB_STAGE_LABEL[props.stage ?? 'queued']}」。</span>
          </Notice>
          {button('从头再跑', <RefreshCw className="size-3.5" />)}
        </div>
      )
    case 'done':
      return (
        <div className="border-t pt-5">
          {pipeline}
          <div className="flex items-center gap-3">
            {button('从头重新解析', <RefreshCw className="size-3.5" />)}
            <p className="text-muted-foreground text-sm">重跑会覆盖现在这份总结。</p>
          </div>
        </div>
      )
    case 'none':
      return (
        <div className="border-t pt-5">
          {button('加入解析队列', <Play className="size-3.5" />)}
          <p className="text-muted-foreground mt-2.5 text-sm">
            定时抓取只管服务启动之后新发的，更早的投稿在这儿点一下就能解析。
          </p>
        </div>
      )
  }
}

function Notice(props: { tone: 'warn' | 'plain'; children: ReactNode }) {
  const warn = props.tone === 'warn'
  return (
    <p
      className={
        warn
          ? 'border-destructive/40 bg-destructive/5 mb-5 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm'
          : 'bg-muted/60 mb-5 flex items-center gap-2 rounded-lg px-4 py-3 text-sm'
      }
    >
      {warn && <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />}
      {props.children}
    </p>
  )
}
