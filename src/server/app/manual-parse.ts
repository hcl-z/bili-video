import type { ReaderItem } from '#shared/contract/api.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import { fail, ok, type Result } from '#shared/contract/failure.ts'
import type { Update } from '#shared/contract/update.ts'
import { classifyBiliCode, fatalFailure } from '../domain/bili-error.ts'
import { parseState } from '../domain/summary-format.ts'
import type { BiliVideoClient } from '../infra/bili/video.ts'
import { isBvid } from '../infra/bili/video.ts'
import { CueSchema, type Cue } from '#shared/contract/summary.ts'
import { transcriptText } from '../domain/summary-format.ts'
import type { Transcript } from './summarize-video.ts'
import type { SummaryQueue } from './queue-runner.ts'
import type { JobArtifactRepo } from '../types/persistence.ts'
import { z } from 'zod'
import type { Clock } from '../types/platform.ts'
import type { Logger } from '../types/platform.ts'
import type { JobRepo, SummaryRepo, UpdateRepo } from '../types/persistence.ts'

/** MCP 侧「按 bvid 排一条解析」。 网页那条路径是从某个 UP 的空间流里点开动态，天然带着 dynId；MCP 只拿到 bvid， 所以这里现拉一次 view 合成记录并落库 —— summaries 的标题、封面、简介都从 updates 读，不落库就只剩一个 BV 号 */

export interface ManualParseDeps {
  reader: BiliVideoClient | null
  updates: UpdateRepo
  jobs: JobRepo
  summaries: SummaryRepo
  artifacts: JobArtifactRepo
  queue: SummaryQueue
  clock: Clock
  logger: Logger
}

/** 转写产物是队列自己落的中间结果，不是对外契约 —— 读回来时按 Cue 形状校验 */
const TranscriptArtifactSchema = z.object({
  cues: CueSchema.array(),
  step: z.enum(['subtitle', 'asr', 'link']),
  reasons: z.array(z.string()),
})

export interface TranscriptView {
  bvid: string
  /** 数据来自官方字幕还是语音转写；once 有值就说明拿到过 */
  source: 'subtitle' | 'asr' | 'none'
  cueCount: number
  /** 带时间戳的纯文本，和落盘 Markdown 里那段一致 */
  text: string
  cues: Cue[]
  reasons: string[]
}

export type EnqueueOutcome =
  | { kind: 'enqueued'; job: SummaryJob }
  | { kind: 'reused'; job: SummaryJob }

export class ManualParseService {
  private readonly deps: ManualParseDeps
  private readonly logger: Logger

