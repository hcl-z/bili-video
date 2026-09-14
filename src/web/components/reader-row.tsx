import { Link, type LinkProps } from 'react-router-dom'

import type { ReaderItem, UpsMap } from '#shared/contract/api.ts'
import { PARSE_STATE_LABEL } from '#shared/contract/api.ts'
import { JOB_STAGE_LABEL } from '#shared/contract/job.ts'
import { DEGRADE_LABEL } from '#shared/contract/summary.ts'
import { Badge } from '@/components/ui/badge'
import { formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

export const TYPE_LABEL: Record<ReaderItem['type'], string> = {
  AV: '视频',
  DRAW: '图文',
  WORD: '文字',
  FORWARD: '转发',
  ARTICLE: '专栏',
  LIVE: '直播',
}

/** 左栏一行：96px 封面 + 两行标题 + 解析状态。选中用强调色左边框。 命中过过滤规则的条目在此处不降饱和、不打删除线 —— 规则拦的是自动解析与推送， 不是应项视频本身 */
export function ReaderRow(props: {
  item: ReaderItem
  ups: UpsMap
  to: LinkProps['to']
  selected: boolean
}) {
  const { item: it } = props
  const up = props.ups[it.uid]

  return (
    <li>
      <Link
        to={props.to}
        aria-current={props.selected ? 'page' : undefined}
        className={cn(
          'hover:bg-muted/60 grid grid-cols-[96px_1fr] gap-3 border-b border-l-2 border-l-transparent px-3.5 py-3',
          props.selected && 'border-l-brand-ink bg-brand/[0.07] hover:bg-brand/[0.07]',
        )}
      >
        {it.cover === null ? (
          <div className="bg-muted flex aspect-video w-full items-center justify-center rounded-sm">
            <span className="text-muted-foreground text-[11px]">{TYPE_LABEL[it.type]}</span>
          </div>
        ) : (
          // B 站图床按 Referer 挡外链
          <img
            src={it.cover}
            alt=""
            referrerPolicy="no-referrer"
            className="bg-muted aspect-video w-full rounded-sm object-cover"
          />
        )}
        <div className="min-w-0">
          <h2 className="line-clamp-2 text-[13.5px] leading-snug font-medium">
            {it.title ?? it.text ?? '(无标题)'}
          </h2>
          <div className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate">{up?.name ?? `uid ${it.uid}`}</span>
            <span className="font-mono tabular-nums">{formatTime(it.pubTs * 1000)}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Badge variant="outline">{TYPE_LABEL[it.type]}</Badge>
            <StateBadge item={it} />
          </div>
        </div>
      </Link>
    </li>
  )
}

/** 解析完的直接把降级路径写出来，在跑的写卡在哪一步 —— 那才是这行真正的信息。 */
function StateBadge(props: { item: ReaderItem }) {
  const { state, degradePath, jobStage, bvid } = props.item
  // 非视频没有解析这件事，标一个「未解析」只会让人以为在等什么。
  if (bvid === null) return null
  if (state === 'done' && degradePath !== null) {
    const weak = degradePath === 'meta-only' || degradePath === 'link-only'
    return <Badge variant={weak ? 'destructive' : 'secondary'}>{DEGRADE_LABEL[degradePath]}</Badge>
  }
  if (state === 'running' && jobStage !== null) {
    return <Badge variant="secondary">{JOB_STAGE_LABEL[jobStage]}</Badge>
  }
  return (
    <Badge variant={state === 'failed' ? 'destructive' : 'outline'}>
      {PARSE_STATE_LABEL[state]}
    </Badge>
  )
}
