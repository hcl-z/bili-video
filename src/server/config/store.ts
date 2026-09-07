import type { DatabaseSync } from 'node:sqlite'

import {
  AppConfigSchema,
  CONFIG_SECTIONS,
  type AppConfig,
  type ConfigSection,
} from '#shared/contract/config.ts'
import type { Cancel } from '../ports/clock.ts'
import type { ConfigStore } from '../ports/config-store.ts'

/**
 * 数据库是配置的唯一真相。写入即热生效：内存里的那份重新解析、订阅者收到通知，
 * 不需要重启 —— 前提是消费方在**用的时候**调 get()，而不是在启动时抓一份存起来。
 */
export class SqliteConfigStore implements ConfigStore {
  #config: AppConfig
  readonly #handlers = new Set<(section: ConfigSection, config: AppConfig) => void>()

  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly seedSource: string | null

  constructor(db: DatabaseSync, now: () => number, seedSource: string | null) {
    this.db = db
    this.now = now
    this.seedSource = seedSource
    this.#config = this.#read()
  }

  get(): AppConfig {
    return this.#config
  }

  getSection<K extends ConfigSection>(section: K): AppConfig[K] {
    return this.#config[section]
  }

  setSection<K extends ConfigSection>(section: K, value: AppConfig[K]): void {
    // 单段单独校验：改 poll 时不会被别处的历史脏数据挡住。
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

  seededFrom(): string | null {
    return this.seedSource
  }

  #read(): AppConfig {
    const rows = this.db.prepare('SELECT key, value_json FROM app_config').all()
    const raw: Record<string, unknown> = {}
    for (const row of rows) {
      const r = row as Record<string, unknown>
      raw[String(r['key'])] = JSON.parse(String(r['value_json']))
    }
    // 缺的 section 由 schema 的默认值补齐：新增配置项不需要写迁移。
    return AppConfigSchema.parse(raw)
  }
}
