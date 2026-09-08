import type { SummaryState } from '#shared/contract/api.ts'
import type { Result } from '#shared/contract/failure.ts'
import { fail, ok } from '#shared/contract/failure.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import type { Chapter, Cue, MetaDraft, Summary, SummaryDraft } from '#shared/contract/summary.ts'
import { MetaDraftSchema, SummaryDraftSchema } from '#shared/contract/summary.ts'
import type { Update } from '#shared/contract/update.ts'
import { chapterLink, hms, videoUrl } from '#shared/format.ts'

import { fatalFailure } from './bili-error.ts'

/** 结构化总结的纯逻辑：提示词、解析模型回来的 JSON、渲染 Markdown 全文。 */

export interface VideoMeta {
  bvid: string
  title: string
  url: string
  upName: string | null
  /** 全链路失败时，封面是「最小可推送内容」的一部分。 */
  cover?: string | null
}

/**
 * 一条视频在工作台上的状态。被拦下的优先 —— 它连队列都没进过。
 *
 * 任务比总结优先：重跑时库里既有旧总结又有 pending 任务，这时候该说「排队中」。
 */
export function feedState(u: Update | null, job: SummaryJob | null, hasSummary: boolean): SummaryState {
  if (u?.filtered === true) return 'filtered'
  if (job !== null && job.status !== 'done') return job.status
  if (hasSummary) return 'done'
  return 'none'
}

/** 提示词里的一条字幕。分段的 token 计数也按这个形状算，免得算的和送的不是一份文本。 */
export const cueLine = (c: Cue): string => `[${hms(c.from)}] ${c.text.trim()}`

/** 字幕 → 带时间戳的纯文本。这份文本既进提示词，也原样存进 summaries.transcript。 */
export function transcriptText(cues: readonly Cue[]): string {
  return cues
    .filter((c) => c.text.trim() !== '')
    .map(cueLine)
    .join('\n')
}

const JSON_ONLY =
  '你是中文视频内容总结助手。只输出一个 JSON 对象，不要代码围栏，不要任何解释文字。'
const DRAFT_SHAPE =
  '{"tldr":"一句话讲清这个视频在干什么，60 字以内",' +
  '"points":["3-5 条核心要点，每条一句话"],' +
  '"chapters":[{"startSec":0,"title":"章节标题","desc":"一句话说明，可省略"}]}'

export function summaryPrompt(meta: VideoMeta, transcript: string): { system: string; user: string } {
  return {
    system: `${JSON_ONLY}结论只能来自给定字幕，字幕里没有的事实一律不写。`,
    user: lines([
      `视频标题：${meta.title}`,
      meta.upName === null ? '' : `UP 主：${meta.upName}`,
      '',
      '字幕（每行形如 `[时间] 内容`，时间是 `mm:ss`，超过一小时是 `h:mm:ss`）：',
      transcript,
      '',
      '按这个形状回一个 JSON：',
      DRAFT_SHAPE,
      'chapters 覆盖全片，4-8 段，startSec 用整数秒且必须落在字幕出现过的时间点上。',
    ]),
  }
}

/** 一段的要点。时间范围要带着，汇总阶段才能把章节时间戳落回原视频。 */
export interface ChunkNote {
  index: number
  startSec: number
  endSec: number
  text: string
}

/**
 * 分段阶段。这一步刻意不要 JSON：它的产出只喂给汇总那一步，
 * 多一道形状校验只会让一段解析失败就废掉整篇。
 */
export function chunkPrompt(
  meta: VideoMeta,
  part: { index: number; total: number; startSec: number; endSec: number; transcript: string },
): { system: string; user: string } {
  return {
    system:
      '你是中文视频内容总结助手。只输出要点行，不要 JSON、不要小标题、不要客套话。' +
      '结论只能来自给定字幕。',
    user: lines([
      `视频标题：${meta.title}`,
      `这是第 ${part.index + 1}/${part.total} 段，覆盖 ${hms(part.startSec)}–${hms(part.endSec)}。`,
      '',
      '字幕（每行形如 `[时间] 内容`，时间是 `mm:ss`，超过一小时是 `h:mm:ss`）：',
      part.transcript,
      '',
      '用 3-6 行写这一段讲了什么，一行一件事，每行以 `[时间]` 开头，' +
        '时间点照抄上面出现过的那些，格式也照抄。这一段之外的内容不要写。',
    ]),
  }
}

/** 汇总阶段。拿到的是各段要点而不是全文，所以要显式要求时间戳沿用段内标注的那些。 */
export function reducePrompt(
  meta: VideoMeta,
  notes: readonly ChunkNote[],
): { system: string; user: string } {
  const body = notes.map(
    (n) => `第 ${n.index + 1} 段（${hms(n.startSec)}–${hms(n.endSec)}）：\n${n.text}`,
  )
  return {
    system: `${JSON_ONLY}结论只能来自给定的分段要点，要点里没有的事实一律不写。`,
    user: lines([
      `视频标题：${meta.title}`,
      meta.upName === null ? '' : `UP 主：${meta.upName}`,
      '',
      '这个视频被分段总结过，以下是各段的要点：',
      '',
      ...body,
      '',
      '把它们合成一份总览，按这个形状回一个 JSON：',
      DRAFT_SHAPE,
      'chapters 覆盖全片，4-8 段，startSec 用整数秒，且必须是上面要点里出现过的时间点 —— ' +
        '它们是原视频的绝对时间，不要重新编号；`h:mm:ss` 是时:分:秒，换算成秒再填。',
    ]),
  }
}

