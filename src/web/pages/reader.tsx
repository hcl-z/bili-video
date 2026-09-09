import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { BookOpen, ChevronLeft, Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useInView } from 'react-intersection-observer'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import type { ReaderItem, UpFeedResponse, UpsMap } from '#shared/contract/api.ts'
import { ReaderDetail } from '@/components/reader-detail'
import { ReaderRow } from '@/components/reader-row'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'
import { cn } from '@/lib/utils'

/** 左栏的类型筛选。选中项进 URL，刷新和分享都不丢。 */
type Kind = 'all' | 'video' | 'post'

const KINDS: ReadonlyArray<[Kind, string]> = [
  ['all', '全部'],
  ['video', '视频'],
  ['post', '图文动态'],
]

const readKind = (raw: string | null): Kind => (raw === 'video' || raw === 'post' ? raw : 'all')

const matchesKind = (item: ReaderItem, kind: Kind): boolean =>
  kind === 'all' || (kind === 'video' ? item.type === 'AV' : item.type !== 'AV')

/**
 * 阅读页：顶上是订阅的 UP 头像，选中谁就看谁。
 *
 * 左栏是**现拉的 B 站空间流**，不是本地库的投影 —— 定时抓取只要启动之后新发的，
 * 更早的投稿只能从这儿翻到，翻到哪条都能手动排解析。
 */
export function ReaderPage() {
  const params = useParams()
  const navigate = useNavigate()
  const uid = params.uid ?? null
  const selected = params.dynId ?? null

  const subs = useQuery({ queryKey: keys.subs, queryFn: api.subs })
  const list = subs.data?.subs ?? []
  const ups: UpsMap = {}
  for (const s of list) ups[s.uid] = { name: s.name, face: s.face }

  // 没指定 UP 时落到第一个订阅上：这一页离开某个 UP 就没有内容可言。
  const firstUid = list[0]?.uid ?? null
  useEffect(() => {
    if (uid === null && firstUid !== null) navigate(`/reader/${firstUid}`, { replace: true })
  }, [uid, firstUid, navigate])

  return (
    <div className="lg:grid lg:h-[calc(100dvh-var(--appbar-h))] lg:grid-rows-[auto_1fr]">
      <div className="flex items-center gap-1.5 overflow-x-auto border-b px-3 py-2.5">
        {list.map((s) => (
          <UpChip
            key={s.uid}
            to={`/reader/${s.uid}`}
            active={uid === s.uid}
            name={s.name}
            face={s.face}
          />
        ))}
        {!subs.isPending && list.length === 0 && (
          <p className="text-muted-foreground px-2 text-sm">
            还没订阅 UP 主，先去{' '}
            <Link to="/subs" className="text-brand-ink hover:underline">
              UP 主
            </Link>{' '}
            页加一个。
          </p>
        )}
      </div>

      {uid === null ? (
        <div className="text-muted-foreground px-6 py-24 text-center text-sm">
          <BookOpen className="mx-auto size-9" />
          <p className="mt-3.5">从上面挑一个 UP 主。</p>
        </div>
      ) : (
        <Split key={uid} uid={uid} ups={ups} selected={selected} />
      )}
    </div>
  )
}

