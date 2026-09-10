import type { DatabaseSync } from 'node:sqlite'

import {
  AppConfigSchema,
  CONFIG_SECTION_NAMES,
  CONFIG_SECTIONS,
  type AppConfig,
  type ConfigSection,
} from '#shared/contract/config.ts'
import type { Cancel } from '../types/platform.ts'
import type { ConfigStore } from '../types/persistence.ts'
import type { Logger } from '../types/platform.ts'

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
    provider: 'mlx-audio',
    baseURL: '',
    model: 'mlx-community/Qwen3-ASR-0.6B-4bit',
    language: 'Chinese',
    useOfficialSubtitles: true,
    concurrency: 1,
    segmentSec: 120,
  },
  output: { markdownDir: 'summaries' },
  notify: {
    wxpusher: { enabled: false, uids: [] },
    pushplus: { enabled: false, channel: 'wechat', topic: '' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
    feishu: { enabled: false, appId: '', receiveIdType: 'open_id', receiveId: '' },
    webhook: { enabled: false, url: '' },
  },
  catchup: { windowHours: 24, overflowThreshold: 20 },
  health: { enabled: true, cron: '0 */30 * * * *' },
  log: { level: 'info', retentionDays: 7 },
})

export function seedConfig(db: DatabaseSync, now: number, logger: Logger): void {
  const present = new Set(
    db
      .prepare('SELECT key FROM app_config')
      .all()
      .map((row) => String((row as Record<string, unknown>)['key'])),
  )
  const missing = CONFIG_SECTION_NAMES.filter((section) => !present.has(section))
  if (missing.length === 0) return

  const insert = db.prepare('INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)')
  db.exec('BEGIN')
  try {
    for (const section of missing) insert.run(section, JSON.stringify(INITIAL_CONFIG[section]), now)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  const log = logger.child({ mod: 'config' })
  if (present.size === 0) log.info({ sections: missing.length }, '配置已从内置默认值导入')
  else log.info({ filled: missing }, '缺失配置段已按内置默认值补齐')
}

/** 数据库是配置唯一真相；写入后重新解析并通知订阅者。消费方须按需调用 get()，不能在启动时缓存配置 */
export class SqliteConfigStore implements ConfigStore {
  #config: AppConfig
  readonly #handlers = new Set<(section: ConfigSection, config: AppConfig) => void>()

  private readonly db: DatabaseSync
  private readonly now: () => number
  constructor(db: DatabaseSync, now: () => number) {
    this.db = db
    this.now = now
    this.#config = this.#read()
  }

  get(): AppConfig {
    return this.#config
  }

  getSection<K extends ConfigSection>(section: K): AppConfig[K] {
    return this.#config[section]
  }

  setSection<K extends ConfigSection>(section: K, value: AppConfig[K]): void {

    const parsed = CONFIG_SECTIONS[section].parse(value) as AppConfig[K]
    this.db
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(section, JSON.stringify(parsed), this.now())
    this.#config = this.#read()
    for (const h of this.#handlers) h(section, this.#config)
  }

  onChange(handler: (section: ConfigSection, config: AppConfig) => void): Cancel {
    this.#handlers.add(handler)
    return () => this.#handlers.delete(handler)
  }

  #read(): AppConfig {
    const rows = this.db.prepare('SELECT key, value_json FROM app_config').all()
    const raw: Record<string, unknown> = {}
    for (const row of rows) {
      const r = row as Record<string, unknown>
      raw[String(r['key'])] = JSON.parse(String(r['value_json']))
    }
    // 缺的 section 由 schema 的默认值补齐：新增配置项不需要写迁移
    return AppConfigSchema.parse(raw)
  }
}
