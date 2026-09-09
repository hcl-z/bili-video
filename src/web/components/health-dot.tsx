import { useQuery } from '@tanstack/react-query'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { formatSpan } from '@/lib/format'
import { keys } from '@/lib/query'
import { cn } from '@/lib/utils'

/** 顶栏那颗点：后端在不在。也是「数据层装配好了」的活证据。 */
export function HealthDot() {
  const { data, isError } = useQuery({
    queryKey: keys.health,
    queryFn: api.health,
    refetchInterval: 15_000,
    staleTime: 0,
  })

  const state = isError ? 'down' : data === undefined ? 'unknown' : 'up'
  const label =
    state === 'up'
      ? `已连接 · v${data!.version} · 已运行 ${formatSpan(data!.uptimeMs)}`
      : state === 'down'
        ? '连不上后端：确认 pnpm dev:server 起着'
        : '正在连接后端'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
          <span
            className={cn(
              'size-2 rounded-full',
              state === 'up' && 'bg-emerald-500',
              state === 'down' && 'bg-destructive',
              state === 'unknown' && 'bg-muted-foreground/40 animate-pulse',
            )}
            aria-hidden
          />
          {state === 'up' ? '运行中' : state === 'down' ? '离线' : '连接中'}
        </div>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
