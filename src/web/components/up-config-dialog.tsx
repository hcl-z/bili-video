import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  CheckCircle2,
  FileText,
  Filter,
  Loader2,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import type { PromptSettingsResponse } from '#shared/contract/api.ts'
import {
  DYNAMIC_KINDS,
  DYNAMIC_KIND_LABEL,
  type AppConfig,
  type DynamicKindConfig,
  type DynamicKind,
} from '#shared/contract/config.ts'
import { RULE_KINDS, RULE_KIND_LABEL } from '#shared/contract/subscription.ts'
import type { FilterRule, RuleKind, Subscription } from '#shared/contract/subscription.ts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'
import { cn } from '@/lib/utils'

export function UpConfigDialog({ sub, onChanged }: { sub: Subscription; onChanged: () => void }) {
  const config = useQuery({ queryKey: keys.config, queryFn: api.config })
  const prompts = useQuery({ queryKey: keys.prompts, queryFn: api.promptSettings })

  return (
    <DialogContent className="max-w-4xl gap-0">
      <DialogHeader className="border-b bg-muted/25 px-5 py-5 sm:px-7">
        <div className="flex items-center gap-3.5 pr-8">
          {sub.face === null ? (
            <div className="bg-foreground text-background flex size-11 shrink-0 items-center justify-center rounded-xl text-base font-semibold">
              {sub.name.slice(0, 1)}
            </div>
          ) : (
            <img
              src={sub.face}
              alt=""
              referrerPolicy="no-referrer"
              className="size-11 shrink-0 rounded-xl object-cover ring-1 ring-border"
            />
          )}
          <div className="min-w-0">
            <DialogTitle className="truncate text-base sm:text-lg">{sub.name}</DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-mono">UID {sub.uid}</span>
              <span aria-hidden>·</span>
              <span>订阅策略</span>
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <Tabs defaultValue="delivery" className="min-h-0 gap-0">
        <div className="border-b px-4 sm:px-7">
          <TabsList variant="line" className="h-12 w-full justify-start gap-1 overflow-x-auto">
            <TabsTrigger value="delivery" className="h-12 flex-none px-3 sm:px-4">
              <Settings2 />推送与总结
            </TabsTrigger>
            <TabsTrigger value="rules" className="h-12 flex-none px-3 sm:px-4">
              <Filter />过滤规则
            </TabsTrigger>
            <TabsTrigger value="prompt" className="h-12 flex-none px-3 sm:px-4">
              <FileText />Prompt
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="max-h-[65dvh] overflow-y-auto px-4 py-5 sm:px-7 sm:py-6">
          <TabsContent value="delivery">
            {config.data === undefined ? (
              <LoadingState text="正在读取全局配置…" />
            ) : (
              <DeliveryPanel sub={sub} config={config.data} onChanged={onChanged} />
            )}
          </TabsContent>
          <TabsContent value="rules">
            <RulesPanel sub={sub} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="prompt">
            {prompts.data === undefined ? (
              <LoadingState text="正在读取全局 Prompt…" />
            ) : (
              <PromptPanel sub={sub} global={prompts.data} onChanged={onChanged} />
            )}
          </TabsContent>
        </div>
      </Tabs>
    </DialogContent>
  )
}

