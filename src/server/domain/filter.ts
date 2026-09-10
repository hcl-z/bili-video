import { RULE_KIND_LABEL, type FilterRule } from '#shared/contract/subscription.ts'

/** 匹配范围：动态正文、视频标题、视频简介。总结正文不参与（不然为了过滤先花钱生成总结） */
export interface FilterTarget {
  title: string | null
  text: string | null
  desc: string | null
}

export type Verdict =
  | { kind: 'pass' }
  | { kind: 'blocked'; reason: string }

  | { kind: 'held'; reason: string }

export interface QuietHours {
  enabled: boolean

  start: string
  end: string
}

/** 正则匹配交给外面做，因为它需要超时中断。'timeout' 表示应项规则本次超时了 */
export type RegexMatcher = (pattern: string, text: string) => boolean | 'timeout'


export function resolveRules(uid: string, all: readonly FilterRule[]): FilterRule[] {
  const enabled = all.filter((r) => r.enabled)
  const mine = enabled.filter((r) => r.scope === uid)
  return mine.length > 0 ? mine : enabled.filter((r) => r.scope === 'global')
}

export interface EvaluateInput {
  target: FilterTarget
  rules: readonly FilterRule[]
  match: RegexMatcher

  minuteOfDay: number
  quietHours: QuietHours
}

export interface Evaluation {
  verdict: Verdict
  /** 命中明细。样本测试框直接显示它，超时的那几条也在里面 */
  hits: RuleHit[]
}

export function evaluate(input: EvaluateInput): Evaluation {
  const haystack = [input.target.title, input.target.text, input.target.desc]
    .filter((s): s is string => s !== null && s !== '')
    .join('\n')

  const hits = matchAll(haystack, input.rules, input.match)
  // 超时的不算命中：单条写坏的黑名单不应把所有内容都拦下
  const live = hits.filter((h) => !h.timedOut)

  const denied = live.find((h) => h.rule.kind === 'keyword-deny' || h.rule.kind === 'regex-deny')
  if (denied !== undefined) {
    return { verdict: { kind: 'blocked', reason: ruleLabel(denied.rule) }, hits }
  }

  const allows = input.rules.filter((r) => r.kind === 'keyword-allow' || r.kind === 'regex-allow')

  const allowIds = new Set(allows.map((r) => r.id))
  if (allows.length > 0 && !live.some((h) => allowIds.has(h.rule.id))) {
    const reason = `白名单非空且一条都没命中（共 ${allows.length} 条）`
    return { verdict: { kind: 'blocked', reason }, hits }
  }

  if (inQuietHours(input.minuteOfDay, input.quietHours)) {
    const reason = `免扰时段 ${input.quietHours.start}–${input.quietHours.end}`
    return { verdict: { kind: 'held', reason }, hits }
  }
  return { verdict: { kind: 'pass' }, hits }
}

export interface RuleHit {
  rule: FilterRule
  /** 正则超时：这条规则记为失败，但不影响别的规则和整轮轮询。 */
  timedOut: boolean
}

/** 样本测试框要的就是「命中了哪些」，所以判定和命中列表共用这一段。 */
export function matchAll(
  haystack: string,
  rules: readonly FilterRule[],
  match: RegexMatcher,
): RuleHit[] {
  const hits: RuleHit[] = []
  for (const rule of rules) {
    if (rule.kind === 'keyword-allow' || rule.kind === 'keyword-deny') {
      if (haystack.includes(rule.pattern)) hits.push({ rule, timedOut: false })
      continue
    }
    const r = match(rule.pattern, haystack)
    if (r === 'timeout') hits.push({ rule, timedOut: true })
    else if (r) hits.push({ rule, timedOut: false })
  }
  return hits
}

export function ruleLabel(rule: FilterRule): string {
  const scope = rule.scope === 'global' ? '全局' : `UID ${rule.scope}`
  return `${scope}${RULE_KIND_LABEL[rule.kind]}「${rule.pattern}」`
}

/** @returns null = 这个正则编译不过。启动校验和运行时用同一份判断。 */
export function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

export function inQuietHours(minuteOfDay: number, q: QuietHours): boolean {
  if (!q.enabled) return false
  const start = toMinutes(q.start)
  const end = toMinutes(q.end)
  if (start === null || end === null || start === end) return false
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (m === null) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h > 23 || min > 59 ? null : h * 60 + min
}
