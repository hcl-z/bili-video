import type { FilterRule, RuleKind, RuleScope } from '#shared/contract/subscription.ts'
import { fail, ok, type Result } from '#shared/contract/failure.ts'
import {
  compileRegex,
  evaluate,
  resolveRules,
  ruleLabel,
  type Evaluation,
  type FilterTarget,
  type RegexMatcher,
} from '../domain/filter.ts'
import type { Clock } from '../types/platform.ts'
import type { ConfigStore } from '../types/persistence.ts'
import type { Logger } from '../types/platform.ts'
import type { FilterRuleRepo } from '../types/persistence.ts'

export interface RuleDeps {
  rules: FilterRuleRepo
  config: ConfigStore
  clock: Clock
  logger: Logger
  /** 带超时的正则匹配器。超时中断需要 node:vm，所以它是注入的 infra */
  match: RegexMatcher
}

export interface RuleProbe {
  hits: { id: number; label: string; timedOut: boolean }[]
  verdict: Evaluation['verdict']

  used: FilterRule[]
}

export class RuleService {
  private readonly deps: RuleDeps
  private readonly logger: Logger
  /** 正则超时次数，按规则 id 记。规则页要能看见「应项规则一直在超时」 */
  private readonly timeouts = new Map<number, number>()

  constructor(deps: RuleDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'rules' })
  }

  list(): FilterRule[] {
    return this.deps.rules.list()
  }

  add(rule: {
    scope: RuleScope
    kind: RuleKind
    pattern: string
    enabled: boolean
  }): Result<FilterRule> {
    const bad = badPattern(rule.kind, rule.pattern)
    if (bad !== null) {
      return fail({ kind: 'fatal', code: null, message: bad, retryAfterMs: null })
    }
    return ok(this.deps.rules.add(rule))
  }

  setEnabled(id: number, enabled: boolean): void {
    this.deps.rules.setEnabled(id, enabled)
  }

  remove(id: number): void {
    this.deps.rules.remove(id)
    this.timeouts.delete(id)
  }


  validateAll(): FilterRule[] {
    const broken = this.deps.rules.list().filter((r) => badPattern(r.kind, r.pattern) !== null)
    if (broken.length > 0) {
      this.logger.error({ ids: broken.map((r) => r.id), count: broken.length }, '正则规则编译失败')
    }
    return broken
  }


  judge(uid: string, target: FilterTarget): Evaluation {
    const rules = resolveRules(uid, this.deps.rules.listEffective(uid))
    const result = this.run(rules, target)
    for (const hit of result.hits) {
      if (!hit.timedOut) continue
      const n = (this.timeouts.get(hit.rule.id) ?? 0) + 1
      this.timeouts.set(hit.rule.id, n)
      this.logger.warn({ ruleId: hit.rule.id, pattern: hit.rule.pattern, timeouts: n }, '正则执行超时')
    }
    return result
  }

  /** 样本测试框：贴一段文本，回「命中了哪些规则 + 最终判定」 */
  probe(input: { uid: string | null; sample: string }): RuleProbe {
    const used =
      input.uid === null
        ? this.deps.rules.list().filter((r) => r.enabled && r.scope === 'global')
        : resolveRules(input.uid, this.deps.rules.listEffective(input.uid))
    const result = this.run(used, { title: null, text: input.sample, desc: null })
    return {
      hits: result.hits.map((h) => ({
        id: h.rule.id,
        label: ruleLabel(h.rule),
        timedOut: h.timedOut,
      })),
      verdict: result.verdict,
      used,
    }
  }

  timeoutCounts(): Map<number, number> {
    return new Map(this.timeouts)
  }

  private run(rules: FilterRule[], target: FilterTarget): Evaluation {
    return evaluate({
      target,
      rules,
      match: this.deps.match,
      minuteOfDay: this.minuteOfDay(),
      quietHours: this.deps.config.getSection('filter').quietHours,
    })
  }


  private minuteOfDay(): number {
    const d = new Date(this.deps.clock.now())
    return d.getHours() * 60 + d.getMinutes()
  }
}

function badPattern(kind: RuleKind, pattern: string): string | null {
  if (kind !== 'regex-allow' && kind !== 'regex-deny') return null
  return compileRegex(pattern) === null ? `正则编译不过：${pattern}` : null
}
