import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { seedConfigIfEmpty } from './config/load.ts'
import { SqliteConfigStore } from './config/store.ts'
import {
  createBrowserIdentity,
  parseIdentity,
  serializeIdentity,
  type BrowserIdentity,
} from './infra/bili/browser-identity.ts'
import { SqliteCookieJar, type Cipher } from './infra/bili/cookie-jar.ts'
import { BiliHttp } from './infra/bili/http-client.ts'
import { BiliAuthClient } from './infra/bili/login.ts'
import { BiliProfileClient } from './infra/bili/profile.ts'
import { BiliReaderClient } from './infra/bili/reader.ts'
import { BiliRelationsClient } from './infra/bili/relations.ts'
import { migrate } from './infra/db/migrations.ts'
import { SqliteStateRepo } from './infra/db/repo-state.ts'
import { SqliteDeliveryRepo, SqliteLlmCallRepo } from './infra/db/repo-delivery.ts'
import { SqliteAnchorRepo, SqliteUpdateRepo } from './infra/db/repo-feed.ts'
import { SqliteJobRepo, SqliteSummaryRepo } from './infra/db/repo-summary.ts'
import { SqliteFilterRuleRepo, SqliteSubscriptionRepo } from './infra/db/repo-subscriptions.ts'
import { SqliteWriteAuditRepo } from './infra/db/repo-write-audit.ts'
import { openDatabase } from './infra/db/sqlite.ts'
import { loadMasterKey } from './infra/secret/key-manager.ts'
import { open, parseBox, seal } from './infra/secret/secret-box.ts'
import { SqliteSecretStore } from './infra/secret/store.ts'
import type { BiliAuth, BiliProfile, BiliReader, BiliRelationWriter } from './ports/bili.ts'
import type { Clock } from './ports/clock.ts'
import type { ConfigStore } from './ports/config-store.ts'
import type { CookieJar } from './ports/cookie-jar.ts'
import type { EventBus } from './ports/event-bus.ts'
import type { Logger } from './ports/logger.ts'
import type { StateRepo } from './ports/state.ts'
import type { Repos } from './ports/index.ts'

/**
 * 真实的持久化内核：SQLite + migrations + 8 个仓储 + secret-box + 配置。
 *
 * 它在测试里也是**真的**（临时目录里的真库、真加密），只有进程边界外的东西才换假件。
 * 拆出这个函数是为了让 main.ts 和测试用同一段装配代码 —— 否则测的就不是生产那套接线了。
 */
export interface CoreOptions {
  dataDir: string
  clock: Clock
  logger: Logger
  events: EventBus
  /** 首次启动的种子 YAML；null 表示不 seed（全用 schema 默认值）。 */
  seedFile?: string | null
  dbFile?: string
  masterKeyPath?: string
  /** 有 passphrase 就用它派生，不落 key 文件（容器里常这么干）。 */
  masterKeyPassphrase?: string | undefined
  /**
   * 出网用的 fetch。**这是唯一的进程边界假件注入点** —— 测试换掉它，
   * 于是 cookie 加解密、身份、签名、错误分类全都是真的在跑。
   */
  fetch?: typeof fetch
}

export interface Core {
  db: DatabaseSync
  repos: Repos
  secrets: SqliteSecretStore
  config: ConfigStore
  cookies: CookieJar
  state: StateRepo
  /** 本实例的浏览器身份。第一次启动时生成并存下来，之后每次启动读回同一份。 */
  identity: BrowserIdentity
  /** 扫码登录与 cookie 续期的适配器。 */
  biliAuth: BiliAuth
  /** 聚合流读取。 */
  biliReader: BiliReader
  /** 唯一的写接口：查关系 + 关注。限流与审计都在它内部。 */
  biliRelations: BiliRelationWriter
  /** UP 主名片查询。 */
  biliProfile: BiliProfile
  close(): void
}

