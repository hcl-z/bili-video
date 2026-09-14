import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, RotateCcw, Save, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Page } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { keys } from '@/lib/query'

const VARIABLE_LABEL: Record<string, string> = {
  text: '视频内容',
  title: '视频标题',
  up_name: 'UP 主',
  bvid: 'BV 号',
}

export function PromptsPage() {
  const settings = useQuery({ queryKey: keys.prompts, queryFn: api.promptSettings })

  return (
    <Page title="Prompt 管理" hint="控制视频最终阅读版的写作方式；分段提取与无正文兜底仍由系统处理。">
      {settings.isPending ? (
        <Skeleton className="h-[32rem] w-full" />
      ) : settings.isError ? (
        <p className="text-destructive text-sm">{settings.error.message}</p>
      ) : (
        <PromptWorkspace settings={settings.data} />
      )}
    </Page>
  )
}

function PromptWorkspace({ settings }: { settings: Awaited<ReturnType<typeof api.promptSettings>> }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState(settings.effectiveTemplate)
  const [custom, setCustom] = useState(settings.source === 'custom')

  useEffect(() => {
    setDraft(settings.effectiveTemplate)
    setCustom(settings.source === 'custom')
  }, [settings])

  const validation = useMemo(() => validateTemplate(draft, settings.variables), [draft, settings.variables])
  const dirty = custom !== (settings.source === 'custom') || (custom && draft !== settings.customTemplate)

  const save = useMutation({
    mutationFn: () => api.patchPromptSettings({ template: custom ? draft : null }),
    onSuccess: (data) => {
      qc.setQueryData(keys.prompts, data)
      toast.success('Prompt 已保存')
    },
    onError: (error: Error) => toast.error('保存失败', { description: error.message }),
  })

  const chooseCustom = () => {
    if (!custom) setDraft(settings.effectiveTemplate)
    setCustom(true)
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,.75fr)]">
      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="size-4 text-muted-foreground" />
                <CardTitle>总结模板</CardTitle>
                <Badge variant={custom ? 'default' : 'secondary'}>{custom ? '全局自定义' : '内置默认'}</Badge>
              </div>
              <CardDescription>修改后只影响新生成或重新生成的总结。</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={custom ? 'outline' : 'default'}
                onClick={() => {
                  setCustom(false)
                  setDraft(settings.defaultTemplate)
                }}
              >
                使用默认
              </Button>
              <Button size="sm" variant={custom ? 'default' : 'outline'} onClick={chooseCustom}>
                自定义
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <label htmlFor="global-prompt" className="mb-2 block text-sm font-medium">
            {custom ? '编辑自定义 Prompt' : '默认 Prompt（只读）'}
          </label>
          <Textarea
            id="global-prompt"
            value={draft}
            readOnly={!custom}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[30rem] resize-y font-mono text-[13px] leading-6"
            aria-invalid={custom && validation.error !== null}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              {validation.error === null ? (
                <><Check className="size-3.5" />模板有效 · {draft.length} 字符</>
              ) : (
                <span className="text-destructive">{validation.error}</span>
              )}
            </div>
            <div className="flex gap-2">
              {custom && draft !== settings.defaultTemplate && (
                <Button variant="ghost" size="sm" onClick={() => setDraft(settings.defaultTemplate)}>
                  <RotateCcw />恢复默认内容
                </Button>
              )}
              <Button
                size="sm"
                disabled={!dirty || save.isPending || (custom && validation.error !== null)}
                onClick={() => save.mutate()}
              >
                <Save />保存
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>可用变量</CardTitle>
            <CardDescription>点击变量复制后粘贴到模板中。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {settings.variables.map((variable) => (
              <Button
                key={variable}
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(`{{${variable}}}`)
                  toast.success('变量已复制')
                }}
              >
                <code>{`{{${variable}}}`}</code>
                <span className="text-muted-foreground">{VARIABLE_LABEL[variable]}</span>
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>渲染预览</CardTitle>
            <CardDescription>用示例信息查看变量替换后的结构。</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/50 max-h-[28rem] overflow-auto rounded-md border p-4 whitespace-pre-wrap font-mono text-xs leading-5">
              {renderPreview(draft)}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function validateTemplate(template: string, variables: readonly string[]): { error: string | null } {
  const found = [...template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((match) => match[1] ?? '')
  const unknown = [...new Set(found.filter((variable) => !variables.includes(variable)))]
  if (unknown.length > 0) return { error: `未知变量：${unknown.join('、')}` }
  if (found.filter((variable) => variable === 'text').length !== 1) {
    return { error: '{{text}} 必须且只能出现一次' }
  }
  if (template.trim() === '') return { error: 'Prompt 不能为空' }
  return { error: null }
}

function renderPreview(template: string): string {
  const sample: Record<string, string> = {
    title: '为什么好系统需要清晰的边界',
    up_name: '示例 UP 主',
    bvid: 'BV1example',
    text: '[00:00] 开场介绍问题\n[01:24] 第一部分的详细内容……',
  }
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (raw, name: string) => sample[name] ?? raw)
}
