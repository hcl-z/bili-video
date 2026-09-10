import { z } from 'zod'

import type { AsrConfig, ChunkConfig } from '#shared/contract/config.ts'
import { fail, ok, type Failure, type Result } from '#shared/contract/failure.ts'
import type { PipelineStep, StepStatus, SummaryJob } from '#shared/contract/job.ts'
import type { Cue, Summary } from '#shared/contract/summary.ts'
import { CueSchema } from '#shared/contract/summary.ts'
import type { Update } from '#shared/contract/update.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import { chunkCues, type TranscriptChunk } from '../domain/chunker.ts'
import { degrade, levelFor, sourceFor, startDegrade, type DegradeStep } from '../domain/degrade.ts'
import { needsTranscript, stepIndex, type ArtifactKind } from '../domain/pipeline.ts'
import {
  chunkPrompt,
  leadLine,
  linkTimestamps,
  metaPrompt,
  parseArticle,
  reducePrompt,
  renderMarkdown,
  summaryFileName,
  summaryPrompt,
  transcriptText,
  videoRef,
  type ChunkNote,
  type VideoMeta,
} from '../domain/summary-format.ts'
import type { Asr } from '../ports/asr.ts'
import type { AudioDownloader } from '../ports/audio.ts'
import type { SubtitleFetcher } from '../ports/bili.ts'
import type { Clock } from '../ports/clock.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Llm, LlmCompletion } from '../ports/llm.ts'
import type { Logger } from '../ports/logger.ts'
import type { MarkdownWriter } from '../ports/markdown.ts'
import type {
  JobArtifactRepo,
  LlmCallRepo,
  SubscriptionRepo,
  SummaryRepo,
  UpdateRepo,
} from '../ports/repo.ts'
import { Lane } from './lane.ts'
import { errFields } from '../log-fields.ts'

/** 转写结果。走到哪一级由 step 说，为什么走到这一级由 reasons 说。 */
export interface Transcript {
  cues: Cue[]
  step: DegradeStep
  reasons: string[]
}

/** 落盘的转写产物。cues 存原始形状：分段要的是时间戳，纯文本回不来。 */
const TranscriptArtifactSchema = z.object({
  cues: CueSchema.array(),
  step: z.enum(['subtitle', 'asr', 'meta', 'link']),
  reasons: z.array(z.string()),
})

const NotesArtifactSchema = z
  .object({
    index: z.number().int(),
    startSec: z.number().int(),
    endSec: z.number().int(),
    text: z.string(),
  })
  .array()

/** 每一步汇报自己的状态。队列那边把它写进 job_steps 并推 SSE。 */
export type StepHook = (step: PipelineStep, status: StepStatus, note?: string | null) => void

export interface SummarizeDeps {
  subtitles: SubtitleFetcher | null
  audio: AudioDownloader | null
  asr: Asr | null
  /** ★ 只从这里取 LLM：总开关关着时它返回 null（见 AiService.llm）。 */
  llm: () => Llm | null
  chunkConfig: () => ChunkConfig
  asrConfig: () => AsrConfig
  updates: UpdateRepo
  subs: SubscriptionRepo
  summaries: SummaryRepo
  /** 每一步的产物。有它「从第 N 步重跑」才不用重做前面 N-1 步。 */
  artifacts: JobArtifactRepo
  llmCalls: LlmCallRepo
  markdown: MarkdownWriter
  clock: Clock
  logger: Logger
  events: EventBus
}

/** 视频总结分为转写和总结两段；仅本机转写受 ASR 并发通道限制。 */
export class SummarizeVideo {
  private readonly deps: SummarizeDeps
  private readonly logger: Logger
  private readonly asrLane: Lane

