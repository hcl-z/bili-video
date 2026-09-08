import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { JobStage, SummaryJob } from '#shared/contract/job.ts'
import type { Cue, Summary, TranscriptSource } from '#shared/contract/summary.ts'
import { fatalFailure } from '../domain/bili-error.ts'
import { degradeFor } from '../domain/degrade.ts'
import {
  parseSummaryDraft,
  renderMarkdown,
  summaryFileName,
  summaryPrompt,
  transcriptText,
  videoRef,
  type VideoMeta,
} from '../domain/summary-format.ts'
import type { SubtitleFetcher } from '../ports/bili.ts'
import type { Clock } from '../ports/clock.ts'
import type { EventBus } from '../ports/event-bus.ts'
import type { Llm } from '../ports/llm.ts'
import type { Logger } from '../ports/logger.ts'
import type { MarkdownWriter } from '../ports/markdown.ts'
import type { LlmCallRepo, SubscriptionRepo, SummaryRepo, UpdateRepo } from '../ports/repo.ts'

/** 转写结果。source 决定这份总结的置信度，也决定降级路径记成哪一级。 */
export interface Transcript {
  cues: Cue[]
  source: TranscriptSource
}

export type StageHook = (stage: JobStage) => void

export interface SummarizeDeps {
  subtitles: SubtitleFetcher | null
  /** ★ 只从这里取 LLM：总开关关着时它返回 null（见 AiService.llm）。 */
  llm: () => Llm | null
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
 * 一个视频的总结管线，拆成「转写」和「总结」两段。
 *
 * 拆开不是为了好看：两段分属两条并发通道（转写 1 / LLM 2），闸门在队列那边，
 * 所以这里必须把两段作为两个可分别调度的入口暴露出去。
 */
export class SummarizeVideo {
  private readonly deps: SummarizeDeps
  private readonly logger: Logger

  constructor(deps: SummarizeDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'summarize' })
  }

  /** 第一段：拿到带时间戳的文本。这一票只走官方字幕，ASR 兜底是第 10 票。 */
  async transcribe(bvid: string, stage: StageHook): Promise<Result<Transcript>> {
    stage('subtitle')
    const fetcher = this.deps.subtitles
    if (fetcher === null) return fail(fatalFailure('字幕适配器没接入这个进程'))

    const res = await fetcher.fetch(bvid)
    if (!res.ok) return fail(res.failure)
    if (res.value === null || res.value.length === 0) {
      // 明确失败而不是静默跳过：判据要求「不静默消失」，音频转写兜底要到第 10 票。
      return fail(fatalFailure('这个视频没有官方字幕（AI 字幕也没有），等音频转写那一票兜底'))
    }
    return ok({ cues: res.value, source: 'subtitle' })
  }

  /** 第二段：调 LLM、解析、落库落盘。 */
  async summarize(job: SummaryJob, t: Transcript, stage: StageHook): Promise<Result<Summary>> {
    const llm = this.deps.llm()
    if (llm === null) return fail(fatalFailure('AI 总结已关闭（ai.enabled=false）'))

    const meta = this.meta(job)
    const transcript = transcriptText(t.cues)

    stage('reduce')
    const prompt = summaryPrompt(meta, transcript)
    const completion = await llm.complete([
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ])
    if (!completion.ok) return fail(completion.failure)

    const usage = completion.value.usage
    this.deps.llmCalls.record({
      bvid: job.bvid,
      stage: 'reduce',
      model: usage.model,
      inTokens: usage.inTokens,
      outTokens: usage.outTokens,
      ms: usage.ms,
      at: this.deps.clock.now(),
    })

    const draft = parseSummaryDraft(completion.value.text)
    if (!draft.ok) return fail(draft.failure)

    stage('persist')
    const parts = {
      bvid: job.bvid,
      tldr: draft.value.tldr,
      points: draft.value.points,
      chapters: draft.value.chapters,
      transcriptSource: t.source,
      ...degradeFor(t.source),
      createdAt: this.deps.clock.now(),
    }
    const summary: Summary = { ...parts, fullMd: renderMarkdown(meta, parts) }

    // 先落库再落盘：库是真相，文件是给人读的副本。反过来会出现「有文件没记录」。
    this.deps.summaries.upsert(summary, transcript)
    const path = await this.deps.markdown.write(summaryFileName(job.bvid), summary.fullMd)

    this.deps.events.emit({ type: 'summary.done', bvid: job.bvid })
    this.logger.info({ bvid: job.bvid, path, points: summary.points.length }, '总结完成')
    return ok(summary)
  }

  /** 标题这些东西来自动态那条记录；记录不见了就退回 bvid，不让整条任务失败。 */
  private meta(job: SummaryJob): VideoMeta {
    const update = this.deps.updates.get(job.updateId) ?? null
    const uid = update?.uid ?? null
    return {
      bvid: job.bvid,
      ...videoRef(job.bvid, update),
      upName: uid === null ? null : (this.deps.subs.get(uid)?.name ?? null),
    }
  }
}
