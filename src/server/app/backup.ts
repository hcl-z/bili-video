import type { AppConfig } from '#shared/contract/config.ts'
import type { FilterRule, Subscription } from '#shared/contract/subscription.ts'
import type { Summary } from '#shared/contract/summary.ts'
import type { Update } from '#shared/contract/update.ts'
import type { Clock } from '../types/platform.ts'
import type { ConfigStore } from '../types/persistence.ts'
import type { FilterRuleRepo, SubscriptionRepo, SummaryRepo, UpdateRepo } from '../types/persistence.ts'

/** 单文件备份的上限。超出的部分不导 —— counts 会露出这件事，不会静默截断 */
const MAX_UPDATES = 20_000
const MAX_SUMMARIES = 5_000

/** 备份里**没有** master key，也没有任何用它加密过的数据（cookie、apiKey、refresh_token）： 一份能被随手丢进网盘的文件不应带着 SESSDATA 走 */
export const BACKUP_NOTE = [
  '这份备份不含 master.key，也不含任何用它加密的内容：cookie、AI apiKey、refresh_token 都不在里面。',
  'master.key 丢了，库里所有加密值一次性不可恢复 —— 只能重新扫码登录、重填 apiKey。请单独备份它。',
]

export interface BackupFile {
  kind: 'bili-video-backup'
  version: 1
  exportedAt: number
  appVersion: string
  note: string[]

  counts: { updates: number; summaries: number }
  config: AppConfig
  subscriptions: Subscription[]
  rules: FilterRule[]
  updates: Update[]
  /** transcript 一起带上：少了它，恢复之后每条都得重跑一次转写 */
  summaries: (Summary & { transcript: string | null })[]
}

export interface BackupDeps {
  config: ConfigStore
  subs: SubscriptionRepo
  rules: FilterRuleRepo
  updates: UpdateRepo
  summaries: SummaryRepo
  clock: Clock
  version: string
}

export class BackupService {
  private readonly deps: BackupDeps

  constructor(deps: BackupDeps) {
    this.deps = deps
  }

  build(): BackupFile {
    const summaries = this.deps.summaries.list({ limit: MAX_SUMMARIES })
    return {
      kind: 'bili-video-backup',
      version: 1,
      exportedAt: this.deps.clock.now(),
      appVersion: this.deps.version,
      note: BACKUP_NOTE,
      counts: {
        updates: this.deps.updates.count(),
        summaries: this.deps.summaries.count(),
      },
      config: this.deps.config.get(),
      subscriptions: this.deps.subs.list(),
      rules: this.deps.rules.list(),
      // 被过滤的也导：「应项为什么没推给我」的答案就在那两个字段里
      updates: this.deps.updates.list({ limit: MAX_UPDATES, includeFiltered: true }),
      summaries: summaries.map((s) => ({
        ...s,
        transcript: this.deps.summaries.transcript(s.bvid),
      })),
    }
  }


  fileName(): string {
    const d = new Date(this.deps.clock.now())
    const pad = (n: number) => String(n).padStart(2, '0')
    return `bili-video-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`
  }
}
