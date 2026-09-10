import { createContext, Script } from 'node:vm'

import { compileRegex } from '../../domain/filter.ts'
import type { Logger } from '../../types/platform.ts'
import { errFields } from '../../log-fields.ts'


export class TimedRegex {
  private readonly script = new Script('re.test(s)')
  private readonly sandbox: { re: RegExp | null; s: string } = { re: null, s: '' }
  private readonly ctx = createContext(this.sandbox)
  private readonly budgetMs: () => number
  private readonly logger: Logger
  private readonly cache = new Map<string, RegExp | null>()

  constructor(budgetMs: () => number, logger: Logger) {
    this.budgetMs = budgetMs
    this.logger = logger.child({ mod: 'regex' })
  }

  /** @returns 'timeout' = 应项规则本次超时了（超时、或者压根编译不过） */
  test(pattern: string, text: string): boolean | 'timeout' {
    const re = this.compile(pattern)
    if (re === null) return 'timeout'
    this.sandbox.re = re
    this.sandbox.s = text
    try {
      return this.script.runInContext(this.ctx, { timeout: this.budgetMs() }) === true
    } catch (err) {
      // 超时是预期的；避免的抛错也只废掉应项规则，但要留痕，否则页面上只显示「超时」会误导
      if (!isTimeout(err)) {
        this.logger.warn({ pattern, ...errFields(err) }, '正则执行抛错，记为未命中')
      }
      return 'timeout'
    }
  }

  private compile(pattern: string): RegExp | null {
    const cached = this.cache.get(pattern)
    if (cached !== undefined) return cached
    const re = compileRegex(pattern)
    this.cache.set(pattern, re)
    return re
  }
}

const isTimeout = (err: unknown): boolean =>
  err instanceof Error && (err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
