import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import type { PatchSubscriptionRequest } from '#shared/contract/api.ts'
import type { Subscription } from '#shared/contract/subscription.ts'
import { Page } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'

/**
 * 订阅页。一个输入框 + 一列 UP 主，没有别的。
 *
 * 「订阅 = 登录小号的关注列表」这件事在这一页是可见的：关注状态是一个独立的标记，
 * 关注失败时订阅仍然在，只是旁边多一个「重试关注」——因为写接口撞风控是常态，
 * 而那时候把订阅一起回滚掉只会让人以为自己加错了。
 */
export function SubsPage() {
  const qc = useQueryClient()
  const subs = useQuery({ queryKey: keys.subs, queryFn: api.subs })
  const [input, setInput] = useState('')

  const invalidate = () => void qc.invalidateQueries({ queryKey: keys.subs })

  const add = useMutation({
    mutationFn: (raw: string) => api.addSub(raw),
    onSuccess: (r) => {
      setInput('')
      search.reset()
      invalidate()
      if (r.notice === null) toast.success(`已订阅并关注 ${r.sub.name}`)
      else toast.warning(`已订阅 ${r.sub.name}`, { description: r.notice })
    },
    onError: (err: Error) => toast.error('添加失败', { description: err.message }),
  })

  const search = useMutation({
    mutationFn: (name: string) => api.searchUps(name),
    onError: (err: Error) => toast.error('查找失败', { description: err.message }),
  })

  const subscribed = new Set(subs.data?.subs.map((sub) => sub.uid) ?? [])

  return (
    <Page title="UP 主" hint="输入名称、UID 或空间页链接，确认账号后再订阅。">
      <div className="relative">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const query = input.trim()
            if (query !== '') search.mutate(query)
          }}
        >
          <Input
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              search.reset()
            }}
            placeholder="名称、UID 或空间页链接"
            aria-label="UP 主名称、UID 或空间页链接"
            autoComplete="off"
            disabled={search.isPending || add.isPending}
          />
          <Button type="submit" disabled={search.isPending || add.isPending || input.trim() === ''}>
            {search.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Search className="size-4" />
            )}
            查找
          </Button>
        </form>

        {search.data !== undefined && (
          <div className="bg-popover absolute z-20 mt-1 max-h-80 w-[calc(100%-5.5rem)] overflow-y-auto rounded-md border p-1 shadow-md">
            {search.data.items.length === 0 ? (
              <p className="text-muted-foreground px-3 py-4 text-center text-sm">没有找到匹配的 UP 主</p>
            ) : (
              search.data.items.map((item) => {
                const isSubscribed = subscribed.has(item.uid)
                return (
                  <button
                    key={item.uid}
                    type="button"
                    className="hover:bg-accent focus-visible:bg-accent flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left outline-none disabled:opacity-50"
                    disabled={isSubscribed || add.isPending}
                    onClick={() => add.mutate(item.uid)}
                  >
                    {item.face === null ? (
                      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm">
                        {item.name.slice(0, 1)}
                      </div>
                    ) : (
                      <img
                        src={item.face}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="size-9 shrink-0 rounded-full object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium">{item.name}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">
                          UID {item.uid}
                        </span>
                      </div>
                      <p className="text-muted-foreground truncate text-xs">
                        {item.fans === 0 ? '' : `${item.fans.toLocaleString('zh-CN')} 粉丝`}
                        {item.signature === '' ? '' : `${item.fans === 0 ? '' : ' · '}${item.signature}`}
                      </p>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {isSubscribed ? '已订阅' : '订阅'}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {subs.isPending ? (
          <Skeleton className="h-28 w-full" />
        ) : subs.isError ? (
          <p className="text-destructive text-sm">{subs.error.message}</p>
        ) : subs.data.subs.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              还没有订阅。先加 3–5 个真正想看的 UP 主 —— 关注列表就是聚合流的来源。
            </CardContent>
          </Card>
        ) : (
          subs.data.subs.map((sub) => <SubCard key={sub.uid} sub={sub} onChanged={invalidate} />)
        )}
      </div>
    </Page>
  )
}

function SubCard(props: { sub: Subscription; onChanged: () => void }) {
  const { sub } = props
  const [confirming, setConfirming] = useState(false)

  const patch = useMutation({
    mutationFn: (p: PatchSubscriptionRequest) => api.patchSub(sub.uid, p),
    onSuccess: props.onChanged,
    onError: (err: Error) => toast.error('改开关失败', { description: err.message }),
  })

  const remove = useMutation({
    mutationFn: () => api.removeSub(sub.uid),
    onSuccess: () => {
      props.onChanged()
      toast.success(`已删除 ${sub.name}`, { description: 'B 站上的关注保持不变' })
    },
    onError: (err: Error) => toast.error('删除失败', { description: err.message }),
  })

  const follow = useMutation({
    mutationFn: () => api.followSub(sub.uid),
    onSuccess: (r) => {
      props.onChanged()
      if (r.notice === null) toast.success(`已关注 ${r.sub.name}`)
      else toast.warning('还是没关上', { description: r.notice })
    },
    onError: (err: Error) => toast.error('关注失败', { description: err.message }),
  })

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center gap-3">
          {/* B 站图床按 Referer 挡外链，no-referrer 才拿得到头像。 */}
          {sub.face === null ? (
            <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full text-sm">
              {sub.name.slice(0, 1)}
            </div>
          ) : (
            <img
              src={sub.face}
              alt={`${sub.name} 的头像`}
              referrerPolicy="no-referrer"
              className="size-10 shrink-0 rounded-full object-cover"
            />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <a
                href={`https://space.bilibili.com/${sub.uid}`}
                target="_blank"
                rel="noreferrer"
                className="truncate font-medium hover:underline"
              >
                {sub.name}
              </a>
              {sub.followedAt === null ? (
                <Badge variant="secondary">未关注</Badge>
              ) : (
                <Badge>已关注</Badge>
              )}
            </div>
            <p className="text-muted-foreground font-mono text-xs">uid {sub.uid}</p>
          </div>

          {sub.followedAt === null && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => follow.mutate()}
              disabled={follow.isPending}
            >
              {follow.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              重试关注
            </Button>
          )}

          {/* 两步删除。这一页没有别的破坏性操作，为它单独装个对话框不值得。 */}
          {confirming ? (
            <div className="flex gap-1.5">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                确认删除
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                取消
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`删除 ${sub.name}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>

        <Separator className="my-3.5" />

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Toggle
            id={`dyn-${sub.uid}`}
            label="动态"
            checked={sub.enableDynamic}
            pending={patch.isPending}
            onChange={(enableDynamic) => patch.mutate({ enableDynamic })}
          />
          <Toggle
            id={`vid-${sub.uid}`}
            label="视频"
            checked={sub.enableVideo}
            pending={patch.isPending}
            onChange={(enableVideo) => patch.mutate({ enableVideo })}
          />
          <Toggle
            id={`ai-${sub.uid}`}
            label="AI 总结"
            checked={sub.enableAi}
            pending={patch.isPending}
            onChange={(enableAi) => patch.mutate({ enableAi })}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function Toggle(props: {
  id: string
  label: string
  checked: boolean
  pending: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={props.id}
        checked={props.checked}
        disabled={props.pending}
        onCheckedChange={props.onChange}
      />
      <Label htmlFor={props.id} className="text-sm font-normal">
        {props.label}
      </Label>
    </div>
  )
}
