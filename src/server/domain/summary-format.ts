import type { ParseState, ReaderItem, SummaryState } from '#shared/contract/api.ts'
import type { Result } from '#shared/contract/failure.ts'
import { fail, ok } from '#shared/contract/failure.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import type { Cue, Summary } from '#shared/contract/summary.ts'
import type { Update } from '#shared/contract/update.ts'
import { chapterLink, hms, videoUrl } from '#shared/format.ts'

import { fatalFailure } from './bili-error.ts'

/** 总结的纯逻辑：提示词、收模型回的正文、渲染落盘的 Markdown。 */

export interface VideoMeta {
  bvid: string
  title: string
  url: string
  upName: string | null
  /** 全链路失败时，封面是「最小可推送内容」的一部分。 */
  cover?: string | null
}

/**
 * 解析到哪一步了。任务比总结优先：重跑时库里既有旧总结又有 pending 任务，
 * 这时候该说「排队中」。
 */
export function parseState(job: SummaryJob | null, hasSummary: boolean): ParseState {
  if (job !== null && job.status !== 'done') return job.status
  if (hasSummary) return 'done'
  return 'none'
}

/** 仅当过滤条目未入队且无总结时显示「已拦下」；否则按解析状态显示。 */
export function feedState(
  u: Update | null,
  job: SummaryJob | null,
  hasSummary: boolean,
): SummaryState {
  if (u?.filtered === true && job === null && !hasSummary) return 'filtered'
  return parseState(job, hasSummary)
}

/** 阅读页一行的可显示部分。本地库的行和空间流的条目各自能凑出这些字段。 */
export type ReaderItemBase = Pick<
  ReaderItem,
  'dynId' | 'uid' | 'type' | 'pubTs' | 'title' | 'text' | 'desc' | 'cover' | 'pics' | 'bvid' | 'url'
>

/** 将显示字段和本地状态合成为阅读页条目；filtered 不影响手动解析状态。 */
export function readerItem(
  base: ReaderItemBase,
  local: { update: Update | null; summary: Summary | null; job: SummaryJob | null },
): ReaderItem {
  return {
    ...base,
    inDb: local.update !== null,
    // 没有 bvid 就永远不会有总结，别让它显示「未解析」那种像是在等什么的状态。
    state: base.bvid === null ? 'none' : parseState(local.job, local.summary !== null),
    degradePath: local.summary?.degradePath ?? null,
    filterReason: local.update?.filterReason ?? null,
    jobStage: local.job === null ? null : local.job.stage,
  }
}

/** 提示词字幕行：压缩空白以减少 token，并与分段计数使用相同格式。 */
export const cueLine = (c: Cue): string => `[${hms(c.from)}]${squeeze(c.text)}`

const squeeze = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** 将字幕转为带时间戳文本，用于提示词和 transcript 存储；去除相邻重复行。 */
export function transcriptText(cues: readonly Cue[]): string {
  const lines: string[] = []
  let previous = ''
  for (const c of cues) {
    const text = squeeze(c.text)
    if (text === '' || text === previous) continue
    previous = text
    lines.push(`[${hms(c.from)}]${text}`)
  }
  return lines.join('\n')
}

/** 写作要求。原样进 system，各处只能有一份。 */
const WRITING_TASK = [
  '你将把一段视频重写成"阅读版本"，按内容主题分成若干小节；目标是让读者通过阅读就能完整理解视频讲了什么，就好像是在读一篇 Blog 版的文章一样。',
  '',
  '输出要求：',
  '',
  '1. Overview',
  '用一段话点明视频的核心论题与结论。',
  '',
  '2. 按照主题来梳理',
  '- 每个小节都需要根据视频中的内容详细展开，让我不需要再二次查看视频了解详情，每个小节不少于 500 字。',
  '- 若出现方法/框架/流程，将其重写为条理清晰的步骤或段落。',
  '- 若有关键数字、定义、原话，请如实保留核心词，并在括号内补充注释。',
  '- 如果提供给你的有时间戳信息，那给每个小节加个起始的时间戳，便于我定位内容，否则直接忽略这一点。',
  '',
  '3. 框架 & 心智模型（Framework & mental models）',
  '可以从视频中抽象出什么 framework & mental models，将其重写为条理清晰的步骤或段落，每个 framework & mental models 不少于 500 字。',
  '',
  '风格与限制：',
  '- 永远不要高度浓缩！',
  '- 不新增事实；若出现含混表述，请保持原意并注明不确定性。',
  '- 专有名词保留原文，并在括号给出中文释义（若转录中出现或能直译）。',
  '- 要求类的问题不用体现出来（例如 > 500 字）。',
  '- 避免一个段落的内容过多，可以拆解成多个逻辑段落（使用 bullet points）。',
].join('\n')

/** 时间戳行的格式说明。模型要照抄时间点，得先知道每行长什么样。 */
const CUE_FORMAT = '转录（每行形如 `[时间]内容`，时间是 `mm:ss`，超过一小时是 `h:mm:ss`）：'

