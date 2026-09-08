import type { AsrConfig, ChunkConfig } from '#shared/contract/config.ts'
import { fail, ok, type Failure, type Result } from '#shared/contract/failure.ts'
import type { JobStage, SummaryJob } from '#shared/contract/job.ts'
import type { Cue, Summary, SummaryDraft } from '#shared/contract/summary.ts'
import type { Update } from '#shared/contract/update.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import { chunkCues, type TranscriptChunk } from '../domain/chunker.ts'
import { degrade, levelFor, sourceFor, startDegrade, type DegradeStep } from '../domain/degrade.ts'
import {
  chunkPrompt,
  metaPrompt,
  parseMetaDraft,
  parseSummaryDraft,
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
import type { LlmCallRepo, SubscriptionRepo, SummaryRepo, UpdateRepo } from '../ports/repo.ts'
import { Lane } from './lane.ts'

/** 转写结果。走到哪一级由 step 说，为什么走到这一级由 reasons 说。 */
export interface Transcript {
  cues: Cue[]
  step: DegradeStep
  reasons: string[]
}

export type StageHook = (stage: JobStage) => void

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
  llmCalls: LlmCallRepo
  markdown: MarkdownWriter
  clock: Clock
  logger: Logger
  events: EventBus
}

/**
 * 一个视频的总结管线，拆成「转写」和「总结」两段，队列那边分别调度。
 *
 * 并发 1 的闸门只锁住本机转写这一步（就一份 whisper），取字幕不锁 ——
 * 否则一条要转写一小时的视频会把有字幕的视频一起堵在门外。
 */
export class SummarizeVideo {
  private readonly deps: SummarizeDeps
  private readonly logger: Logger
  private readonly asrLane: Lane

