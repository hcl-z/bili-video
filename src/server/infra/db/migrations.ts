import type { DatabaseSync } from 'node:sqlite'

/** 迁移用 TS 常量而不是 .sql 文件：没有文件 IO、没有打包时要额外 COPY 的资源， 同一份代码在 tsx / 剥类型 / tsc 三种跑法下都一样。 规则：已发布的迁移永不修改，只追加。version 单调递增 */
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

/** 派生运行态。不是用户配置（那在 app_config，页面上能改），而是系统自己攒出来、 重启要接着用的数据：浏览器身份就是第一个 —— 换一个 UA 等于在同一个 cookie 会话里 换了台电脑，那正是风控在找的信号 */
const RUNTIME_STATE = `
CREATE TABLE runtime_state (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/** 写接口调用审计。全系统只有「自动关注」一个写操作，它的风控比读严得多， 所以它每一次调用都留痕：既是事后核对「到底发了几个写请求」的依据， 也是限流本身的状态 —— 频次从这张表数出来，于是重启不会把额度清零 */
const BILI_WRITE_CALLS = `
CREATE TABLE bili_write_calls (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  api     TEXT NOT NULL,
  target  TEXT,
  ok      INTEGER NOT NULL,
  kind    TEXT,
  code    INTEGER,
  message TEXT
);
CREATE INDEX idx_bili_write_calls_at ON bili_write_calls(at DESC);
`


const SUMMARY_DETAIL = `
ALTER TABLE summaries ADD COLUMN overview TEXT NOT NULL DEFAULT '';
ALTER TABLE summaries ADD COLUMN key_info_json TEXT NOT NULL DEFAULT '{}';
`

/** 流水线：每一步的状态 + 每一步的产物。 产物是「从任意一步重跑」的全部前提 —— 没有它，从 reduce 重跑还得重新取一次字幕。 按 bvid 存而不是 job_id：一个 bvid 单条任务，重跑复位的是同一行 */
const JOB_PIPELINE = `
CREATE TABLE job_steps (
  job_id INTEGER NOT NULL,
  step   TEXT NOT NULL,
  status TEXT NOT NULL,
  note   TEXT,
  at     INTEGER NOT NULL,
  PRIMARY KEY (job_id, step)
);

CREATE TABLE job_artifacts (
  bvid      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  meta_json TEXT,
  at        INTEGER NOT NULL,
  PRIMARY KEY (bvid, kind)
);

ALTER TABLE summary_jobs ADD COLUMN resume_from TEXT;
`

// 模型回的正文本身。旧记录是空的，读的时候退回 full_md
const SUMMARY_ARTICLE = `
ALTER TABLE summaries ADD COLUMN article TEXT NOT NULL DEFAULT '';
`

const MANUAL_UPDATE_ORIGIN = `
ALTER TABLE updates ADD COLUMN in_feed INTEGER NOT NULL DEFAULT 1;
`

const SUBSCRIPTION_CUSTOMIZATION = `
ALTER TABLE subscriptions ADD COLUMN filter_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE subscriptions ADD COLUMN prompt_template TEXT;

-- 旧逻辑中，有 UP 规则就代表替换全局规则；显式迁移后行为保持不变。
UPDATE subscriptions
SET filter_mode = 'custom'
WHERE uid IN (SELECT DISTINCT scope FROM filter_rules WHERE scope <> 'global');
`

const SUBSCRIPTION_PUSH_KINDS = `
ALTER TABLE subscriptions ADD COLUMN push_kind_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE subscriptions ADD COLUMN push_kinds_json TEXT;

-- 旧的动态/视频开关折算成独立类别配置，避免升级后重新打开已关闭的内容。
UPDATE subscriptions
SET push_kind_mode = 'custom',
    push_kinds_json = json_object(
      'video', enable_video = 1,
      'draw', enable_dynamic = 1,
      'word', enable_dynamic = 1,
      'forward', enable_dynamic = 1,
      'article', enable_dynamic = 1,
      'live', 0,
      'lottery', enable_dynamic = 1,
      'charge', enable_dynamic = 1
    )
WHERE enable_dynamic = 0 OR enable_video = 0;
`

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: INIT },
  { version: 2, name: 'runtime_state', sql: RUNTIME_STATE },
  { version: 3, name: 'bili_write_calls', sql: BILI_WRITE_CALLS },
  { version: 4, name: 'summary_detail', sql: SUMMARY_DETAIL },
  { version: 5, name: 'job_pipeline', sql: JOB_PIPELINE },
  { version: 6, name: 'summary_article', sql: SUMMARY_ARTICLE },
  { version: 7, name: 'manual_update_origin', sql: MANUAL_UPDATE_ORIGIN },
  { version: 8, name: 'subscription_customization', sql: SUBSCRIPTION_CUSTOMIZATION },
  { version: 9, name: 'subscription_push_kinds', sql: SUBSCRIPTION_PUSH_KINDS },
]

/** 幂等：已应用的版本跳过。每个版本一个事务，中途失败不会留半张表。 `list` 只为测试预留（往里塞一个会失败的迁移，验证回滚）；生产永远走默认的 MIGRATIONS */
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
