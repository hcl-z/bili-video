import { existsSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml } from 'yaml'

import { AppConfigSchema, CONFIG_SECTION_NAMES } from '#shared/contract/config.ts'
import type { Logger } from '../ports/logger.ts'

/**
 * `config.example.yaml` 只是**首次启动的种子**。一旦 app_config 有内容，YAML 就再也不看了 ——
 * 页面上要写明这件事，否则三个月后改了 YAML 会以为「没生效」是 bug。
 *
 * @returns seed 来源文件路径；null 表示这次启动没有 seed（库里已有配置，或没给种子文件）。
 */
export function seedConfigIfEmpty(
  db: DatabaseSync,
  seedFile: string | null,
  now: number,
  logger: Logger,
): string | null {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM app_config').get()
  if (Number((existing as Record<string, unknown>)['n']) > 0) return null

  const raw = seedFile !== null && existsSync(seedFile) ? readSeed(seedFile, logger) : {}
  const config = AppConfigSchema.parse(raw)

  const stmt = db.prepare('INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)')
  db.exec('BEGIN')
  try {
    for (const section of CONFIG_SECTION_NAMES) {
      stmt.run(section, JSON.stringify(config[section]), now)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  const from = seedFile !== null && existsSync(seedFile) ? seedFile : null
  logger.info({ from, sections: CONFIG_SECTION_NAMES.length }, '首次启动：配置已 seed 进数据库')
  return from
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
    logger.warn({ file, unknown }, '种子文件里有无法识别的顶层字段，已忽略')
  }
  return parsed
}
