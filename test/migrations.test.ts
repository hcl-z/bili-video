import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { MIGRATIONS, migrate } from '../src/server/infra/db/migrations.ts'
import { openDatabase } from '../src/server/infra/db/sqlite.ts'

/** 表清单写死在测试里：漏建一张表要在这儿失败，而不是等到某个 ticket 的 SQL 报 no such table。 */
const EXPECTED_TABLES = [
  'anchors',
  'app_config',
  'bili_write_calls',
  'cookies',
  'deliveries',
  'filter_rules',
  'job_artifacts',
  'job_steps',
  'llm_calls',
  'migrations',
  'runtime_state',
  'secrets',
  'subscriptions',
  'summaries',
  'summary_jobs',
  'updates',
]

const dirs: string[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'bili-video-mig-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'app.db'))
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tableNames(db: ReturnType<typeof freshDb>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => String(r['name']))
    .sort()
}

describe('migrations', () => {
  it('从空库建出全部表', () => {
    const db = freshDb()
    const applied = migrate(db, 1_000)

    assert.deepEqual(applied, MIGRATIONS.map((m) => m.version))
    assert.deepEqual(tableNames(db), EXPECTED_TABLES)
    db.close()
  })

  it('重复启动幂等：第二次一个迁移都不跑', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bili-video-mig-'))
    dirs.push(dir)
    const file = join(dir, 'app.db')

    const first = openDatabase(file)
    assert.equal(migrate(first, 1_000).length, MIGRATIONS.length)
    first.close()

    const second = openDatabase(file)
    assert.deepEqual(migrate(second, 2_000), [], '已应用过的迁移不该重跑')
    assert.deepEqual(tableNames(second), EXPECTED_TABLES)
    // 同一个连接上再调一次也不该有副作用。
    assert.deepEqual(migrate(second, 3_000), [])
    second.close()
  })

  it('迁移失败时整票回滚，不留半张表', () => {
    const db = freshDb()
    migrate(db, 1_000)
    const before = tableNames(db)

    assert.throws(() =>
      migrate(db, 2_000, [
        { version: 999, name: 'broken', sql: 'CREATE TABLE half_baked (id INTEGER); SELECT nope();' },
      ]),
    )
    assert.deepEqual(tableNames(db), before, 'half_baked 不该留下来')
    db.close()
  })

  it('version 单调递增且不重复', () => {
    const versions = MIGRATIONS.map((m) => m.version)
    assert.deepEqual(versions, [...new Set(versions)].sort((a, b) => a - b))
  })
})
