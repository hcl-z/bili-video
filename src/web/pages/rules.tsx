import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import type { RulesResponse } from '#shared/contract/api.ts'
import { RULE_KINDS, RULE_KIND_LABEL } from '#shared/contract/subscription.ts'
import type { FilterRule, RuleKind } from '#shared/contract/subscription.ts'
import { Page } from '@/components/page'
import { RuleTester } from '@/components/rule-tester'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'

export function RulesPage() {
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: keys.rules, queryFn: api.rules })
  const subs = useQuery({ queryKey: keys.subs, queryFn: api.subs })
  const [scope, setScope] = useState('global')
  const [kind, setKind] = useState<RuleKind>('keyword-deny')
  const [pattern, setPattern] = useState('')

  const add = useMutation({
    mutationFn: () => api.addRule({ scope, kind, pattern: pattern.trim() }),
    onSuccess: () => {
      setPattern('')
      void qc.invalidateQueries({ queryKey: keys.rules })
      toast.success('已添加')
    },

    onError: (err: Error) => toast.error('加不上', { description: err.message }),
  })

  const all = rules.data?.rules ?? []
  const uids = [...new Set(all.filter((r) => r.scope !== 'global').map((r) => r.scope))]
  const nameOf = (uid: string) => subs.data?.subs.find((s) => s.uid === uid)?.name ?? `uid ${uid}`

  return (
    <Page
      title="过滤规则"
      hint="黑名单优先于白名单；白名单非空时，只有命中白名单的条目才通过。"
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (pattern.trim() !== '') add.mutate()
        }}
      >
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="w-36" aria-label="作用范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="global">全局</SelectItem>
            {(subs.data?.subs ?? []).map((s) => (
              <SelectItem key={s.uid} value={s.uid}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={kind} onValueChange={(v) => setKind(v as RuleKind)}>
          <SelectTrigger className="w-40" aria-label="规则类型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RULE_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {RULE_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="min-w-40 flex-1"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={kind.startsWith('regex') ? '正则，如 (恰饭|广告)' : '关键词'}
          aria-label="关键词或正则"
        />
        <Button type="submit" disabled={add.isPending || pattern.trim() === ''}>
          {add.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          添加
        </Button>
      </form>

      {rules.isPending ? (
        <Skeleton className="mt-4 h-24 w-full" />
      ) : rules.isError ? (
        <p className="text-destructive mt-4 text-sm">{rules.error.message}</p>
      ) : (
        <div className="mt-4 space-y-3">
          <Group
            title="全局"
            hint="对没有自己规则的 UP 生效"
            rules={all.filter((r) => r.scope === 'global')}
            timeouts={rules.data.timeouts}
          />
          {uids.map((uid) => (
            <Group
              key={uid}
              title={nameOf(uid)}
              hint="这个 UP 用自己这一套，全局规则对 TA 不生效"
              rules={all.filter((r) => r.scope === uid)}
              timeouts={rules.data.timeouts}
            />
          ))}
        </div>
      )}

      <div className="mt-6">
        <RuleTester subs={subs.data?.subs ?? []} />
      </div>
    </Page>
  )
}

function Group(props: {
  title: string
  hint: string
  rules: FilterRule[]
  timeouts: RulesResponse['timeouts']
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-medium">{props.title}</h2>
          <span className="text-muted-foreground text-xs">{props.hint}</span>
        </div>
        {props.rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">还没有规则，所有条目都会通过。</p>
        ) : (
          <ul className="divide-y">
            {props.rules.map((rule) => (
              <RuleRow key={rule.id} rule={rule} timeouts={props.timeouts[String(rule.id)] ?? 0} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function RuleRow(props: { rule: FilterRule; timeouts: number }) {
  const { rule } = props
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: keys.rules })

  const patch = useMutation({
    mutationFn: (enabled: boolean) => api.patchRule(rule.id, enabled),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error('改开关失败', { description: err.message }),
  })
  const remove = useMutation({
    mutationFn: () => api.removeRule(rule.id),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error('删除失败', { description: err.message }),
  })

  const deny = rule.kind.endsWith('deny')
  return (
    <li className="flex items-center gap-3 py-2">
      <Switch
        size="sm"
        checked={rule.enabled}
        disabled={patch.isPending}
        onCheckedChange={(v) => patch.mutate(v)}
        aria-label={`启用规则 ${rule.pattern}`}
      />
      <Badge variant={deny ? 'destructive' : 'secondary'}>{RULE_KIND_LABEL[rule.kind]}</Badge>
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{rule.pattern}</code>
      {props.timeouts > 0 && <Badge variant="outline">超时 {props.timeouts} 次</Badge>}
      <Button
        variant="ghost"
        size="icon"
        aria-label={`删除规则 ${rule.pattern}`}
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  )
}
