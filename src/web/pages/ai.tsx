import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, PlugZap, Save, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import type { AiSettingsResponse, AiTestResponse } from '#shared/contract/api.ts'
import type { ProbeStage } from '#shared/contract/probe.ts'
import type { AsrConfig } from '#shared/contract/config.ts'
import { Page } from '@/components/page'
import { SecretField } from '@/components/secret-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
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

const STAGE_LABEL: Record<ProbeStage, string> = {
  'not-configured': '没配置',
  network: '网络不通',
  auth: '鉴权失败',
  model: '模型不存在',
  unknown: '未知错误',
}

export function AiPage() {
  const settings = useQuery({ queryKey: keys.ai, queryFn: api.aiSettings })

  return (
    <Page title="AI 与 ASR" hint="模型、分段参数、连通性测试；apiKey 只写不读，存进去就再也读不出来。">
      {settings.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : settings.isError ? (
        <p className="text-destructive text-sm">{settings.error.message}</p>
      ) : (
        <AiForm settings={settings.data} />
      )}
    </Page>
  )
}

/** 字段全放本地草稿，一次性提交。逐字段自动保存会把半截的 baseURL 也写进库 */
function AiForm(props: { settings: AiSettingsResponse }) {
  const qc = useQueryClient()
  const init = props.settings
  const [enabled, setEnabled] = useState(init.ai.enabled)
  const [llm, setLlm] = useState({
    baseURL: init.ai.baseURL,
    model: init.ai.model,
    temperature: String(init.ai.temperature),
    apiKey: '',
  })
  const [chunk, setChunk] = useState({
    thresholdTokens: String(init.ai.chunk.thresholdTokens),
    sizeTokens: String(init.ai.chunk.sizeTokens),
    overlapTokens: String(init.ai.chunk.overlapTokens),
  })
  const [asr, setAsr] = useState({
    provider: init.asr.provider,
    baseURL: init.asr.baseURL,
    model: init.asr.model,
    language: init.asr.language,
    useOfficialSubtitles: init.asr.useOfficialSubtitles,
    segmentSec: String(init.asr.segmentSec),
    apiKey: '',
  })

  const save = useMutation({
    mutationFn: () =>
      api.patchAiSettings({
        ai: {
          enabled,
          baseURL: llm.baseURL.trim(),
          model: llm.model.trim(),
          temperature: numOr(llm.temperature, init.ai.temperature),
          chunk: {
            thresholdTokens: numOr(chunk.thresholdTokens, init.ai.chunk.thresholdTokens),
            sizeTokens: numOr(chunk.sizeTokens, init.ai.chunk.sizeTokens),
            overlapTokens: numOr(chunk.overlapTokens, init.ai.chunk.overlapTokens),
          },
        },
        asr: {
          provider: asr.provider,
          baseURL: asr.baseURL.trim(),
          model: asr.model.trim(),
          language: asr.language.trim(),
          useOfficialSubtitles: asr.useOfficialSubtitles,
          segmentSec: numOr(asr.segmentSec, init.asr.segmentSec),
        },

        ...(llm.apiKey.trim() === '' ? {} : { llmApiKey: llm.apiKey.trim() }),
        ...(asr.apiKey.trim() === '' ? {} : { asrApiKey: asr.apiKey.trim() }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(keys.ai, data)
      void qc.invalidateQueries({ queryKey: keys.config })

      setLlm((s) => ({ ...s, apiKey: '' }))
      setAsr((s) => ({ ...s, apiKey: '' }))
      toast.success('已保存', { description: '不用重启，下一次调用就按新配置走' })
    },
    onError: (err: Error) => toast.error('保存失败', { description: err.message }),
  })


  const clearKey = useMutation({
    mutationFn: (which: 'llm' | 'asr') =>
      api.patchAiSettings(which === 'llm' ? { llmApiKey: null } : { asrApiKey: null }),
    onSuccess: (data) => {
      qc.setQueryData(keys.ai, data)
      toast.success('已清空 apiKey')
    },
    onError: (err: Error) => toast.error('清不掉', { description: err.message }),
  })

  const test = useMutation({
    mutationFn: api.testAi,
    onError: (err: Error) => toast.error('测不了', { description: err.message }),
  })
  const probe = test.data

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div>
            <Label htmlFor="ai-enabled" className="text-base">
              AI 总开关
            </Label>
            <p className="text-muted-foreground mt-1 text-sm">
              关掉后轮询照旧、推送照旧，只是一次都不调 LLM。
            </p>
          </div>
          <Switch id="ai-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 py-4">
          <SectionTitle title="LLM" hint="OpenAI 兼容接口，填到 /v1 为止。" />
          <Field id="llm-base" label="baseURL">
            <Input
              id="llm-base"
              value={llm.baseURL}
              onChange={(e) => setLlm((s) => ({ ...s, baseURL: e.target.value }))}
              placeholder="https://api.example.com/v1"
            />
          </Field>
          <Field id="llm-model" label="model">
            <Input
              id="llm-model"
              value={llm.model}
              onChange={(e) => setLlm((s) => ({ ...s, model: e.target.value }))}
              placeholder="claude-sonnet-5"
            />
          </Field>
          <SecretField
            id="llm-key"
            label="apiKey"
            state={init.llmKey}
            value={llm.apiKey}
            onChange={(v) => setLlm((s) => ({ ...s, apiKey: v }))}
            onClear={() => clearKey.mutate('llm')}
            clearing={clearKey.isPending}
          />
          <Field id="llm-temp" label="temperature">
            <Input
              id="llm-temp"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={llm.temperature}
              onChange={(e) => setLlm((s) => ({ ...s, temperature: e.target.value }))}
            />
          </Field>

          <Separator />

          <SectionTitle title="分段" hint="全文超过阈值才切块总结，否则整篇一次过。" />
          <div className="grid grid-cols-3 gap-3">
            <Field id="chunk-threshold" label="阈值 token">
              <Input
                id="chunk-threshold"
                type="number"
                value={chunk.thresholdTokens}
                onChange={(e) => setChunk((s) => ({ ...s, thresholdTokens: e.target.value }))}
              />
            </Field>
            <Field id="chunk-size" label="每段 token">
              <Input
                id="chunk-size"
                type="number"
                value={chunk.sizeTokens}
                onChange={(e) => setChunk((s) => ({ ...s, sizeTokens: e.target.value }))}
              />
            </Field>
            <Field id="chunk-overlap" label="重叠 token">
              <Input
                id="chunk-overlap"
                type="number"
                value={chunk.overlapTokens}
                onChange={(e) => setChunk((s) => ({ ...s, overlapTokens: e.target.value }))}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 py-4">
          <SectionTitle
            title="ASR"
            hint={
              init.isDocker
                ? 'Docker 内只提供两个远程转写服务。'
                : '本机 mlx-audio 使用 Qwen3-ASR；也可以切到两个远程转写服务。'
            }
          />
          <Field id="asr-provider" label="provider">
            <Select
              value={asr.provider}
              onValueChange={(v) => setAsr((s) => ({ ...s, provider: v as AsrConfig['provider'] }))}
            >
              <SelectTrigger id="asr-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {init.availableAsrProviders.includes('mlx-audio') && (
                  <SelectItem value="mlx-audio">mlx-audio（本机 Qwen3-ASR）</SelectItem>
                )}
                <SelectItem value="openai-compat">openai-compat（远端，/audio/transcriptions）</SelectItem>
                <SelectItem value="chat-audio">chat-audio（远端，chat 里塞音频）</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {asr.provider !== 'mlx-audio' && (
            <>
              <Field id="asr-base" label="baseURL">
                <Input
                  id="asr-base"
                  value={asr.baseURL}
                  onChange={(e) => setAsr((s) => ({ ...s, baseURL: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              <SecretField
                id="asr-key"
                label="apiKey"
                state={init.asrKey}
                value={asr.apiKey}
                onChange={(v) => setAsr((s) => ({ ...s, apiKey: v }))}
                onClear={() => clearKey.mutate('asr')}
                clearing={clearKey.isPending}
              />
            </>
          )}
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-3">
            <div>
              <Label htmlFor="asr-subtitles">优先使用官方字幕</Label>
              <p className="text-muted-foreground mt-1 text-sm">关闭后跳过字幕，直接下载音频并转写。</p>
            </div>
            <Switch
              id="asr-subtitles"
              checked={asr.useOfficialSubtitles}
              onCheckedChange={(checked) =>
                setAsr((s) => ({ ...s, useOfficialSubtitles: checked }))
              }
            />
          </div>
          <Field id="asr-model" label="model">
            <Input
              id="asr-model"
              value={asr.model}
              onChange={(e) => setAsr((s) => ({ ...s, model: e.target.value }))}
            />
          </Field>
          <Field id="asr-lang" label="语言">
            <Input
              id="asr-lang"
              value={asr.language}
              onChange={(e) => setAsr((s) => ({ ...s, language: e.target.value }))}
              placeholder="Chinese"
            />
          </Field>
          {asr.provider === 'chat-audio' && (
            <Field id="asr-seg" label="切段时长（秒）">
              <Input
                id="asr-seg"
                value={asr.segmentSec}
                onChange={(e) => setAsr((s) => ({ ...s, segmentSec: e.target.value }))}
                placeholder="120"
              />
            </Field>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          保存
        </Button>
        <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <PlugZap className="size-4" />
          )}
          连通性测试
        </Button>
      </div>

      {probe !== undefined && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <ProbeRow label="LLM" result={probe.llm} />
            <ProbeRow label="ASR" result={probe.asr} />
            {}
            <p className="text-muted-foreground text-xs">测的是已保存的配置，改完记得先保存。</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function numOr(input: string, fallback: number): number {
  const n = Number(input)
  return Number.isFinite(n) ? n : fallback
}

function SectionTitle(props: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="font-medium">{props.title}</h2>
      <p className="text-muted-foreground text-sm">{props.hint}</p>
    </div>
  )
}

function Field(props: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
    </div>
  )
}

function ProbeRow(props: { label: string; result: AiTestResponse['llm'] }) {
  const r = props.result
  return (
    <div className="flex items-start gap-2 text-sm">
      {r.ok ? (
        <CheckCircle2 className="text-primary mt-0.5 size-4 shrink-0" />
      ) : (
        <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
      )}
      <span className="w-10 shrink-0 font-medium">{props.label}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span>{r.ok ? '通' : STAGE_LABEL[r.stage ?? 'unknown']}</span>
          <span className="text-muted-foreground font-mono text-xs">{r.ms}ms</span>
        </div>
        {r.detail !== null && (
          <p className="text-muted-foreground mt-0.5 break-words text-xs">{r.detail}</p>
        )}
      </div>
    </div>
  )
}