  constructor(deps: SummarizeDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'summarize' })
    this.asrLane = new Lane(() => deps.asrConfig().concurrency)
  }

  /** 获取带时间戳的文本并按降级链处理；从转写后步骤重跑时复用可用转写产物。 */
  async transcribe(bvid: string, from: PipelineStep, hook: StepHook): Promise<Transcript> {
    if (!needsTranscript(from)) {
      const cached = this.cachedTranscript(bvid)
      if (cached !== null) {
        const at: PipelineStep = cached.step === 'asr' ? 'asr' : 'subtitle'
        hook(at, 'reused', `复用上次的转写文本（${cached.cues.length} 行）`)
        return cached
      }
    }

    let state = startDegrade()
    const skipByStart = stepIndex(from) > stepIndex('subtitle')
    const skipByConfig = !this.deps.asrConfig().useOfficialSubtitles
    const skipSubtitle = skipByStart || skipByConfig

    if (skipSubtitle) {
      const reason = skipByConfig ? '官方字幕已关闭，直接走语音转写' : '按所选起点跳过，直接走语音转写'
      hook('subtitle', 'skipped', reason)
      state = degrade(state, reason)
    } else {
      hook('subtitle', 'running')
      const subtitle = await this.fetchSubtitle(bvid)
      if (subtitle.ok) {
        hook('subtitle', 'done', `${subtitle.value.length} 行字幕`)
        hook('download', 'skipped', '有字幕，不用下音频')
        hook('asr', 'skipped', '有字幕，不用转写')
        return this.remember(bvid, { cues: subtitle.value, step: state.step, reasons: state.reasons })
      }
      hook('subtitle', 'failed', subtitle.failure.message)
      state = degrade(state, subtitle.failure.message)
    }

    const cues = await this.asrLane.run(() => this.runAsr(bvid, hook))
    if (cues.ok) {
      return this.remember(bvid, { cues: cues.value, step: state.step, reasons: state.reasons })
    }
    state = degrade(state, cues.failure.message)

    this.logger.warn({ bvid, degradeTo: state.step, reasons: state.reasons }, '转写降级')
    return this.remember(bvid, { cues: [], step: state.step, reasons: state.reasons })
  }

  /** 第二段：调 LLM、落库落盘。from 在 reduce 之后就直接复用上次的正文。 */
  async summarize(
    job: SummaryJob,
    t: Transcript,
    from: PipelineStep,
    hook: StepHook,
  ): Promise<Result<Summary>> {
    const meta = this.meta(job)
    let article = stepIndex(from) > stepIndex('reduce') ? this.cachedArticle(job.bvid) : null

    if (article !== null) {
      hook('reduce', 'reused', '复用上次生成的正文，只重跑落库')
    } else {
      const llm = this.deps.llm()
      if (llm === null) {
        return await this.linkOnly(job, t, fatalFailure('AI 总结已关闭（ai.enabled=false）'), hook)
      }
      const made =
        t.step === 'meta'
          ? await this.summarizeMeta(llm, job, meta, hook)
          : await this.summarizeTranscript(llm, job, meta, t.cues, from, hook)
      if (!made.ok) return await this.linkOnly(job, t, made.failure, hook)
      article = made.value
      this.deps.artifacts.put(job.bvid, 'draft', {
        payload: article,
        at: this.deps.clock.now(),
      })
    }

    hook('persist', 'running')
    const done = await this.persist(job, meta, {
      article,
      transcript: transcriptText(t.cues),
      step: t.step,
      reasons: t.reasons,
    })
    hook('persist', done.ok ? 'done' : 'failed', done.ok ? null : done.failure.message)
    return done
  }

  /** 有转写文本：按 token 数决定整篇一次还是分段后汇总。 */
  private async summarizeTranscript(
    llm: Llm,
    job: SummaryJob,
    meta: VideoMeta,
    cues: readonly Cue[],
    from: PipelineStep,
    hook: StepHook,
  ): Promise<Result<string>> {
    const chunks = chunkCues(cues, this.deps.chunkConfig())
    if (chunks.length <= 1) {
      hook('chunk', 'skipped', '全文不长，一次总结完')
      hook('reduce', 'running')
      const prompt = summaryPrompt(meta, transcriptText(cues))
      const reply = await this.call(llm, job.bvid, 'reduce', prompt)
      if (!reply.ok) return this.reduceFailed(hook, reply.failure)
      const article = parseArticle(reply.value)
      if (!article.ok) return this.reduceFailed(hook, article.failure)
      hook('reduce', 'done', `${article.value.length} 字`)
      return article
    }

    let notes = stepIndex(from) > stepIndex('chunk') ? this.cachedNotes(job.bvid) : null
    if (notes !== null) {
      hook('chunk', 'reused', `复用上次的 ${notes.length} 段内容`)
    } else {
      const made: ChunkNote[] = []
      for (const c of chunks) {
        // 每段更新状态，避免长时间 LLM 调用显示停滞。
        hook('chunk', 'running', `第 ${c.index + 1}/${chunks.length} 段`)
        // 顺序处理分段，保持 LLM 通道并发限制。
        const prompt = chunkPrompt(meta, {
          index: c.index,
          total: chunks.length,
          startSec: c.startSec,
          endSec: c.endSec,
          transcript: transcriptText(c.cues),
        })
        const reply = await this.call(llm, job.bvid, 'chunk', prompt)
        if (!reply.ok) {
          hook('chunk', 'failed', `第 ${c.index + 1}/${chunks.length} 段：${reply.failure.message}`)
          return fail(reply.failure)
        }
        made.push(note(c, reply.value))
      }
      hook('chunk', 'done', `${chunks.length} 段`)
      notes = made
      this.deps.artifacts.put(job.bvid, 'notes', {
        payload: JSON.stringify(made),
        at: this.deps.clock.now(),
      })
    }

    hook('reduce', 'running')
    const reply = await this.call(llm, job.bvid, 'reduce', reducePrompt(meta, notes))
    if (!reply.ok) return this.reduceFailed(hook, reply.failure)
    const article = parseArticle(reply.value)
    if (!article.ok) return this.reduceFailed(hook, article.failure)
    this.logger.info({ bvid: job.bvid, chunks: notes.length }, '分段总结已合并')
    hook('reduce', 'done', `${article.value.length} 字`)
    return article
  }

  private reduceFailed(hook: StepHook, failure: Failure): Result<string> {
    hook('reduce', 'failed', failure.message)
    return fail(failure)
  }

  /** 只有简介：写不出阅读版本，只能给一段「大概在讲什么」。 */
  private async summarizeMeta(
    llm: Llm,
    job: SummaryJob,
    meta: VideoMeta,
    hook: StepHook,
  ): Promise<Result<string>> {
    hook('chunk', 'skipped', '没有语音内容，没什么可分段的')
    hook('reduce', 'running')
    const brief = this.deps.updates.get(job.updateId)?.text ?? ''
    // 分 P 标题是这一级唯一还能拿到的「内容」，取不到就算了，别让兜底也失败。
    const parts = await this.deps.subtitles?.parts(job.bvid)
    const reply = await this.call(
      llm,
      job.bvid,
      'reduce',
      metaPrompt(meta, brief, parts?.ok === true ? parts.value : []),
    )
    if (!reply.ok) return this.reduceFailed(hook, reply.failure)
    const article = parseArticle(reply.value)
    if (!article.ok) return this.reduceFailed(hook, article.failure)
    hook('reduce', 'done', '只有标题与简介，低置信度')
    return article
  }

  /** 最终降级时保存标题、封面、链接和失败原因，但任务仍标记失败以支持重跑。 */
  private async linkOnly(
    job: SummaryJob,
    t: Transcript,
    failure: Failure,
    hook: StepHook,
  ): Promise<Result<Summary>> {
    // 已有总结就不动它 —— 一次 LLM 抖动不该把好总结覆盖成一行链接。
    if (this.deps.summaries.get(job.bvid) === null) {
      const reasons = [...t.reasons, `生成总结：${failure.message}`]
      // 不算 persist 跑过了：这条任务卡在生成那一步，落的只是一条能推出去的最小记录。
      hook('persist', 'skipped', '只落了一条最小记录：标题、封面、链接')
      await this.persist(job, this.meta(job), {
        article: reasons.map((r) => `- ${r}`).join('\n'),
        transcript: transcriptText(t.cues),
        step: 'link',
        reasons,
      })
    }
    return fail(failure)
  }

  private async persist(job: SummaryJob, meta: VideoMeta, parts: SummaryParts): Promise<Result<Summary>> {
    // 时间戳在落库前就链好：阅读栏和落盘的 Markdown 因此都能点。
    const article = linkTimestamps(parts.article, job.bvid)
    const summary: Summary = {
      bvid: job.bvid,
      tldr: leadLine(article),
      article,
      transcriptSource: sourceFor(parts.step),
      ...levelFor(parts.step),
      createdAt: this.deps.clock.now(),
      fullMd: '',
    }
    summary.fullMd = renderMarkdown(meta, { ...summary, reasons: parts.reasons })

    // 先写入数据库再落盘，数据库为数据源，文件为副本。
    this.deps.summaries.upsert(summary, parts.transcript)
    const path = await this.deps.markdown.write(summaryFileName(job.bvid), summary.fullMd)

    this.deps.events.emit({ type: 'summary.done', bvid: job.bvid })
    this.logger.info(
      {
        bvid: job.bvid,
        degradePath: summary.degradePath,
        confidence: summary.confidence,
        chars: summary.article.length,
        path,
      },
      '总结已生成',
    )
    return ok(summary)
  }

  private async call(
    llm: Llm,
    bvid: string,
    stage: 'chunk' | 'reduce',
    prompt: { system: string; user: string },
  ): Promise<Result<string>> {
    const res = await llm.complete([
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ])
    if (!res.ok) return fail(res.failure)
    this.record(bvid, stage, res.value.usage)
    return ok(res.value.text)
  }

  /** 只记账不拦截：没有任何上限会阻止总结生成。 */
  private record(bvid: string, stage: 'chunk' | 'reduce', usage: LlmCompletion['usage']): void {
    this.deps.llmCalls.record({
      bvid,
      stage,
      model: usage.model,
      inTokens: usage.inTokens,
      outTokens: usage.outTokens,
      ms: usage.ms,
      at: this.deps.clock.now(),
    })
  }

  private async fetchSubtitle(bvid: string): Promise<Result<Cue[]>> {
    const fetcher = this.deps.subtitles
    if (fetcher === null) return fail(fatalFailure('字幕适配器没接入这个进程'))
    const res = await fetcher.fetch(bvid)
    if (!res.ok) return fail(res.failure)
    if (res.value === null || res.value.length === 0) {
      return fail(fatalFailure('这个视频没有字幕（AI 字幕也没有）'))
    }
    return ok(res.value)
  }

  /** 下音频 + 转写。两步任一步炸了都只是「这一级不成」，所以错误收成 Result。 */
  private async runAsr(bvid: string, hook: StepHook): Promise<Result<Cue[]>> {
    const { audio, asr } = this.deps
    if (audio === null || asr === null) {
      const why = '音频转写没接入这个进程'
      hook('download', 'skipped', why)
      hook('asr', 'skipped', why)
      return fail(fatalFailure(why))
    }

    hook('download', 'running')
    let path: string
    try {
      path = (await audio.download(bvid)).path
      hook('download', 'done')
    } catch (err) {
      hook('download', 'failed', message(err))
      hook('asr', 'skipped', '没有音频可转写')
      return fail(fatalFailure(`下载音频失败：${message(err)}`))
    }

    hook('asr', 'running')
    try {
      const cues = await asr.transcribe(path, { language: this.deps.asrConfig().language })
      if (cues.length === 0) {
        hook('asr', 'failed', '转写结果是空的')
        return fail(fatalFailure('转写结果是空的'))
      }
      // 成功即删。失败留着，重跑时下载那一步会直接用它；超过 24h 的由启动清理兜掉。
      await audio.cleanup(path)
      hook('asr', 'done', `${cues.length} 行`)
      return ok(cues)
    } catch (err) {
      hook('asr', 'failed', message(err))
      return fail(fatalFailure(`语音转写失败：${message(err)}`))
    }
  }

  /** 转写产物落盘，下一次从 chunk / reduce 起跑就不用再取一遍。 */
  private remember(bvid: string, t: Transcript): Transcript {
    this.deps.artifacts.put(bvid, 'transcript', {
      payload: JSON.stringify(t),
      at: this.deps.clock.now(),
    })
    return t
  }

  private cachedTranscript(bvid: string): Transcript | null {
    return this.cached(bvid, 'transcript', TranscriptArtifactSchema)
  }

  private cachedNotes(bvid: string): ChunkNote[] | null {
    return this.cached(bvid, 'notes', NotesArtifactSchema)
  }

  /** 正文是纯文本，没有形状要校验，空的就当没有。 */
  private cachedArticle(bvid: string): string | null {
    const row = this.deps.artifacts.get(bvid, 'draft')
    return row === null || row.payload.trim() === '' ? null : row.payload
  }

  /** 产物形状无效时视为不存在，避免复用不完整数据。 */
  private cached<T>(bvid: string, kind: ArtifactKind, schema: { safeParse: SafeParse<T> }): T | null {
    const row = this.deps.artifacts.get(bvid, kind)
    if (row === null) return null
    try {
      const parsed = schema.safeParse(JSON.parse(row.payload))
      if (parsed.success) return parsed.data
      this.logger.warn({ bvid, artifact: kind }, '产物校验失败')
    } catch (err) {
      this.logger.warn({ bvid, artifact: kind, ...errFields(err) }, '产物解析失败')
    }
    return null
  }

  /** 标题这些东西来自动态那条记录；记录不见了就退回 bvid，不让整条任务失败。 */
  private meta(job: SummaryJob): VideoMeta {
    const update: Update | null = this.deps.updates.get(job.updateId) ?? null
    const uid = update?.uid ?? null
    return {
      bvid: job.bvid,
      ...videoRef(job.bvid, update),
      cover: update?.cover ?? null,
      upName: uid === null ? null : (this.deps.subs.get(uid)?.name ?? null),
    }
  }
}

interface SummaryParts {
  article: string
  transcript: string
  step: DegradeStep
  reasons: readonly string[]
}

/** 只要能 safeParse 就够，写成结构类型是为了不让这里依赖 zod 的具体类型。 */
type SafeParse<T> = (raw: unknown) => { success: true; data: T } | { success: false }

const note = (c: TranscriptChunk, text: string): ChunkNote => ({
  index: c.index,
  startSec: c.startSec,
  endSec: c.endSec,
  text,
})

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
