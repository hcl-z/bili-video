import type { DatabaseSync } from 'node:sqlite'

import { AppConfigSchema, CONFIG_SECTION_NAMES, type AppConfig } from '#shared/contract/config.ts'
import type { Logger } from '../ports/logger.ts'

/** 首次启动和缺失 section 使用内置默认值；配置落库后始终以数据库为准。 */
export const INITIAL_CONFIG: AppConfig = AppConfigSchema.parse({
  server: { host: '127.0.0.1', port: 8788 },
  poll: { enabled: true, cron: '30 */2 * * * *' },
  bili: {
    refreshThresholdDays: 15,
    wbiMixinTable: [
      46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
      42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
      60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    ],
    ticket: { keyId: 'ec02', hmacKey: 'XgwSnGZ1p' },
    correspondPublicKeyPem: '',
    write: { autoFollow: true, minIntervalMs: 3_000, maxPerHour: 20 },
  },
  filter: { quietHours: { enabled: false, start: '23:30', end: '07:30' }, regexTimeoutMs: 100 },
  ai: {
    enabled: true,
    baseURL: '',
    model: '',
    temperature: 0.3,
    chunk: { thresholdTokens: 12_000, sizeTokens: 8_000, overlapTokens: 400 },
    llmConcurrency: 2,
    timeoutMs: 600_000,
  },
  asr: {
    provider: 'mlx-whisper',
    baseURL: '',
    model: 'mlx-community/whisper-large-v3-turbo',
    language: 'zh',
    concurrency: 1,
    segmentSec: 120,
  },
  output: { markdownDir: 'summaries' },
  notify: {
    wxpusher: { enabled: false, uids: [] },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
    feishu: { enabled: false, appId: '', receiveIdType: 'open_id', receiveId: '' },
    webhook: { enabled: false, url: '' },
  },
  catchup: { windowHours: 24, overflowThreshold: 20 },
  health: { enabled: true, cron: '0 */30 * * * *' },
  log: { level: 'info', retentionDays: 7 },
})

export interface SeedOutcome {
  from: string | null
  filled: string[]
}

export function seedConfig(db: DatabaseSync, now: number, logger: Logger): SeedOutcome {
  const log = logger.child({ mod: 'config' })
  const present = new Set(
    db
      .prepare('SELECT key FROM app_config')
      .all()
      .map((r) => String((r as Record<string, unknown>)['key'])),
  )
  const missing = CONFIG_SECTION_NAMES.filter((s) => !present.has(s))
  if (missing.length === 0) return { from: null, filled: [] }

  const config = INITIAL_CONFIG

  const stmt = db.prepare('INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)')
  db.exec('BEGIN')
  try {
    for (const section of missing) {
      stmt.run(section, JSON.stringify(config[section]), now)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  const first = present.size === 0
  if (first) {
    log.info({ sections: missing.length }, '配置已从内置默认值导入')
  } else {
    log.info({ filled: missing }, '缺失配置段已按内置默认值补齐')
  }
  return { from: first ? 'built-in' : null, filled: missing }
}
