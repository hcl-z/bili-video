import { existsSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml } from 'yaml'

import { AppConfigSchema, CONFIG_SECTION_NAMES } from '#shared/contract/config.ts'
import type { Logger } from '../ports/logger.ts'

/**
 * `config.example.yaml` 只是**首次启动的种子**。一旦某个 section 落了库，YAML 对它就再也不看了 ——
 * 页面上要写明这件事，否则三个月后改了 YAML 会以为「没生效」是 bug。
 *
 * 判断按 section 逐个来，不是「表里有东西就整段跳过」：schema 后加的 section 在老库里
 * 没有对应行，整段跳过的话它永远等不到种子，而 store 会用默认值把它补齐 ——
 * 于是「混淆表明明填了却报未配置」这种事只能靠读代码才查得出来。
 */
export interface SeedOutcome {
  /** 全新库的种子来源；null = 这次启动不是首次 seed。页面上那句「YAML 不再生效」看它。 */
  from: string | null
  /** 这次补上的 section。老库升级时才非空。 */
  filled: string[]
}

export function seedConfig(
  db: DatabaseSync,
  seedFile: string | null,
  now: number,
  logger: Logger,
): SeedOutcome {
  const log = logger.child({ mod: 'config' })
  const present = new Set(
    db
      .prepare('SELECT key FROM app_config')
      .all()
      .map((r) => String((r as Record<string, unknown>)['key'])),
  )
  const missing = CONFIG_SECTION_NAMES.filter((s) => !present.has(s))
  if (missing.length === 0) return { from: null, filled: [] }

  const usable = seedFile !== null && existsSync(seedFile) ? seedFile : null
  const raw = usable === null ? {} : readSeed(usable, log)
  const config = AppConfigSchema.parse(raw)

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
    log.info({ from: usable, sections: missing.length }, '配置已从种子文件导入')
  } else {
    log.info({ from: usable, filled: missing }, '缺失配置段已按种子补齐')
  }
  return { from: first ? usable : null, filled: missing }
}

function readSeed(file: string, logger: Logger): unknown {
  const parsed: unknown = parseYaml(readFileSync(file, 'utf8'))
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} 的顶层必须是一个映射，实际是 ${typeof parsed}`)
  }
  // 打错的 section 名会被 zod 静默丢掉，所以在这里显式提醒一次。
  const unknown = Object.keys(parsed).filter(
    (k) => !(CONFIG_SECTION_NAMES as string[]).includes(k),
  )
  if (unknown.length > 0) {
    logger.warn({ file, unknown }, '种子文件含未知顶层字段，已忽略')
  }
  return parsed
}