/** 左栏空间流 + 右栏详情。key 挂在 uid 上，换 UP 就是换一份列表。 */
function Split(props: { uid: string; ups: UpsMap; selected: string | null }) {
  const { uid, selected } = props
  const [params, setParams] = useSearchParams()
  const kind = readKind(params.get('kind'))
  const feed = useInfiniteQuery({
    queryKey: [...keys.upFeed, uid],
    queryFn: ({ pageParam }) => api.upFeed(uid, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: UpFeedResponse) =>
      last.hasMore && last.offset !== null ? last.offset : undefined,
    // 每页都是一次出网请求，别让头像点来点去反复打 B 站。
    staleTime: 5 * 60_000,
  })
  const all = feed.data?.pages.flatMap((p) => p.items) ?? []
  // 在客户端筛：B 站的空间流没有按类型取的参数，服务端筛也是先全拉回来再挑。
  const items = all.filter((i) => matchesKind(i, kind))
  const item = all.find((i) => i.dynId === selected) ?? null

  return (
    <div className="lg:grid lg:min-h-0 lg:grid-cols-[320px_1fr] xl:grid-cols-[364px_1fr]">
      <aside
        className={cn('overflow-y-auto border-r lg:block lg:h-full', selected !== null && 'hidden')}
      >
        <div className="bg-background/85 sticky top-0 z-10 border-b px-4 py-3 backdrop-blur">
          <div className="mt-2.5 flex gap-1">
            {KINDS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-current={kind === value ? 'true' : undefined}
                onClick={() => {
                  const next = new URLSearchParams(params)
                  if (value === 'all') next.delete('kind')
                  else next.set('kind', value)
                  setParams(next, { replace: true })
                }}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[12px] transition-colors',
                  kind === value
                    ? 'bg-brand/[0.12] text-brand-ink font-medium'
                    : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Lane
          feed={feed}
          items={items}
          ups={props.ups}
          selected={selected}
          uid={uid}
          search={params.toString()}
        />
      </aside>

      <div className={cn('overflow-y-auto lg:h-full', selected === null && 'hidden lg:block')}>
        {selected === null ? (
          <div className="text-muted-foreground px-6 py-24 text-center text-sm">
            <BookOpen className="mx-auto size-9" />
            <p className="mt-3.5">从左边挑一条，这里当文章读。</p>
          </div>
        ) : (
          <>
            <Link
              to={`/reader/${uid}`}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 px-5 pt-5 text-sm lg:hidden"
            >
              <ChevronLeft className="size-4" />
              回列表
            </Link>
            {item === null ? (
              <Missing key={selected} dynId={selected} ups={props.ups} listLoading={feed.isPending} />
            ) : (
              <ReaderDetail key={selected} item={item} ups={props.ups} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 只有头像；选中的那个才把名字展开。 */
function UpChip(props: { to: string; active: boolean; name: string; face: string | null }) {
  return (
    <Link
      to={props.to}
      aria-current={props.active ? 'page' : undefined}
      title={props.name}
      className={cn(
        'flex shrink-0 items-center gap-2 rounded-full border p-1 text-[13px] transition-colors',
        props.active
          ? 'border-brand-ink bg-brand/[0.07] pr-3 font-medium'
          : 'hover:bg-muted/60 border-transparent',
      )}
    >
      {props.face === null ? (
        <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full text-[11px]">
          {props.name.slice(0, 2)}
        </span>
      ) : (
        <img
          src={props.face}
          alt={props.active ? '' : props.name}
          referrerPolicy="no-referrer"
          className={cn(
            'bg-muted size-8 rounded-full object-cover',
            !props.active && 'opacity-75 hover:opacity-100',
          )}
        />
      )}
      {props.active && <span className="max-w-[10rem] truncate">{props.name}</span>}
    </Link>
  )
}

/** 无限查询里这一栏用得到的那几个字段。 */
interface FeedQuery {
  isPending: boolean
  isError: boolean
  error: Error | null
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => unknown
}

/** 列表 + 触底自动续页：哨兵提前一屏进入视口就取下一页。 */
function Lane(props: {
  feed: FeedQuery
  items: ReaderItem[]
  ups: UpsMap
  selected: string | null
  uid: string
  /** 选一条不该把筛选丢掉，所以链接带上当前的 query。 */
  search: string
}) {
  const { feed } = props
  const { ref, inView } = useInView({ rootMargin: '400px' })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage])

  if (feed.isPending) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    )
  }
  if (feed.isError) {
    return (
      <p className="text-destructive flex items-start gap-2 p-4 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        {feed.error?.message ?? '读不出这个 UP 的空间流'}
      </p>
    )
  }
  if (props.items.length === 0) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        这一类下面没有内容。
      </p>
    )
  }

  return (
    <>
      <ul>
        {props.items.map((it) => (
          <ReaderRow
            key={it.dynId}
            item={it}
            ups={props.ups}
            to={{ pathname: `/reader/${props.uid}/${it.dynId}`, search: props.search }}
            selected={it.dynId === props.selected}
          />
        ))}
      </ul>
      <div ref={ref} className="text-muted-foreground px-4 py-5 text-center text-xs">
        {isFetchingNextPage ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2 className="size-3.5 motion-safe:animate-spin" />
            正在读下一页
          </span>
        ) : hasNextPage ? (
          // 观察器被拦截器之类掐掉时还有这条路可走。
          <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
            继续加载
          </Button>
        ) : (
          '到底了'
        )}
      </div>
    </>
  )
}

/** 深链接进来、左栏还没翻到那一页：按 dynId 单独取一条（库里有的都取得到）。 */
function Missing(props: { dynId: string; ups: UpsMap; listLoading: boolean }) {
  const q = useQuery({
    queryKey: [...keys.updates, 'item', props.dynId],
    queryFn: () => api.readerItem(props.dynId),
    enabled: !props.listLoading,
  })

  if (q.isPending) {
    return (
      <div className="mx-auto max-w-[720px] space-y-3 px-5 pt-7 md:px-7">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    )
  }
  if (q.isError) {
    return <Hint>这条不在当前列表里，库里也没有。往下翻一页再点。</Hint>
  }
  return <ReaderDetail item={q.data.item} ups={props.ups} />
}

const Hint = (props: { children: ReactNode }) => (
  <div className="text-muted-foreground px-6 py-24 text-center text-sm">
    <TriangleAlert className="mx-auto size-9" />
    <p className="mt-3.5">{props.children}</p>
  </div>
)
