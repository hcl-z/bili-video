import type { DatabaseSync } from 'node:sqlite'

/**
 * 迁移用 TS 常量而不是 .sql 文件：没有文件 IO、没有打包时要额外 COPY 的资源，
 * 同一份代码在 tsx / 剥类型 / tsc 三种跑法下都一样。
 *
 * 规则：已发布的迁移永不修改，只追加。version 单调递增。
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

const INIT = `
CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 加密落库（AES-256-GCM + scrypt）。blob_json 是 {v,salt,iv,tag,data}，全部 base64。
CREATE TABLE secrets (
  key        TEXT PRIMARY KEY,
  blob_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cookies (
  name       TEXT PRIMARY KEY,
  blob_json  TEXT NOT NULL,
  expires    INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE subscriptions (
  uid            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  face           TEXT,
  enable_dynamic INTEGER NOT NULL DEFAULT 1,
  enable_video   INTEGER NOT NULL DEFAULT 1,
  enable_ai      INTEGER NOT NULL DEFAULT 1,
  followed_at    INTEGER,
  created_at     INTEGER NOT NULL
);

-- scope = 'global' 或某个 uid，实现「全局默认 + per-UP 覆盖」。
CREATE TABLE filter_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_filter_rules_scope ON filter_rules(scope);

-- 锚点覆盖每一个订阅，哪怕推送开关关着也照常推进；参考实现只有内存 Map，重启即丢。
CREATE TABLE anchors (
  uid         TEXT PRIMARY KEY,
  last_pub_ts INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 被过滤的条目照样入库并记下命中的规则 —— 「为什么这条没推给我」要有地方回答。
CREATE TABLE updates (
  dyn_id        TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,
  type          TEXT NOT NULL,
  pub_ts        INTEGER NOT NULL,
  title         TEXT,
  text          TEXT,
  cover         TEXT,
  bvid          TEXT,
  url           TEXT NOT NULL,
  raw_json      TEXT,
  filtered      INTEGER NOT NULL DEFAULT 0,
  filter_reason TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_updates_uid_pub ON updates(uid, pub_ts DESC);
CREATE INDEX idx_updates_pub ON updates(pub_ts DESC);
CREATE INDEX idx_updates_bvid ON updates(bvid);

-- 一个 bvid 一条任务：重跑是复位这一行，不是插一条新的。
CREATE TABLE summary_jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bvid       TEXT NOT NULL UNIQUE,
  update_id  TEXT NOT NULL,
  status     TEXT NOT NULL,
  stage      TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_summary_jobs_status ON summary_jobs(status, id);

CREATE TABLE summaries (
  bvid              TEXT PRIMARY KEY,
  tldr              TEXT NOT NULL,
  points_json       TEXT NOT NULL,
  chapters_json     TEXT NOT NULL,
  full_md           TEXT NOT NULL,
  transcript        TEXT,
  transcript_source TEXT NOT NULL,
  confidence        TEXT NOT NULL,
  degrade_path      TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_summaries_created ON summaries(created_at DESC);

-- 分段总结一次视频会调多次，逐次记才算得准。只记账，不拦截。
CREATE TABLE llm_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bvid       TEXT,
  stage      TEXT NOT NULL,
  model      TEXT NOT NULL,
  in_tokens  INTEGER NOT NULL,
  out_tokens INTEGER NOT NULL,
  ms         INTEGER NOT NULL,
  at         INTEGER NOT NULL
);
CREATE INDEX idx_llm_calls_at ON llm_calls(at DESC);

-- 唯一索引就是去重机制本身：重试逻辑撞上它会被库挡掉，不会给我发第二条。
CREATE TABLE deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id  TEXT NOT NULL,
  channel    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  err        TEXT,
  at         INTEGER NOT NULL,
  UNIQUE (update_id, channel, kind)
);
CREATE INDEX idx_deliveries_at ON deliveries(at DESC);
`

export const MIGRATIONS: Migration[] = [{ version: 1, name: 'init', sql: INIT }]

/**
 * 幂等：已应用的版本跳过。每个版本一个事务，中途失败不会留半张表。
 *
 * `list` 只为测试预留（往里塞一个会炸的迁移，验证回滚）；生产永远走默认的 MIGRATIONS。
 */
export function migrate(db: DatabaseSync, now: number, list: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  const applied = new Set(
    db.prepare('SELECT version FROM migrations').all().map((r) => Number(r['version'])),
  )
  const done: number[] = []

  for (const m of list) {
    if (applied.has(m.version)) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        now,
      )
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    done.push(m.version)
  }
  return done
}