export function summaryPrompt(meta: VideoMeta, transcript: string): { system: string; user: string } {
  return {
    system: WRITING_TASK,
    user: lines([
      `视频标题：${meta.title}`,
      meta.upName === null ? '' : `UP 主：${meta.upName}`,
      '',
      CUE_FORMAT,
      transcript,
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
 *
 * 要求写得详细：汇总那一步看不到原文，这里省下的字数就是最终小节缺的内容。
 */
export function chunkPrompt(
  meta: VideoMeta,
  part: { index: number; total: number; startSec: number; endSec: number; transcript: string },
): { system: string; user: string } {
  return {
    system:
      '你把视频的这一段转录重写成可读的中文段落，供后续合成一篇文章使用。' +
      '不要 JSON、不要客套话。结论只能来自给定字幕，不新增事实。',
    user: lines([
      `视频标题：${meta.title}`,
      `这是第 ${part.index + 1}/${part.total} 段，覆盖 ${hms(part.startSec)}–${hms(part.endSec)}。`,
      '',
      CUE_FORMAT,
      part.transcript,
      '',
      '按主题把这一段展开写清楚，不要高度浓缩：说清作者的论证、步骤、给出的数字和定义，' +
        '专有名词保留原文。段落可以用 `-` 列表拆开。',
      '每个话题以 `[时间]` 开头标出它开始的位置，时间点照抄上面出现过的那些，格式也照抄。',
      '这一段之外的内容不要写。',
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
    system: WRITING_TASK,
    user: lines([
      `视频标题：${meta.title}`,
      meta.upName === null ? '' : `UP 主：${meta.upName}`,
      '',
      '这个视频按时间切成了几段，以下是逐段的详细内容：',
      '',
      ...body,
      '',
      '小节按主题划分，不必和上面的分段一一对应；同一主题跨了几段就合起来写。',
      '时间戳沿用上面出现过的那些，它们是原视频的绝对时间，不要重新编号。',
    ]),
  }
}

/** 简介兜底提示词明确仅有标题和简介，避免模型补充未提供的细节。 */
export function metaPrompt(
  meta: VideoMeta,
  brief: string,
  parts: readonly string[] = [],
): { system: string; user: string } {
  return {
    system:
      '你只有标题和简介，没有正片内容。用一两段话写清这个视频大概在讲什么，' +
      '不要编造视频里的细节、数字、结论；写不出来就说「简介没提」。不要小标题。',
    user: lines([
      `视频标题：${meta.title}`,
      meta.upName === null ? '' : `UP 主：${meta.upName}`,
      brief === '' ? '简介：（空）' : `简介：${brief}`,
      parts.length <= 1 ? '' : `分 P 标题：${parts.join('、')}`,
    ]),
  }
}

const lines = (parts: readonly string[]): string => parts.filter((l) => l !== '').join('\n')

/** 模型回的正文。空的算这次没成，重试同一个模型也不会变好，所以是 fatal。 */
export function parseArticle(reply: string): Result<string> {
  const article = stripFence(reply).trim()
  if (article === '') return fail(fatalFailure('模型回了空正文'))
  return ok(article)
}

/** 有的模型会把整篇裹在 ```markdown 围栏里。 */
function stripFence(reply: string): string {
  const trimmed = reply.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const firstBreak = trimmed.indexOf('\n')
  const end = trimmed.lastIndexOf('```')
  if (firstBreak === -1 || end <= firstBreak) return trimmed
  return trimmed.slice(firstBreak + 1, end)
}

/** 推送导语取正文首个非标题段落，最长 80 字。 */
export function leadLine(article: string): string {
  for (const raw of article.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || /^[-*_]{3,}$/.test(line)) continue
    const clean = line
      .replace(/^>\s*/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/[*`_]/g, '')
      .trim()
    if (clean !== '') return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean
  }
  return ''
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
  extends Pick<Summary, 'article' | 'transcriptSource' | 'confidence' | 'degradePath'> {
  /** 降级原因，每退一级一条。没降级就是空的。 */
  reasons?: readonly string[]
}

/** 渲染落盘 Markdown，补充标题、链接、来源和降级信息。 */
export function renderMarkdown(meta: VideoMeta, s: RenderParts): string {
  const out: string[] = [`# ${meta.title}`, '', `<${meta.url}>`, '']
  if (meta.upName !== null) out.push(`UP 主：${meta.upName}`, '')
  // 全链路失败时封面是仅剩的内容之一，所以只在那一级贴图。
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

  out.push('---', '', s.article)
  return `${out.join('\n')}\n`
}

/** 行首和标题里的 `[mm:ss]` 变成能点的链接，跳到 B 站的那一秒。 */
export function linkTimestamps(article: string, bvid: string): string {
  return article.replace(/\[(\d{1,2}(?::\d{2}){1,2})\](?!\()/g, (whole, stamp: string) => {
    const parts = stamp.split(':').map(Number)
    if (parts.some((n) => !Number.isFinite(n))) return whole
    const sec = parts.reduce((acc, n) => acc * 60 + n, 0)
    return `[${stamp}](${chapterLink(bvid, sec)})`
  })
}

/** 落盘文件名。用 bvid 而不是标题：标题会改，改完重跑会留下一份孤儿文件。 */
export const summaryFileName = (bvid: string): string => `${bvid}.md`
