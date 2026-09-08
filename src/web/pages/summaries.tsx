import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, FileText, Loader2, Play } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

import type { SummariesResponse, SummaryFeedItem } from '#shared/contract/api.ts'
import { SUMMARY_STATE_LABEL } from '#shared/contract/api.ts'
import { DEGRADE_LABEL } from '#shared/contract/summary.ts'
import { SummaryReader } from '@/components/summary-reader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { useRunAllSummaries } from '@/lib/use-run-summary'
import { cn } from '@/lib/utils'

/**
 * 分栏阅读：左边索引，右边把选中那条当文章读。
 *
 * 窄屏收成一栏 —— 选了一条就只显示文章，没选就只显示索引，两栏不挤在一起。
 */
export function SummariesPage() {
  const selected = useParams().bvid ?? null
  const q = useQuery({ queryKey: keys.summaries, queryFn: api.summaries })
  const runAll = useRunAllSummaries()

  return (
    <div className="lg:grid lg:h-[calc(100dvh-var(--appbar-h))] lg:grid-cols-[320px_1fr] xl:grid-cols-[364px_1fr]">
      <aside
        className={cn(
          'overflow-y-auto border-r lg:h-full lg:block',
          selected !== null && 'hidden',
        )}
      >
        <div className="bg-background/85 sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-3 backdrop-blur">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold">总结</h1>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {q.data === undefined ? '正在读…' : indexHint(q.data)}
            </p>
          </div>
          {pendingCount(q.data) > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => runAll.mutate()}
              disabled={runAll.isPending}
            >
              {runAll.isPending ? (
                <Loader2 className="size-3.5 motion-safe:animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              补 {pendingCount(q.data)} 条
            </Button>
          )}
        </div>

        {q.isPending ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : q.isError ? (
          <p className="text-destructive p-4 text-sm">{q.error.message}</p>
        ) : q.data.items.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">
            还没有视频动态。订阅了 UP 主、抓到过动态之后，这里才会有东西。
          </p>
        ) : (
          <ul>
            {q.data.items.map((it) => (
              <IndexRow key={it.bvid} item={it} ups={q.data.ups} selected={it.bvid === selected} />
            ))}
          </ul>
        )}
      </aside>

      <div className={cn('overflow-y-auto lg:h-full', selected === null && 'hidden lg:block')}>
        {selected === null ? (
          <div className="text-muted-foreground px-6 py-24 text-center text-sm">
            <FileText className="mx-auto size-9" />
            <p className="mt-3.5">从左边挑一条，这里当文章读。</p>
          </div>
        ) : (
          <>
            <Link
              to="/summaries"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 px-5 pt-5 text-sm lg:hidden"
            >
              <ChevronLeft className="size-4" />
              回索引
            </Link>
            <SummaryReader key={selected} bvid={selected} />
          </>
        )}
      </div>
    </div>
  )
}

/** 能补的条数：没总结、没在队列里、也没被拦下的。 */
const pendingCount = (d: SummariesResponse | undefined): number =>
  d === undefined ? 0 : d.items.filter((i) => i.state === 'none').length

const indexHint = (d: SummariesResponse): string =>
  d.filteredCount === 0
    ? `${d.items.length} 条`
    : `${d.items.length} 条，其中 ${d.filteredCount} 条被拦下`

function IndexRow(props: {
  item: SummaryFeedItem
  ups: SummariesResponse['ups']
  selected: boolean
}) {
  const { item: it } = props
  const up = props.ups[it.uid]
  const filtered = it.state === 'filtered'

  return (
    <li>
      <Link
        to={`/summaries/${it.bvid}`}
        aria-current={props.selected ? 'page' : undefined}
        className={cn(
          'hover:bg-muted/60 grid grid-cols-[96px_1fr] gap-3 border-b border-l-2 border-l-transparent px-3.5 py-3',
          props.selected && 'border-l-brand-ink bg-brand/[0.07] hover:bg-brand/[0.07]',
          filtered && 'opacity-55',
        )}
      >
        {it.cover === null ? (
          <div className="bg-muted aspect-video w-full rounded-sm" />
        ) : (
          // B 站图床按 Referer 挡外链。
          <img
            src={it.cover}
            alt=""
            referrerPolicy="no-referrer"
            className={cn(
              'bg-muted aspect-video w-full rounded-sm object-cover',
              filtered && 'grayscale',
            )}
          />
        )}
        <div className="min-w-0">
          <h2
            className={cn(
              'line-clamp-2 text-[13.5px] leading-snug font-medium',
              filtered && 'text-muted-foreground line-through',
            )}
          >
            {it.title}
          </h2>
          <div className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate">{up?.name ?? `uid ${it.uid}`}</span>
            <span className="font-mono tabular-nums">{formatTime(it.pubTs * 1000)}</span>
          </div>
          <div className="mt-1.5">
            <StateBadge item={it} />
          </div>
        </div>
      </Link>
    </li>
  )
}

/** 已总结的直接把降级路径写出来，那才是这行真正的信息。 */
function StateBadge(props: { item: SummaryFeedItem }) {
  const { state, degradePath } = props.item
  if (state === 'done' && degradePath !== null) {
    const weak = degradePath === 'meta-only' || degradePath === 'link-only'
    return (
      <Badge variant={weak ? 'destructive' : 'secondary'}>{DEGRADE_LABEL[degradePath]}</Badge>
    )
  }
  return (
    <Badge variant={state === 'failed' ? 'destructive' : 'outline'}>
      {SUMMARY_STATE_LABEL[state]}
    </Badge>
  )
}