  constructor(deps: SummarizeDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'summarize' })
    this.asrLane = new Lane(() => deps.asrConfig().concurrency)
  }

  /**
   * 第一段：拿到带时间戳的文本，拿不到就顺着降级链往下退。
   *
   * 不返回 Result —— 内容取不到从来不是「这条任务失败」，而是「这条总结降一级」。
   * 真正的失败只发生在总结那一段。
   */
  async transcribe(bvid: string, stage: StageHook): Promise<Transcript> {
    let state = startDegrade()

    stage('subtitle')
    const subtitle = await this.fetchSubtitle(bvid)
    if (subtitle.ok) return { cues: subtitle.value, step: state.step, reasons: state.reasons }
    state = degrade(state, subtitle.failure.message)

    const cues = await this.asrLane.run(() => this.runAsr(bvid, stage))
    if (cues.ok) return { cues: cues.value, step: state.step, reasons: state.reasons }
    state = degrade(state, cues.failure.message)

    this.logger.warn({ bvid, reasons: state.reasons }, '没拿到语音内容，退到简介兜底')
    return { cues: [], step: state.step, reasons: state.reasons }
  }

  /** 第二段：调 LLM、解析、落库落盘。 */
  async summarize(job: SummaryJob, t: Transcript, stage: StageHook): Promise<Result<Summary>> {
    const llm = this.deps.llm()
    if (llm === null) return await this.linkOnly(job, t, fatalFailure('AI 总结已关闭（ai.enabled=false）'))

    const meta = this.meta(job)
    const draft =
      t.step === 'meta'
        ? await this.summarizeMeta(llm, job, meta, stage)
        : await this.summarizeTranscript(llm, job, meta, t.cues, stage)
    if (!draft.ok) return await this.linkOnly(job, t, draft.failure)

    return await this.persist(job, meta, {
      ...draft.value,
      transcript: transcriptText(t.cues),
      step: t.step,
      reasons: t.reasons,
    })
  }

  /** 有转写文本：按 token 数决定整篇一次还是分段后汇总。 */
  private async summarizeTranscript(
    llm: Llm,
    job: SummaryJob,
    meta: VideoMeta,
    cues: readonly Cue[],
    stage: StageHook,
  ): Promise<Result<SummaryDraft>> {
    const chunks = chunkCues(cues, this.deps.chunkConfig())
    if (chunks.length <= 1) {
      stage('reduce')
      const prompt = summaryPrompt(meta, transcriptText(cues))
      const reply = await this.call(llm, job.bvid, 'reduce', prompt)
      if (!reply.ok) return fail(reply.failure)
      return parseSummaryDraft(reply.value)
    }

    stage('chunk')
    const notes: ChunkNote[] = []
    for (const c of chunks) {
      // 顺序跑：并发发出去的话，LLM 那条通道的并发上限就形同虚设了。
      const prompt = chunkPrompt(meta, {
        index: c.index,
        total: chunks.length,
        startSec: c.startSec,
        endSec: c.endSec,
        transcript: transcriptText(c.cues),
      })
      const reply = await this.call(llm, job.bvid, 'chunk', prompt)
      if (!reply.ok) return fail(reply.failure)
      notes.push(note(c, reply.value))
    }

    stage('reduce')
    const reply = await this.call(llm, job.bvid, 'reduce', reducePrompt(meta, notes))
    if (!reply.ok) return fail(reply.failure)
    this.logger.info({ bvid: job.bvid, chunks: chunks.length }, '分段总结已汇总')
    return parseSummaryDraft(reply.value)
  }

  /** 只有简介：不给章节，编出来的时间戳比没有更糟。 */
  private async summarizeMeta(
    llm: Llm,
    job: SummaryJob,
    meta: VideoMeta,
    stage: StageHook,
  ): Promise<Result<SummaryDraft>> {
    stage('reduce')
    const brief = this.deps.updates.get(job.updateId)?.text ?? ''
    // 分 P 标题是这一级唯一还能拿到的「内容」，取不到就算了，别让兜底也失败。
    const parts = await this.deps.subtitles?.parts(job.bvid)
    const reply = await this.call(
      llm,
      job.bvid,
      'reduce',
      metaPrompt(meta, brief, parts?.ok === true ? parts.value : []),
    )
    if (!reply.ok) return fail(reply.failure)
    const draft = parseMetaDraft(reply.value)
    if (!draft.ok) return fail(draft.failure)
    return ok({ tldr: draft.value.tldr, points: draft.value.points, chapters: [] })
  }

  /**
   * 最后一级：库里留一条只有标题、封面、链接和失败原因的记录，任务本身还是失败。
   *
   * 两者都要：推送那边得有东西可推，队列页也得留着重跑的入口，不能把失败藏起来。
   */
  private async linkOnly(job: SummaryJob, t: Transcript, failure: Failure): Promise<Result<Summary>> {
    // 已有总结就不动它 —— 一次 LLM 抖动不该把好总结覆盖成一行链接。
    if (this.deps.summaries.get(job.bvid) === null) {
      const reasons = [...t.reasons, `生成总结：${failure.message}`]
      await this.persist(job, this.meta(job), {
        tldr: '这条没能生成总结，只剩标题与链接。',
        points: reasons,
        chapters: [],
        transcript: transcriptText(t.cues),
        step: 'link',
        reasons,
      })
    }
    return fail(failure)
  }

  private async persist(job: SummaryJob, meta: VideoMeta, parts: SummaryParts): Promise<Result<Summary>> {
    const summary: Summary = {
      bvid: job.bvid,
      tldr: parts.tldr,
      points: parts.points,
      chapters: parts.chapters,
      transcriptSource: sourceFor(parts.step),
      ...levelFor(parts.step),
      createdAt: this.deps.clock.now(),
      fullMd: '',
    }
    summary.fullMd = renderMarkdown(meta, { ...summary, reasons: parts.reasons })

    // 先落库再落盘：库是真相，文件是给人读的副本。反过来会出现「有文件没记录」。
    this.deps.summaries.upsert(summary, parts.transcript)
    const path = await this.deps.markdown.write(summaryFileName(job.bvid), summary.fullMd)

    this.deps.events.emit({ type: 'summary.done', bvid: job.bvid })
    this.logger.info({ bvid: job.bvid, path, degrade: summary.degradePath }, '总结完成')
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
  private async runAsr(bvid: string, stage: StageHook): Promise<Result<Cue[]>> {
    const { audio, asr } = this.deps
    if (audio === null || asr === null) return fail(fatalFailure('音频转写没接入这个进程'))

    stage('download')
    let path: string
    try {
      path = (await audio.download(bvid)).path
    } catch (err) {
      return fail(fatalFailure(`下载音频失败：${message(err)}`))
    }

    stage('asr')
    try {
      const cues = await asr.transcribe(path, { language: this.deps.asrConfig().language })
      if (cues.length === 0) return fail(fatalFailure('转写结果是空的'))
      // 成功即删。失败留着：孤儿文件超过 24h 由启动时的清理兜掉。
      await audio.cleanup(path)
      return ok(cues)
    } catch (err) {
      return fail(fatalFailure(`语音转写失败：${message(err)}`))
    }
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

interface SummaryParts extends SummaryDraft {
  transcript: string
  step: DegradeStep
  reasons: readonly string[]
}

const note = (c: TranscriptChunk, text: string): ChunkNote => ({
  index: c.index,
  startSec: c.startSec,
  endSec: c.endSec,
  text,
})

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