  constructor(deps: ManualParseDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'manual-parse' })
  }

  /**
   * 已有动态记录就不再打 B 站：MCP 常被同一个 bvid 反复问状态，
   * 每次重拉只会白白多吃一次风控。
   */
  /**
   * 取已落库的转写。队列一跑完转写就会写产物，所以这里不依赖总结成功与否 ——
   * 之前转写只在落总结时一起写，LLM 一挂字幕就白取了。
   */
  transcript(bvid: string): Result<TranscriptView | null> {
    if (!isBvid(bvid)) return fail(fatalFailure(`bvid 形状不对：${bvid}`))
    const row = this.deps.artifacts.get(bvid, 'transcript')
    if (row === null) return ok(null)

    let parsed: Transcript
    try {
      const value = TranscriptArtifactSchema.safeParse(JSON.parse(row.payload))
      if (!value.success) return fail(fatalFailure(`${bvid} 的转写产物形状不对`))
      parsed = value.data
    } catch {
      return fail(fatalFailure(`${bvid} 的转写产物解析失败`))
    }
    if (parsed.cues.length === 0) return ok(null)

    return ok({
      bvid,
      source: parsed.step === 'link' ? 'none' : parsed.step,
      cueCount: parsed.cues.length,
      text: transcriptText(parsed.cues),
      cues: parsed.cues,
      reasons: parsed.reasons,
    })
  }

  async parse(
    bvid: string,
    opts: { force?: boolean; want?: 'transcript' | 'summary' } = {},
  ): Promise<Result<EnqueueOutcome>> {
    if (!isBvid(bvid)) return fail(fatalFailure(`bvid 形状不对：${bvid}`))

    const want = opts.want ?? 'transcript'
    const existingJob = this.deps.jobs.getByBvid(bvid)
    if (opts.force !== true && existingJob !== null) {
      const job = this.deps.queue.enqueue({ bvid, updateId: existingJob.updateId, want })
      return ok({ kind: 'reused', job })
    }

    if (existingJob !== null) {
      // 已有任务时不再打 B 站：它和这条 bvid 绑定，view 拉失败也不该挡住改目标。
      // 只有真在跑的那条不能动，pending 只是还没取到活。
      if (existingJob.status === 'running') {
        return ok({ kind: 'reused', job: this.deps.jobs.get(existingJob.id) ?? existingJob })
      }
      if (existingJob.want !== want) {
        this.deps.queue.enqueue({ bvid, updateId: existingJob.updateId, want })
        return ok({ kind: 'enqueued', job: this.deps.jobs.get(existingJob.id) ?? existingJob })
      }
      // 目标没变但要强制重来：丢掉产物与重试计数，从头再跑。
      this.deps.queue.retry(existingJob.id, undefined, want)
      return ok({ kind: 'enqueued', job: this.deps.jobs.get(existingJob.id) ?? existingJob })
    }

    const update = await this.ensureUpdate(bvid)
    if (!update.ok) return fail(update.failure)

    const job = this.deps.queue.enqueue({ bvid, updateId: update.value.dynId, want })
    this.logger.info({ bvid, jobId: job.id }, 'MCP 手动排解析')
    return ok({ kind: 'enqueued', job })
  }

  /** 单条进度与结果，形状和网页右栏一致，省得 MCP 客户端自己拼。 */
  status(bvid: string): Result<ReaderItem> {
    if (!isBvid(bvid)) return fail(fatalFailure(`bvid 形状不对：${bvid}`))
    const update = this.deps.updates.getByBvid(bvid)
    if (update === null) return fail(fatalFailure(`库里没有 ${bvid}，先调 bili_parse_video`))

    const job = this.deps.jobs.getByBvid(bvid)
    const summary = this.deps.summaries.get(bvid)
    return ok({
      dynId: update.dynId,
      uid: update.uid,
      type: update.type,
      pubTs: update.pubTs,
      title: update.title,
      text: update.text,
      desc: null,
      cover: update.cover,
      pics: [],
      bvid: update.bvid,
      url: update.url,
      inDb: true,
      // 手动排解析不判规则，所以没有 filtered 这一档
      state: parseState(job, summary !== null),
      degradePath: summary?.degradePath ?? null,
      filterReason: update.filterReason,
      jobStage: job?.status === 'running' ? job.stage : job?.stage ?? null,
    })
  }

  private async ensureUpdate(bvid: string): Promise<Result<Update>> {
    const cached = this.deps.updates.getByBvid(bvid)
    // 被规则拦下的旧记录也要重拉：手动排队不判规则，但记录本身可能缺标题
    if (cached !== null && cached.title !== null) return ok(cached)

    const reader = this.deps.reader
    if (reader === null) return fail(fatalFailure('读接口未接入这个进程'))

    const dyn = await reader.asDynamic(bvid)
    if (!dyn.ok) {
      const failure = dyn.failure
      // view 对不存在的视频回 -404，那是终态，别让调用方傻等重试
      const classified = failure.code === null ? failure : classifyBiliCode(failure.code, failure.message) ?? failure
      return fail(classified)
    }

    const at = this.deps.clock.now()
    this.deps.updates.insertMany(
      [
        {
          dynId: dyn.value.dynId,
          uid: dyn.value.uid,
          type: dyn.value.type,
          pubTs: dyn.value.pubTs,
          title: dyn.value.title,
          text: dyn.value.text ?? dyn.value.desc,
          cover: dyn.value.cover,
          bvid,
          url: dyn.value.url,
          raw: dyn.value.raw,
          filtered: false,
          filterReason: null,
          createdAt: at,
        },
      ],
      // 手动排的不进动态流，否则工作台左栏会凭空多出一条没人发过的动态
      { inFeed: false },
    )
    const stored = this.deps.updates.getByBvid(bvid)
    return stored === null ? fail(fatalFailure(`写入 ${bvid} 后读不回来`)) : ok(stored)
  }
}