/**
 * 简介兜底那一级。语音内容一个字都没拿到，所以提示词里要反复讲清「只有标题和简介」，
 * 否则模型会拿常识把细节补齐，那正是低置信度总结最坑人的地方。
 */
export function metaPrompt(
  meta: VideoMeta,
  brief: string,
  parts: readonly string[] = [],
): { system: string; user: string } {
  return {
    system:
      `${JSON_ONLY}你只有标题和简介，没有正片内容。` +
      '不要编造视频里的细节、数字、结论；写不出来就说「简介没提」。',
    user: lines([
      `视频标题：${meta.title}`,
      meta.upName === null ? '' : `UP 主：${meta.upName}`,
      brief === '' ? '简介：（空）' : `简介：${brief}`,
      parts.length <= 1 ? '' : `分 P 标题：${parts.join('、')}`,
      '',
      '按这个形状回一个 JSON：',
      '{"tldr":"根据标题与简介，这个视频大概在讲什么，60 字以内",' +
        '"points":["2-4 条能从标题与简介确定的信息，每条一句话"]}',
      '不要 chapters —— 你没有时间轴。',
    ]),
  }
}

const lines = (parts: readonly string[]): string => parts.filter((l) => l !== '').join('\n')

/** 模型回的 JSON。解析不了是可预期的失败，重试同一个模型也不会变好，所以是 fatal。 */
export const parseSummaryDraft = (reply: string): Result<SummaryDraft> =>
  parseJsonReply(reply, SummaryDraftSchema)

export const parseMetaDraft = (reply: string): Result<MetaDraft> =>
  parseJsonReply(reply, MetaDraftSchema)

/** 只要能 safeParse 就够，写成结构类型是为了不让 domain 直接依赖 zod。 */
interface Parsable<T> {
  safeParse: (
    raw: unknown,
  ) =>
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }
}

function parseJsonReply<T>(reply: string, schema: Parsable<T>): Result<T> {
  const json = extractJson(reply)
  if (json === null) return fail(fatalFailure(`模型回的不是 JSON：${reply.slice(0, 120)}`))

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return fail(fatalFailure(`模型回的 JSON 解不开：${err instanceof Error ? err.message : String(err)}`))
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')
    return fail(fatalFailure(`模型回的 JSON 形状不对：${issues}`))
  }
  return ok(parsed.data)
}

/** 围栏、前后的客套话都可能有；取第一个 `{` 到最后一个 `}` 之间那段。 */
function extractJson(reply: string): string | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return reply.slice(start, end + 1)
}

/** 动态那条记录可能已经不在了（清过库、换过 bvid），退回 bvid 本身而不是让调用方各写一遍。 */
export function videoRef(
  bvid: string,
  update: { title: string | null; url: string } | null,
): { title: string; url: string } {
  return { title: update?.title ?? bvid, url: update?.url ?? videoUrl(bvid) }
}

const SOURCE_LABEL: Record<Summary['transcriptSource'], string> = {
  subtitle: '官方/AI 字幕',
  asr: '本地语音转写',
  none: '没有语音内容',
}

export interface RenderParts
  extends Pick<
    Summary,
    'tldr' | 'points' | 'chapters' | 'transcriptSource' | 'confidence' | 'degradePath'
  > {
  /** 降级原因，每退一级一条。没降级就是空的。 */
  reasons?: readonly string[]
}

/** Markdown 全文。降级必须在正文里写明，不能只体现在字段上。 */
export function renderMarkdown(meta: VideoMeta, s: RenderParts): string {
  const out: string[] = [`# ${meta.title}`, '', `<${meta.url}>`, '']
  if (meta.upName !== null) out.push(`UP 主：${meta.upName}`, '')
  // 全链路失败时封面是仅剩的内容之一，所以只在那一级贴图，别让正常总结顶个大图。
  if (s.degradePath === 'link-only' && typeof meta.cover === 'string' && meta.cover !== '') {
    out.push(`![封面](${meta.cover})`, '')
  }
  out.push(`来源：${SOURCE_LABEL[s.transcriptSource]}`, '')

  if (s.degradePath === 'link-only') {
    out.push('> 这条没能生成总结，只剩标题与链接。', '')
  } else if (s.confidence === 'low') {
    out.push('> 低置信度：未获取到语音内容，以下基于标题与简介推测。', '')
  }
  for (const r of s.reasons ?? []) out.push(`> - ${r}`)
  if ((s.reasons ?? []).length > 0) out.push('')

  out.push('## TL;DR', '', s.tldr, '')
  if (s.points.length > 0) {
    out.push('## 核心要点', '')
    for (const p of s.points) out.push(`- ${p}`)
  }

  if (s.chapters.length > 0) {
    out.push('', '## 章节', '')
    for (const c of s.chapters) out.push(chapterLine(meta.bvid, c))
  }
  return `${out.join('\n')}\n`
}

const chapterLine = (bvid: string, c: Chapter): string => {
  const head = `- [${hms(c.startSec)}](${chapterLink(bvid, c.startSec)}) ${c.title}`
  return c.desc === null ? head : `${head} —— ${c.desc}`
}

/** 落盘文件名。用 bvid 而不是标题：标题会改，改完重跑会留下一份孤儿文件。 */
export const summaryFileName = (bvid: string): string => `${bvid}.md`