function DeliveryPanel({ sub, config, onChanged }: { sub: Subscription; config: AppConfig; onChanged: () => void }) {
  const patch = useMutation({
    mutationFn: (value: Parameters<typeof api.patchSub>[1]) => api.patchSub(sub.uid, value),
    onSuccess: onChanged,
    onError: (error: Error) => toast.error('保存失败', { description: error.message }),
  })
  const effectiveKinds = sub.pushKindMode === 'custom' && sub.pushKinds !== null
    ? sub.pushKinds
    : config.filter.kinds

  const setMode = (inherit: boolean) => {
    patch.mutate(
      inherit
        ? { pushKindMode: 'inherit', pushKinds: null }
        : { pushKindMode: 'custom', pushKinds: config.filter.kinds },
    )
  }
  const setKind = (kind: DynamicKind, enabled: boolean) => {
    patch.mutate({
      pushKindMode: 'custom',
      pushKinds: { ...effectiveKinds, [kind]: enabled },
    })
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="推送类别"
        description="决定哪些动态可以进入推送和自动总结流程。"
        trailing={<SourceBadge custom={sub.pushKindMode === 'custom'} />}
      />
      <ModeChoice
        inherit={sub.pushKindMode === 'inherit'}
        disabled={patch.isPending}
        inheritTitle="跟随全局"
        inheritDescription="全局类别变化时自动同步"
        customTitle="独立设置"
        customDescription="只对这个 UP 主生效"
        onChange={setMode}
      />

      <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
        {DYNAMIC_KINDS.map((kind) => (
          <KindToggle
            key={kind}
            kind={kind}
            checked={effectiveKinds[kind]}
            disabled={sub.pushKindMode === 'inherit' || patch.isPending}
            onChange={(enabled) => setKind(kind, enabled)}
          />
        ))}
      </div>
      {sub.pushKindMode === 'inherit' && (
        <p className="text-muted-foreground -mt-3 text-xs">类别开关来自「过滤规则」页面；切换为独立设置后即可修改。</p>
      )}

      <div className="border-t pt-6">
        <SectionHeading
          title="AI 总结"
          description="视频通过过滤后，是否自动生成阅读版总结。"
          trailing={
            <Switch
              aria-label="AI 总结"
              checked={sub.enableAi}
              disabled={patch.isPending}
              onCheckedChange={(enableAi) => patch.mutate({ enableAi })}
            />
          }
        />
        {!config.ai.enabled && (
          <div className="mt-4 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
            全局 AI 当前已关闭，此处设置会保留，但暂不执行总结。
          </div>
        )}
      </div>
    </div>
  )
}

