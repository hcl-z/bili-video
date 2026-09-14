import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import type { AppConfig } from '#shared/contract/config.ts'
import { DYNAMIC_KINDS, DYNAMIC_KIND_LABEL } from '#shared/contract/config.ts'
import type { DynamicKind } from '#shared/contract/config.ts'
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
  const config = useQuery({ queryKey: keys.config, queryFn: api.config })
  const [kind, setKind] = useState<RuleKind>('keyword-deny')
  const [pattern, setPattern] = useState('')

  const add = useMutation({
    mutationFn: () => api.addRule({ scope: 'global', kind, pattern: pattern.trim() }),
    onSuccess: () => {
      setPattern('')
      void qc.invalidateQueries({ queryKey: keys.rules })
      toast.success('已添加')
    },

    onError: (err: Error) => toast.error('加不上', { description: err.message }),
  })

  const all = rules.data?.rules ?? []

  return (
    <Page
      title="过滤规则"
      hint="黑名单优先于白名单；白名单非空时，只有命中白名单的条目才通过。"
    >
      {config.data !== undefined && <KindFilters config={config.data} />}

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (pattern.trim() !== '') add.mutate()
        }}
      >
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
            title="全局规则"
            hint="UP 主选择继承时使用这套规则"
            rules={all.filter((r) => r.scope === 'global')}
            timeouts={rules.data.timeouts}
          />
        </div>
      )}

      <div className="mt-6">
        <RuleTester subs={[]} />
      </div>
    </Page>
  )
}

function KindFilters({ config }: { config: AppConfig }) {
  const qc = useQueryClient()
  const patch = useMutation({
    mutationFn: (kind: DynamicKind) =>
      api.patchConfig('filter', {
        kinds: { ...config.filter.kinds, [kind]: !config.filter.kinds[kind] },
      }),
    onSuccess: (data) => qc.setQueryData(keys.config, data),
    onError: (err: Error) => toast.error('保存失败', { description: err.message }),
  })

  return (
    <Card className="mb-4">
      <CardContent className="py-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium">推送类别</h2>
          <p className="text-muted-foreground mt-1 text-xs">关闭后仍保留在动态流，并标明未推送原因。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {DYNAMIC_KINDS.map((kind) => (
            <label key={kind} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <span className="text-sm">{DYNAMIC_KIND_LABEL[kind]}</span>
              <Switch
                size="sm"
                checked={config.filter.kinds[kind]}
                disabled={patch.isPending}
                onCheckedChange={() => patch.mutate(kind)}
                aria-label={`${DYNAMIC_KIND_LABEL[kind]}推送`}
              />
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
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
