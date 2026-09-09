import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, PlugZap, Save, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import type { NotifySettingsResponse } from '#shared/contract/api.ts'
import { Page } from '@/components/page'
import { SecretField } from '@/components/secret-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'

type NotifyChannel = keyof NotifySettingsResponse['targets']

export function TargetsPage() {
  const settings = useQuery({ queryKey: keys.notify, queryFn: api.notifySettings })
  return (
    <Page title="推送渠道" hint="凭据只写不读；保存后可分别发送测试消息。">
      {settings.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : settings.isError ? (
        <p className="text-destructive text-sm">{settings.error.message}</p>
      ) : (
        <TargetsForm settings={settings.data} />
      )}
    </Page>
  )
}

function TargetsForm({ settings }: { settings: NotifySettingsResponse }) {
  const qc = useQueryClient()
  const [active, setActive] = useState<NotifyChannel>('wxpusher')
  const [wxpusher, setWxpusher] = useState({
    ...settings.notify.wxpusher,
    uids: settings.notify.wxpusher.uids.join('\n'),
    token: '',
  })
  const [ntfy, setNtfy] = useState({ ...settings.notify.ntfy, auth: '' })
  const [feishu, setFeishu] = useState({ ...settings.notify.feishu, secret: '' })
  const [webhook, setWebhook] = useState({ ...settings.notify.webhook, authorization: '' })

  const save = useMutation({
    mutationFn: () => {
      if (active === 'wxpusher') {
        return api.patchNotifySettings({
          notify: {
            wxpusher: {
              enabled: wxpusher.enabled,
              uids: wxpusher.uids.split(/[\n,]/).map((v) => v.trim()).filter(Boolean),
            },
          },
          ...(wxpusher.token.trim() === '' ? {} : { wxpusherToken: wxpusher.token.trim() }),
        })
      }
      if (active === 'ntfy') {
        return api.patchNotifySettings({
          notify: {
            ntfy: {
              enabled: ntfy.enabled,
              server: ntfy.server.trim(),
              topic: ntfy.topic.trim(),
            },
          },
          ...(ntfy.auth.trim() === '' ? {} : { ntfyAuth: ntfy.auth.trim() }),
        })
      }
      if (active === 'feishu') {
        return api.patchNotifySettings({
          notify: {
            feishu: {
              enabled: feishu.enabled,
              appId: feishu.appId.trim(),
              receiveIdType: feishu.receiveIdType,
              receiveId: feishu.receiveId.trim(),
            },
          },
          ...(feishu.secret.trim() === '' ? {} : { feishuSecret: feishu.secret.trim() }),
        })
      }
      return api.patchNotifySettings({
        notify: { webhook: { enabled: webhook.enabled, url: webhook.url.trim() } },
        ...(webhook.authorization.trim() === ''
          ? {}
          : { webhookAuthorization: webhook.authorization.trim() }),
      })
    },
    onSuccess: (data) => {
      qc.setQueryData(keys.notify, data)
      void qc.invalidateQueries({ queryKey: keys.config })
      setWxpusher((current) => ({ ...current, token: '' }))
      setNtfy((current) => ({ ...current, auth: '' }))
      setFeishu((current) => ({ ...current, secret: '' }))
      setWebhook((current) => ({ ...current, authorization: '' }))
      toast.success('已保存', { description: `${label(active)} 配置已更新` })
    },
    onError: (error: Error) => toast.error('保存失败', { description: error.message }),
  })

  const clear = useMutation({
    mutationFn: (channel: NotifyChannel) => {
      if (channel === 'wxpusher') return api.patchNotifySettings({ wxpusherToken: null })
      if (channel === 'ntfy') return api.patchNotifySettings({ ntfyAuth: null })
      if (channel === 'feishu') return api.patchNotifySettings({ feishuSecret: null })
      return api.patchNotifySettings({ webhookAuthorization: null })
    },
    onSuccess: (data) => {
      qc.setQueryData(keys.notify, data)
      toast.success('凭据已清空')
    },
    onError: (error: Error) => toast.error('清不掉', { description: error.message }),
  })

  const test = useMutation({
    mutationFn: api.testNotify,
    onSuccess: ({ channel, result }) => {
      if (result.ok) toast.success(`${label(channel)} 已送达`)
      else toast.error(`${label(channel)} 测试失败`, { description: result.error ?? '原因不明' })
    },
    onError: (error: Error) => toast.error('测不了', { description: error.message }),
  })

  return (
    <div className="space-y-4">
      <Tabs value={active} onValueChange={(value) => setActive(value as NotifyChannel)}>
        <TabsList className="grid h-auto w-full grid-cols-4">
          {CHANNELS.map((channel) => (
            <TabsTrigger key={channel} value={channel}>
              <StateIcon ready={settings.targets[channel].ready} />
              {label(channel)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="wxpusher">
          <TargetCard
            title="WxPusher"
            hint="微信通知，正文按 Markdown 发送。"
            enabled={wxpusher.enabled}
            onEnabled={(enabled) => setWxpusher((current) => ({ ...current, enabled }))}
            testing={test.isPending && test.variables === 'wxpusher'}
            onTest={() => test.mutate('wxpusher')}
          >
            <Field id="wx-uids" label="接收 UID">
              <textarea
                id="wx-uids"
                name="notify-wxpusher-uids"
                autoComplete="off"
                className="border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 font-mono text-sm"
                value={wxpusher.uids}
                onChange={(event) => setWxpusher((current) => ({ ...current, uids: event.target.value }))}
                placeholder="UID_xxx，每行一个"
              />
            </Field>
            <SecretField
              id="wx-token"
              label="appToken"
              state={settings.wxpusherToken}
              value={wxpusher.token}
              onChange={(token) => setWxpusher((current) => ({ ...current, token }))}
              onClear={() => clear.mutate('wxpusher')}
              clearing={clear.isPending}
            />
          </TargetCard>
        </TabsContent>

        <TabsContent value="ntfy">
          <TargetCard
            title="ntfy"
            hint="topic 相当于密码，请使用难猜的值。"
            enabled={ntfy.enabled}
            onEnabled={(enabled) => setNtfy((current) => ({ ...current, enabled }))}
            testing={test.isPending && test.variables === 'ntfy'}
            onTest={() => test.mutate('ntfy')}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field id="ntfy-server" label="server">
                <Input id="ntfy-server" name="notify-ntfy-server" autoComplete="url" value={ntfy.server} onChange={(e) => setNtfy((s) => ({ ...s, server: e.target.value }))} />
              </Field>
              <Field id="ntfy-topic" label="topic">
                <Input id="ntfy-topic" name="notify-ntfy-topic" autoComplete="off" value={ntfy.topic} onChange={(e) => setNtfy((s) => ({ ...s, topic: e.target.value }))} />
              </Field>
            </div>
            <SecretField
              id="ntfy-auth"
              label="Authorization（可选）"
              state={settings.ntfyAuth}
              value={ntfy.auth}
              onChange={(auth) => setNtfy((current) => ({ ...current, auth }))}
              onClear={() => clear.mutate('ntfy')}
              clearing={clear.isPending}
            />
          </TargetCard>
        </TabsContent>

        <TabsContent value="feishu">
          <TargetCard
            title="飞书"
            hint="使用自建应用向用户或群聊发送消息。"
            enabled={feishu.enabled}
            onEnabled={(enabled) => setFeishu((current) => ({ ...current, enabled }))}
            testing={test.isPending && test.variables === 'feishu'}
            onTest={() => test.mutate('feishu')}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field id="feishu-app" label="App ID">
                <Input id="feishu-app" name="notify-feishu-app-id" autoComplete="off" value={feishu.appId} onChange={(e) => setFeishu((s) => ({ ...s, appId: e.target.value }))} />
              </Field>
              <SecretField
                id="feishu-secret"
                label="App Secret"
                state={settings.feishuSecret}
                value={feishu.secret}
                onChange={(secret) => setFeishu((current) => ({ ...current, secret }))}
                onClear={() => clear.mutate('feishu')}
                clearing={clear.isPending}
              />
              <Field id="feishu-id-type" label="接收 ID 类型">
                <Select value={feishu.receiveIdType} onValueChange={(receiveIdType) => setFeishu((s) => ({ ...s, receiveIdType: receiveIdType as typeof s.receiveIdType }))}>
                  <SelectTrigger id="feishu-id-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['open_id', 'union_id', 'user_id', 'email', 'chat_id'].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="feishu-id" label="接收 ID">
                <Input id="feishu-id" name="notify-feishu-receive-id" autoComplete="off" value={feishu.receiveId} onChange={(e) => setFeishu((s) => ({ ...s, receiveId: e.target.value }))} />
              </Field>
            </div>
          </TargetCard>
        </TabsContent>

        <TabsContent value="webhook">
          <TargetCard
            title="Webhook"
            hint="POST 固定 JSON，字段为 title、body、url、kind、group。"
            enabled={webhook.enabled}
            onEnabled={(enabled) => setWebhook((current) => ({ ...current, enabled }))}
            testing={test.isPending && test.variables === 'webhook'}
            onTest={() => test.mutate('webhook')}
          >
            <Field id="webhook-url" label="URL">
              <Input id="webhook-url" name="notify-webhook-url" autoComplete="url" value={webhook.url} onChange={(e) => setWebhook((s) => ({ ...s, url: e.target.value }))} placeholder="https://example.com/hooks/bili" />
            </Field>
            <SecretField
              id="webhook-auth"
              label="Authorization（可选）"
              state={settings.webhookAuthorization}
              value={webhook.authorization}
              onChange={(authorization) => setWebhook((current) => ({ ...current, authorization }))}
              onClear={() => clear.mutate('webhook')}
              clearing={clear.isPending}
            />
          </TargetCard>
        </TabsContent>
      </Tabs>

      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        保存当前渠道
      </Button>
    </div>
  )
}

function TargetCard(props: {
  title: string
  hint: string
  enabled: boolean
  onEnabled: (enabled: boolean) => void
  testing: boolean
  onTest: () => void
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="font-medium">{props.title}</h2><p className="text-muted-foreground text-sm">{props.hint}</p></div>
          <Switch checked={props.enabled} onCheckedChange={props.onEnabled} />
        </div>
        {props.children}
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={props.onTest} disabled={props.testing}>
            {props.testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            发送测试
          </Button>
          <span className="text-muted-foreground text-xs">测试读取已保存的配置。</span>
        </div>
      </CardContent>
    </Card>
  )
}

function Field(props: { id: string; label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label htmlFor={props.id}>{props.label}</Label>{props.children}</div>
}

function StateIcon({ ready }: { ready: boolean }) {
  return ready ? <CheckCircle2 className="text-primary size-3.5" /> : <XCircle className="size-3.5" />
}

const CHANNELS = ['wxpusher', 'ntfy', 'feishu', 'webhook'] as const

function label(channel: NotifyChannel): string {
  if (channel === 'wxpusher') return 'WxPusher'
  if (channel === 'ntfy') return 'ntfy'
  if (channel === 'feishu') return '飞书'
  return 'Webhook'
}