export function openCore(opts: CoreOptions): Core {
  const { dataDir, clock, logger } = opts
  const now = () => clock.now()

  const db = openDatabase(opts.dbFile ?? join(dataDir, 'app.db'))
  const applied = migrate(db, clock.now())
  if (applied.length > 0) logger.info({ versions: applied }, '数据库迁移已应用')

  const master = loadMasterKey({
    path: opts.masterKeyPath ?? join(dataDir, 'master.key'),
    passphrase: opts.masterKeyPassphrase,
  })
  const secrets = new SqliteSecretStore(db, master.key, now)

  // 新生成的 key + 库里已有密文 = key 丢了。继续跑只会在第一次解密时炸得莫名其妙，
  // 所以在这里停下来，把「怎么恢复」说清楚。
  if (master.created && secrets.countStored() > 0) {
    db.close()
    throw new Error(
      'master key 文件不存在，但数据库里已有加密内容。刚生成的新 key 解不开它们。\n' +
        '要么从备份恢复 master.key，要么清空 secrets 与 cookies 两张表后重新登录、重填 apiKey。',
    )
  }
  if (master.created) {
    logger.warn(
      { source: master.source },
      '已生成新的 master key。它加密了所有 cookie 与 apiKey —— 丢了就全部不可恢复，请立刻纳入备份。',
    )
  }

  const seededFrom = seedConfigIfEmpty(db, opts.seedFile ?? null, clock.now(), logger)
  const config = new SqliteConfigStore(db, now, seededFrom)

  // cookie 和 SESSDATA 一样敏感（SESSDATA 本身就是其中一条），走同一套 secret-box。
  const cipher: Cipher = {
    seal: (plaintext) => JSON.stringify(seal(plaintext, master.key)),
    open: (sealed) => open(parseBox(sealed), master.key),
  }
  const cookies = new SqliteCookieJar(db, cipher, now)

  const state = new SqliteStateRepo(db, now)
  const identity = loadOrCreateIdentity(state, logger)

  const http = new BiliHttp({
    fetch: opts.fetch ?? globalThis.fetch,
    identity,
    cookies,
    clock,
    logger,
    // 用时读：混淆表和 ticket key 是人在页面上填的，改完不该重启。
    config: () => config.getSection('bili'),
  })
  const biliAuth = new BiliAuthClient({
    http,
    cookies,
    clock,
    logger,
    config: () => config.getSection('bili'),
    // refresh_token 是凭据，和 SESSDATA 同级 —— 走加密的 secrets 表，不进 runtime_state。
    tokens: {
      get: () => secrets.get('bili-refresh-token'),
      set: (token) => {
        if (token === null) secrets.delete('bili-refresh-token')
        else secrets.set('bili-refresh-token', token)
      },
    },
  })

  const repos: Repos = {
    subscriptions: new SqliteSubscriptionRepo(db, now),
    rules: new SqliteFilterRuleRepo(db, now),
    anchors: new SqliteAnchorRepo(db),
    updates: new SqliteUpdateRepo(db),
    jobs: new SqliteJobRepo(db),
    summaries: new SqliteSummaryRepo(db),
    deliveries: new SqliteDeliveryRepo(db),
    llmCalls: new SqliteLlmCallRepo(db),
    writeAudit: new SqliteWriteAuditRepo(db),
  }

  const biliRelations = new BiliRelationsClient({
    http,
    cookies,
    clock,
    logger,
    audit: repos.writeAudit,
    // 用时读：页面上改完限流参数，下一次关注就按新的来。
    limits: () => config.getSection('bili').write,
  })
  const biliProfile = new BiliProfileClient(http)
  const biliReader = new BiliReaderClient(http, logger)

  return {
    db,
    repos,
    secrets,
    config,
    cookies,
    state,
    identity,
    biliAuth,
    biliReader,
    biliRelations,
    biliProfile,
    close() {
      db.close()
    },
  }
}

/**
 * 浏览器身份：存过就读回，没存过就生成一份存下来。
 *
 * 「每实例一次并保持稳定」的实例边界是**cookie 会话**，不是进程 —— 重启换 UA
 * 等于在同一个会话里换了台电脑，那正是风控在找的信号，所以它必须落库。
 */
function loadOrCreateIdentity(state: StateRepo, logger: Logger): BrowserIdentity {
  const stored = state.get('browser-identity')
  if (stored !== null) {
    const parsed = parseIdentity(stored)
    if (parsed !== null) return parsed
    logger.warn({}, '存下来的浏览器身份读不出来，重新生成一份')
  }
  const fresh = createBrowserIdentity()
  state.set('browser-identity', serializeIdentity(fresh))
  logger.info({ ua: fresh.userAgent }, '已生成浏览器身份（之后每次启动都用这一份）')
  return fresh
}
