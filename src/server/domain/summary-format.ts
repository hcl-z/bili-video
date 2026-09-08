import type { SummaryState } from '#shared/contract/api.ts'
import type { Result } from '#shared/contract/failure.ts'
import { fail, ok } from '#shared/contract/failure.ts'
import type { SummaryJob } from '#shared/contract/job.ts'
import type { Chapter, Cue, Summary, SummaryDraft } from '#shared/contract/summary.ts'
import { SummaryDraftSchema } from '#shared/contract/summary.ts'
import type { Update } from '#shared/contract/update.ts'
import { chapterLink, hms, videoUrl } from '#shared/format.ts'

import { fatalFailure } from './bili-error.ts'

/** 结构化总结的纯逻辑：提示词、解析模型回来的 JSON、渲染 Markdown 全文。 */

export interface VideoMeta {
  bvid: string
  title: string
  url: string
  upName: string | null
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

/** 字幕 → 带时间戳的纯文本。这份文本既进提示词，也原样存进 summaries.transcript。 */
export function transcriptText(cues: readonly Cue[]): string {
  return cues
    .filter((c) => c.text.trim() !== '')
    .map((c) => `[${hms(c.from)}] ${c.text.trim()}`)
    .join('\n')
}

export function summaryPrompt(meta: VideoMeta, transcript: string): { system: string; user: string } {
  return {
    system:
      '你是中文视频内容总结助手。只输出一个 JSON 对象，不要代码围栏，不要任何解释文字。' +
      '结论只能来自给定字幕，字幕里没有的事实一律不写。',
    user: [
      `视频标题：${meta.title}`,
      meta.upName === null ? '' : `UP 主：${meta.upName}`,
      '',
      '字幕（每行形如 `[mm:ss] 内容`）：',
      transcript,
      '',
      '按这个形状回一个 JSON：',
      '{"tldr":"一句话讲清这个视频在干什么，60 字以内",' +
        '"points":["3-5 条核心要点，每条一句话"],' +
        '"chapters":[{"startSec":0,"title":"章节标题","desc":"一句话说明，可省略"}]}',
      'chapters 覆盖全片，4-8 段，startSec 用整数秒且必须落在字幕出现过的时间点上。',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  }
}

/** 模型回的 JSON。解析不了是可预期的失败，重试同一个模型也不会变好，所以是 fatal。 */
export function parseSummaryDraft(reply: string): Result<SummaryDraft> {
  const json = extractJson(reply)
  if (json === null) return fail(fatalFailure(`模型回的不是 JSON：${reply.slice(0, 120)}`))

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return fail(fatalFailure(`模型回的 JSON 解不开：${err instanceof Error ? err.message : String(err)}`))
  }

  const parsed = SummaryDraftSchema.safeParse(raw)
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

/** Markdown 全文。低置信度必须在正文里写明，不能只体现在字段上。 */
export function renderMarkdown(
  meta: VideoMeta,
  s: Pick<Summary, 'tldr' | 'points' | 'chapters' | 'transcriptSource' | 'confidence'>,
): string {
  const lines: string[] = [`# ${meta.title}`, '', `<${meta.url}>`, '']
  if (meta.upName !== null) lines.push(`UP 主：${meta.upName}`, '')
  lines.push(`来源：${SOURCE_LABEL[s.transcriptSource]}`, '')
  if (s.confidence === 'low') {
    lines.push('> 低置信度：未获取到语音内容，以下基于标题与简介推测。', '')
  }

  lines.push('## TL;DR', '', s.tldr, '', '## 核心要点', '')
  for (const p of s.points) lines.push(`- ${p}`)

  if (s.chapters.length > 0) {
    lines.push('', '## 章节', '')
    for (const c of s.chapters) lines.push(chapterLine(meta.bvid, c))
  }
  return `${lines.join('\n')}\n`
}

const chapterLine = (bvid: string, c: Chapter): string => {
  const head = `- [${hms(c.startSec)}](${chapterLink(bvid, c.startSec)}) ${c.title}`
  return c.desc === null ? head : `${head} —— ${c.desc}`
}

/** 落盘文件名。用 bvid 而不是标题：标题会改，改完重跑会留下一份孤儿文件。 */
export const summaryFileName = (bvid: string): string => `${bvid}.md`
