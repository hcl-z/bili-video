import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

import { Page } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'

/**
 * 这一票里 Overview 只证明一件事：前端到后端那条链路是通的（代理 → /api → SQLite → 回来）。
 * 真正的总览面板在 ticket 15。
 */
export function OverviewPage() {
  const health = useQuery({ queryKey: keys.health, queryFn: api.health })
  const config = useQuery({ queryKey: keys.config, queryFn: api.config })

  return (
    <Page title="总览" hint="骨架已装好：轮询、过滤、总结、推送在后面几票里逐个接上。">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">服务</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          {health.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : health.isError ? (
            <p className="text-destructive">连不上后端：{health.error.message}</p>
          ) : (
            <>
              <Row label="版本" value={health.data.version} />
              <Row label="启动于" value={new Date(health.data.startedAt).toLocaleString('zh-CN')} />
              <Row label="监听" value="127.0.0.1（只听回环，因此没有登录系统）" />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          {config.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : config.isError ? (
            <p className="text-destructive">{config.error.message}</p>
          ) : (
            <>
              <Row
                label="轮询"
                value={
                  <span className="flex items-center gap-2">
                    <code className="font-mono text-xs">{config.data.config.poll.cron}</code>
                    <Badge variant={config.data.config.poll.enabled ? 'default' : 'secondary'}>
                      {config.data.config.poll.enabled ? '开' : '关'}
                    </Badge>
                  </span>
                }
              />
              <Row label="AI 总结" value={config.data.config.ai.enabled ? '开' : '关'} />
              <Separator className="my-3" />
              {/* spec 用户故事 72：三个月后改了 YAML 没生效，不该以为是 bug。 */}
              <p className="text-muted-foreground flex gap-2 text-xs">
                <AlertTriangle className="text-brand mt-0.5 size-3.5 shrink-0" />
                <span>
                  配置已由本页面管理，
                  <code className="font-mono">config.yaml</code> 不再生效。
                  {config.data.seededFrom === null
                    ? '（当前配置来自数据库）'
                    : `（首次启动时从 ${config.data.seededFrom} 导入过一次）`}
                </span>
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </Page>
  )
}

function Row(props: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="text-right">{props.value}</span>
    </div>
  )
}
