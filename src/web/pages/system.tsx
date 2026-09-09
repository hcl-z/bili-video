import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Loader2, QrCode, RefreshCw, Save, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

import type { ConfigResponse, SystemResponse } from '#shared/contract/api.ts'
import { AUTH_STATE_LABEL } from '#shared/contract/api.ts'
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
import { formatBytes, formatCount, formatSpan, formatTime } from '@/lib/format'
import { keys } from '@/lib/query'
import { cn } from '@/lib/utils'

export function SystemPage() {
  const system = useQuery({ queryKey: keys.system, queryFn: api.system })
  const config = useQuery({ queryKey: keys.config, queryFn: api.config })

  return (
    <Page title="系统" hint="登录、轮询节奏、数据占用与备份导出。">
      {system.isPending || config.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : system.isError ? (
        <p className="text-destructive text-sm">{system.error.message}</p>
      ) : config.isError ? (
        <p className="text-destructive text-sm">{config.error.message}</p>
      ) : (
        <div className="space-y-4">
          <AuthCard system={system.data} />
          <PollCard config={config.data} />
          <DataCard />
          <TruthCard config={config.data} />
        </div>
      )}
    </Page>
  )
}

/** 扫码与续期。二维码由服务端渲染成 SVG，前端只负责显示。 */
function AuthCard(props: { system: SystemResponse }) {
  const qc = useQueryClient()
  const auth = props.system.auth
  const waiting = auth.qrUrl !== null

  const qr = useQuery({
    queryKey: [...keys.qr, auth.qrUrl],
    queryFn: api.qr,
    enabled: waiting,
    staleTime: Infinity,
  })

  const login = useMutation({
    mutationFn: api.startLogin,
    onSuccess: (res) => {
      qc.setQueryData(keys.system, { ...props.system, auth: res.auth })
      void qc.invalidateQueries({ queryKey: keys.system })
      toast.info(res.started ? '二维码正在生成' : '已经有一张码在等人扫')
    },
    onError: (err: Error) => toast.error('开不了扫码', { description: err.message }),
  })

  const refresh = useMutation({
    mutationFn: api.refreshCookie,
    onSuccess: (res) => {
      qc.setQueryData(keys.system, { ...props.system, auth: res.auth })
      void qc.invalidateQueries({ queryKey: keys.system })
      if (res.ok) {
        toast.success('续期成功', {
          description:
            res.auth.remainingMs === null
              ? undefined
              : `新的剩余有效期 ${formatSpan(res.auth.remainingMs)}`,
        })
      } else {
        toast.error('续不动', { description: res.error ?? '原因不明' })
      }
    },
    onError: (err: Error) => toast.error('续不动', { description: err.message }),
  })

  return (
    <Card>
      <CardContent className="py-4">
        <h2 className="text-sm font-medium">登录</h2>
        <div className="mt-1 divide-y">
          <Row label="状态">
            <Badge variant={auth.state === 'logged-in' ? 'outline' : 'destructive'}>
              {AUTH_STATE_LABEL[auth.state]}
            </Badge>
          </Row>
          <Row label="账号">
            {auth.uname === null ? (
              <span className="text-muted-foreground">还不知道是谁</span>
            ) : (
              <span>
                {auth.uname} <Mono className="text-muted-foreground">{auth.uid}</Mono>
              </span>
            )}
          </Row>
          <Row label="cookie 到期">
            {auth.expiresAt === null ? (
              <span className="text-muted-foreground">无从判断</span>
            ) : (
              <span>
                <Mono>{formatTime(auth.expiresAt)}</Mono>
                {auth.remainingMs !== null && (
                  <span className="text-muted-foreground ml-2 text-xs">
                    还剩 {formatSpan(auth.remainingMs)}
                  </span>
                )}
              </span>
            )}
          </Row>
          {auth.refreshFailures > 0 && (
            <Row label="续期失败">
              <Mono className="text-destructive">{auth.refreshFailures} 次</Mono>
            </Row>
          )}
          {auth.lastError !== null && <Row label="最近原因">{auth.lastError}</Row>}
        </div>

        {waiting && (
          <div className="mt-4 flex flex-col items-center gap-2">
            {qr.data === undefined ? (
              <Skeleton className="size-48" />
            ) : (
              // 白底写死在 SVG 里，暗色主题下也扫得出来。
              <div
                className="size-48 rounded-md bg-white p-2"
                dangerouslySetInnerHTML={{ __html: qr.data.svg }}
              />
            )}
            <p className="text-muted-foreground text-xs">
              {auth.state === 'scanned' ? '已扫上，去手机上点确认' : '用 B 站 App 扫这张码'}
            </p>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Button onClick={() => login.mutate()} disabled={login.isPending}>
            {login.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <QrCode className="size-4" />
            )}
            {waiting ? '换一张码' : '扫码登录'}
          </Button>
          <Button variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            立即续期
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** 轮询节奏。cron 由后端预编译校验，非法表达式在这里当场被拒。 */
function PollCard(props: { config: ConfigResponse }) {
  const qc = useQueryClient()
  const poll = props.config.config.poll
  const [cron, setCron] = useState(poll.cron)

  const save = useMutation({
    mutationFn: (patch: { cron?: string; enabled?: boolean }) => api.patchConfig('poll', patch),
    onSuccess: (data) => {
      qc.setQueryData(keys.config, data)
      setCron(data.config.poll.cron)
      toast.success('已生效', { description: '不用重启，下一次排程就按新的来' })
    },
    onError: (err: Error) => toast.error('没改成', { description: err.message }),
  })

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">轮询</h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              六位含秒的 cron。秒位错开整分，避开全网客户端堆在 :00 的流量尖峰。
            </p>
          </div>
          <Switch
            checked={poll.enabled}
            onCheckedChange={(enabled) => save.mutate({ enabled })}
            aria-label="开关轮询"
          />
        </div>
        <div className="flex gap-2">
          <Input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="font-mono"
            aria-label="cron 表达式"
          />
          <Button
            variant="outline"
            onClick={() => save.mutate({ cron: cron.trim() })}
            disabled={save.isPending || cron.trim() === poll.cron}
          >
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** 磁盘与条数，以及备份导出。备份走浏览器下载，不经过 JS 缓一份到内存。 */
function DataCard() {
  const storage = useQuery({ queryKey: keys.storage, queryFn: api.storage })

  return (
    <Card>
      <CardContent className="py-4">
        <h2 className="text-sm font-medium">数据</h2>
        {storage.isPending ? (
          <Skeleton className="mt-2 h-32 w-full" />
        ) : storage.isError ? (
          <p className="text-destructive mt-2 text-sm">{storage.error.message}</p>
        ) : (
          <div className="mt-1 divide-y">
            <Row label="数据库">
              <Mono>{formatBytes(storage.data.dbBytes)}</Mono>
            </Row>
            <Row label="更新条数">
              <Mono>{formatCount(storage.data.updates)}</Mono>
            </Row>
            <Row label="总结条数">
              <Mono>{formatCount(storage.data.summaries)}</Mono>
            </Row>
            <Row label="音频临时目录">
              <span>
                <Mono>{formatBytes(storage.data.audioBytes)}</Mono>
                <Mono className="text-muted-foreground ml-2">{storage.data.audioDir}</Mono>
              </span>
            </Row>
            <Row label="Markdown 目录">
              <span>
                <Mono>{formatBytes(storage.data.markdownBytes)}</Mono>
                <Mono className="text-muted-foreground ml-2">{storage.data.markdownDir}</Mono>
              </span>
            </Row>
          </div>
        )}

        <Separator className="my-3" />
        <Button variant="outline" asChild>
          <a href="/api/system/backup" download>
            <Download className="size-4" />
            导出备份
          </a>
        </Button>
        <p className="text-muted-foreground mt-2 text-xs">
          一个 JSON：配置、订阅、规则、更新、总结（含转写全文）。
        </p>
      </CardContent>
    </Card>
  )
}

/** 两件容易在三个月后咬人的事：YAML 已经不生效了，master key 丢了就全没了。 */
function TruthCard(props: { config: ConfigResponse }) {
  return (
    <Card>
      <CardContent className="text-muted-foreground space-y-2.5 py-4 text-sm">
        <p>
          配置已由本页面管理，<code className="font-mono">config.yaml</code> 不再生效。
          {props.config.seededFrom === null
            ? '（当前配置来自数据库）'
            : `（首次启动时从 ${props.config.seededFrom} 导入过一次）`}
        </p>
        <p className="flex gap-2">
          <ShieldAlert className="text-destructive mt-0.5 size-4 shrink-0" />
          <span>
            备份里不含 <code className="font-mono">master.key</code>，也不含任何用它加密的内容
            （cookie、apiKey、refresh_token）。这个文件丢了，库里所有加密值一次性不可恢复 ——
            只能重新扫码登录、重填 apiKey。请单独备份它。
          </span>
        </p>
      </CardContent>
    </Card>
  )
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
      <span className="text-muted-foreground shrink-0">{props.label}</span>
      <span className="min-w-0 text-right">{props.children}</span>
    </div>
  )
}

function Mono(props: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-xs tabular-nums', props.className)}>{props.children}</span>
  )
}
