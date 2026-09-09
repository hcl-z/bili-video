import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import type { PollSnapshot, UpdatesResponse } from '#shared/contract/api.ts'
import type { Update } from '#shared/contract/update.ts'
import { Page } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { cn } from '@/lib/utils'

const TYPE_LABEL: Record<Update['type'], string> = {
  AV: '视频',
  DRAW: '图文',
  WORD: '文字',
  FORWARD: '转发',
  ARTICLE: '专栏',
}

export function UpdatesPage() {
  const qc = useQueryClient()
  const [showFiltered, setShowFiltered] = useState(true)

  const updates = useQuery({
    // showFiltered 进 key，两种视图各自缓存；SSE 按 ['updates'] 前缀失效，两边都会重取。
    queryKey: [...keys.updates, showFiltered],
    queryFn: () => api.updates({ includeFiltered: showFiltered }),
  })
  const system = useQuery({ queryKey: keys.system, queryFn: api.system })

  const poll = useMutation({
    mutationFn: api.pollNow,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.updates })
      void qc.invalidateQueries({ queryKey: keys.system })
      if (!r.ok) toast.error('这一轮没跑成', { description: r.reason ?? '原因不明' })
      else if (r.found === 0) toast.info(r.reason ?? '没有新动态')
      else {
        toast.success(`抓到 ${r.found} 条`, {
          description: r.blocked > 0 ? `其中 ${r.blocked} 条被规则拦下` : undefined,
        })
      }
    },
    onError: (err: Error) => toast.error('抓取失败', { description: err.message }),
  })

  return (
    <Page title="动态流" hint="每条动态为什么推了、为什么没推，都能在这儿看到原因。">
      {system.data !== undefined && <PollBanner poll={system.data.poll} />}
      {system.data !== undefined && <FloorHint floorTs={system.data.poll.floorTs} />}

      <div className="mb-4 flex items-center gap-4">
        <Button size="sm" onClick={() => poll.mutate()} disabled={poll.isPending}>
          {poll.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          立刻抓一轮
        </Button>
        <div className="flex items-center gap-2">
          <Switch
            id="show-filtered"
            checked={showFiltered}
            onCheckedChange={setShowFiltered}
            size="sm"
          />
          <Label htmlFor="show-filtered" className="text-sm font-normal">
            显示被拦下的
          </Label>
        </div>
      </div>

      <div className="space-y-2.5">
        {updates.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : updates.isError ? (
          <p className="text-destructive text-sm">{updates.error.message}</p>
        ) : updates.data.updates.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              还没抓到东西。确认订阅了 UP 主、小号也登录着，然后点上面那个按钮。
            </CardContent>
          </Card>
        ) : (
          updates.data.updates.map((u) => (
            <UpdateRow key={u.dynId} update={u} ups={updates.data.ups} />
          ))
        )}
      </div>
    </Page>
  )
}

/** 抓取地板每次启动重算，不写出来的话「为什么没抓到那条」会查很久。 */
const FloorHint = (props: { floorTs: number }) => (
  <p className="text-muted-foreground mb-4 text-sm">
    只抓 {formatTime(props.floorTs * 1000)}（本次启动）之后新发的。更早的投稿去
    <Link to="/reader/all" className="text-brand-ink hover:underline">
      阅读
    </Link>
    页按 UP 翻，翻到的能手动排解析。
  </p>
)

/** auth-lost 是终态：cron 已经被摘掉，不提示的话页面会安静地永远不更新。 */
function PollBanner(props: { poll: PollSnapshot }) {
  const { poll } = props
  if (poll.status === 'auth-lost') {
    return (
      <Card className="border-destructive/50 mb-4">
        <CardContent className="flex items-center gap-3 py-4 text-sm">
          <ShieldAlert className="text-destructive size-5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">登录已失效，轮询已停止</p>
            <p className="text-muted-foreground mt-0.5">
              去系统页重新扫码，扫上之后轮询会自己接着跑，不用重启。
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to="/system">重新登录</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }
  if (poll.status === 'backoff' && poll.resumeAt !== null) {
    const mins = Math.max(1, Math.ceil((poll.resumeAt - Date.now()) / 60_000))
    return (
      <p className="text-muted-foreground mb-4 text-sm">
        撞上风控或限流，退避中，约 {mins} 分钟后自动重试
        {poll.lastError === null ? '' : `（${poll.lastError}）`}
      </p>
    )
  }
  if (poll.status === 'disabled') {
    return <p className="text-muted-foreground mb-4 text-sm">定时轮询在配置里被关掉了</p>
  }
  return null
}

function UpdateRow(props: { update: Update; ups: UpdatesResponse['ups'] }) {
  const { update: u } = props
  const [open, setOpen] = useState(false)
  const up = props.ups[u.uid]
  const held = !u.filtered && u.filterReason !== null

  return (
    <Card className={cn(u.filtered && 'opacity-55')}>
      <CardContent className="py-3">
        <div className="flex gap-3">
          {u.cover !== null && (
            // B 站图床按 Referer 挡外链。
            <img
              src={u.cover}
              alt=""
              referrerPolicy="no-referrer"
              className="bg-muted h-16 w-28 shrink-0 rounded object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <a
                href={u.url}
                target="_blank"
                rel="noreferrer"
                className="line-clamp-2 flex-1 text-sm font-medium hover:underline"
              >
                {u.title ?? u.text ?? '(无标题)'}
              </a>
              <Badge variant="outline" className="shrink-0">
                {TYPE_LABEL[u.type]}
              </Badge>
            </div>

            {u.title !== null && u.text !== null && (
              <p className="text-muted-foreground mt-1 line-clamp-1 text-xs">{u.text}</p>
            )}

            <div className="text-muted-foreground mt-1.5 flex items-center gap-2 text-xs">
              {up?.face != null && (
                <img
                  src={up.face}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-4 shrink-0 rounded-full object-cover"
                />
              )}
              <span className="truncate">{up?.name ?? `uid ${u.uid}`}</span>
              <span>·</span>
              <span>{formatTime(u.pubTs * 1000)}</span>
              {u.filtered && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-1 px-1.5 text-xs"
                  onClick={() => setOpen(!open)}
                >
                  已拦下
                  <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
                </Button>
              )}
              {held && <Badge variant="secondary">免扰挂起</Badge>}
            </div>

            {(open || held) && u.filterReason !== null && (
              <p className="bg-muted/60 mt-2 rounded px-2 py-1.5 text-xs">{u.filterReason}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