function KindToggle(props: { kind: DynamicKind; checked: boolean; disabled: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <label className={cn('bg-background flex min-h-14 items-center justify-between gap-3 px-4 py-3', props.disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted/35')}>
      <span className="flex min-w-0 items-center gap-3">
        <span className={cn('size-2 rounded-full', props.checked ? 'bg-emerald-500' : 'bg-muted-foreground/30')} />
        <span className="text-sm font-medium">{DYNAMIC_KIND_LABEL[props.kind]}</span>
      </span>
      <Switch
        size="sm"
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
    </label>
  )
}

function RulesPanel({ sub, onChanged }: { sub: Subscription; onChanged: () => void }) {
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: keys.rules, queryFn: api.rules })
  const [kind, setKind] = useState<RuleKind>('keyword-deny')
  const [pattern, setPattern] = useState('')

  const patchMode = useMutation({
    mutationFn: (filterMode: Subscription['filterMode']) => api.patchSub(sub.uid, { filterMode }),
    onSuccess: onChanged,
    onError: (error: Error) => toast.error('保存失败', { description: error.message }),
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.rules })
  const add = useMutation({
    mutationFn: () => api.addRule({ scope: sub.uid, kind, pattern: pattern.trim() }),
    onSuccess: () => { setPattern(''); refresh() },
    onError: (error: Error) => toast.error('添加失败', { description: error.message }),
  })
  const mine = rules.data?.rules.filter((rule) => rule.scope === sub.uid) ?? []
  const globalRules = rules.data?.rules.filter((rule) => rule.scope === 'global') ?? []
  const globalCount = globalRules.filter((rule) => rule.enabled).length

  return (
    <div className="space-y-6">
      <SectionHeading
        title="内容过滤"
        description="关键词与正则命中后，决定内容通过或拦截。"
        trailing={<SourceBadge custom={sub.filterMode === 'custom'} />}
      />
      <ModeChoice
        inherit={sub.filterMode === 'inherit'}
        disabled={patchMode.isPending}
        inheritTitle="跟随全局"
        inheritDescription={`${globalCount} 条全局规则正在生效`}
        customTitle="独立规则"
        customDescription="不与全局规则叠加"
        onChange={(inherit) => patchMode.mutate(inherit ? 'inherit' : 'custom')}
      />

      {sub.filterMode === 'inherit' ? (
        <div className="overflow-hidden rounded-xl border">
          <div className="flex items-center justify-between border-b bg-muted/25 px-4 py-3">
            <div>
              <p className="text-sm font-medium">当前全局规则</p>
              <p className="text-muted-foreground mt-0.5 text-xs">启用 {globalCount} 条，共 {globalRules.length} 条</p>
            </div>
            <Badge variant="secondary">实时同步</Badge>
          </div>
          {rules.isPending ? (
            <LoadingState text="正在读取全局规则…" />
          ) : globalRules.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <CheckCircle2 className="mx-auto size-6 text-muted-foreground/60" />
              <p className="mt-3 text-sm font-medium">全局规则为空</p>
              <p className="text-muted-foreground mt-1 text-xs">这个 UP 主的内容不会被关键词或正则拦截。</p>
            </div>
          ) : (
            <ul className="max-h-72 divide-y overflow-y-auto px-4">
              {globalRules.map((rule) => <RulePreviewRow key={rule.id} rule={rule} />)}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <form
            className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]"
            onSubmit={(event) => { event.preventDefault(); if (pattern.trim()) add.mutate() }}
          >
            <Select value={kind} onValueChange={(value) => setKind(value as RuleKind)}>
              <SelectTrigger aria-label="规则类型"><SelectValue /></SelectTrigger>
              <SelectContent>{RULE_KINDS.map((value) => <SelectItem key={value} value={value}>{RULE_KIND_LABEL[value]}</SelectItem>)}</SelectContent>
            </Select>
            <Input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder={kind.startsWith('regex') ? '输入正则' : '输入关键词'} />
            <Button type="submit" disabled={add.isPending || pattern.trim() === ''}><Plus />添加</Button>
          </form>
          {mine.length === 0 ? (
            <div className="rounded-xl border border-dashed px-5 py-8 text-center">
              <p className="text-sm font-medium">所有内容都会通过</p>
              <p className="text-muted-foreground mt-1 text-xs">还没有为这个 UP 主添加规则。</p>
            </div>
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl border px-4">
              {mine.map((rule) => <UpRuleRow key={rule.id} rule={rule} onChanged={refresh} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function RulePreviewRow({ rule }: { rule: FilterRule }) {
  return (
    <li className={cn('flex items-center gap-3 py-3', !rule.enabled && 'opacity-45')}>
      <span className={cn('size-2 shrink-0 rounded-full', rule.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
      <Badge variant={rule.kind.endsWith('deny') ? 'destructive' : 'secondary'}>{RULE_KIND_LABEL[rule.kind]}</Badge>
      <code className="min-w-0 flex-1 truncate text-xs" title={rule.pattern}>{rule.pattern}</code>
      {!rule.enabled && <span className="text-muted-foreground shrink-0 text-xs">已停用</span>}
    </li>
  )
}

function UpRuleRow({ rule, onChanged }: { rule: FilterRule; onChanged: () => void }) {
  const patch = useMutation({ mutationFn: (enabled: boolean) => api.patchRule(rule.id, enabled), onSuccess: onChanged })
  const remove = useMutation({ mutationFn: () => api.removeRule(rule.id), onSuccess: onChanged })
  return (
    <li className="flex items-center gap-3 py-3">
      <Switch size="sm" checked={rule.enabled} disabled={patch.isPending} onCheckedChange={(value) => patch.mutate(value)} />
      <Badge variant={rule.kind.endsWith('deny') ? 'destructive' : 'secondary'}>{RULE_KIND_LABEL[rule.kind]}</Badge>
      <code className="min-w-0 flex-1 truncate text-xs">{rule.pattern}</code>
      <Button variant="ghost" size="icon" aria-label={`删除 ${rule.pattern}`} onClick={() => remove.mutate()}><Trash2 /></Button>
    </li>
  )
}

function PromptPanel({ sub, global, onChanged }: { sub: Subscription; global: PromptSettingsResponse; onChanged: () => void }) {
  const inherited = sub.promptTemplate === null
  const [draft, setDraft] = useState(sub.promptTemplate ?? global.effectiveTemplate)
  useEffect(() => setDraft(sub.promptTemplate ?? global.effectiveTemplate), [sub.promptTemplate, global.effectiveTemplate])
  const error = useMemo(() => promptError(draft, global.variables), [draft, global.variables])
  const save = useMutation({
    mutationFn: (template: string | null) => api.patchSub(sub.uid, { promptTemplate: template }),
    onSuccess: () => { onChanged(); toast.success('UP Prompt 已保存') },
    onError: (reason: Error) => toast.error('保存失败', { description: reason.message }),
  })

  return (
    <div className="space-y-6">
      <SectionHeading
        title="总结 Prompt"
        description="控制这个 UP 主视频的最终文章写法。"
        trailing={<SourceBadge custom={!inherited} />}
      />
      <ModeChoice
        inherit={inherited}
        disabled={save.isPending}
        inheritTitle="跟随全局"
        inheritDescription={global.source === 'default' ? '当前使用内置默认 Prompt' : '当前使用全局自定义 Prompt'}
        customTitle="独立 Prompt"
        customDescription="全局修改不会覆盖它"
        onChange={(next) => {
          if (next) save.mutate(null)
          else { setDraft(global.effectiveTemplate); save.mutate(global.effectiveTemplate) }
        }}
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`prompt-${sub.uid}`}>{inherited ? '当前生效内容' : '编辑 Prompt'}</Label>
          <span className="text-muted-foreground text-xs">{draft.length} 字符</span>
        </div>
        <Textarea
          id={`prompt-${sub.uid}`}
          readOnly={inherited}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className={cn('min-h-80 resize-y font-mono text-xs leading-5', inherited && 'bg-muted/30')}
          aria-invalid={!inherited && error !== null}
        />
        <div className="flex min-h-9 items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {error === null ? <span className="flex items-center gap-1"><Check className="size-3.5" />模板有效</span> : <span className="text-destructive">{error}</span>}
          </p>
          {!inherited && (
            <Button size="sm" disabled={save.isPending || error !== null || draft === sub.promptTemplate} onClick={() => save.mutate(draft)}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}保存
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionHeading(props: { title: string; description: string; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold">{props.title}</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-5">{props.description}</p>
      </div>
      {props.trailing}
    </div>
  )
}

function SourceBadge({ custom }: { custom: boolean }) {
  return <Badge variant={custom ? 'default' : 'secondary'}>{custom ? '独立配置' : '继承全局'}</Badge>
}

function ModeChoice(props: {
  inherit: boolean
  inheritTitle: string
  inheritDescription: string
  customTitle: string
  customDescription: string
  disabled: boolean
  onChange: (inherit: boolean) => void
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <ModeOption
        active={props.inherit}
        title={props.inheritTitle}
        description={props.inheritDescription}
        icon={<Sparkles />}
        disabled={props.disabled}
        onClick={() => props.onChange(true)}
      />
      <ModeOption
        active={!props.inherit}
        title={props.customTitle}
        description={props.customDescription}
        icon={<Settings2 />}
        disabled={props.disabled}
        onClick={() => props.onChange(false)}
      />
    </div>
  )
}

function ModeOption(props: { active: boolean; title: string; description: string; icon: React.ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'relative flex min-h-20 items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-60',
        props.active ? 'border-foreground/25 bg-muted/50' : 'hover:border-foreground/20 hover:bg-muted/25',
      )}
    >
      <span className="text-muted-foreground mt-0.5 [&_svg]:size-4">{props.icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{props.title}</span>
        <span className="text-muted-foreground mt-1 block text-xs leading-4">{props.description}</span>
      </span>
      <span className={cn('ml-auto flex size-4 shrink-0 items-center justify-center rounded-full border', props.active && 'border-foreground bg-foreground text-background')}>
        {props.active && <Check className="size-3" />}
      </span>
    </button>
  )
}

function LoadingState({ text }: { text: string }) {
  return <p className="text-muted-foreground flex items-center gap-2 py-10 text-sm"><Loader2 className="size-4 animate-spin" />{text}</p>
}

function promptError(template: string, variables: readonly string[]): string | null {
  const found = [...template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((match) => match[1] ?? '')
  const unknown = [...new Set(found.filter((variable) => !variables.includes(variable)))]
  if (unknown.length > 0) return `未知变量：${unknown.join('、')}`
  if (found.filter((variable) => variable === 'text').length !== 1) return '{{text}} 必须且只能出现一次'
  return template.trim() === '' ? 'Prompt 不能为空' : null
}
