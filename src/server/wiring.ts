import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { ASR_API_KEY, LLM_API_KEY } from './app/ai.ts'
import { seedConfig } from './config/load.ts'
import { SqliteConfigStore } from './config/store.ts'
import {
  createBrowserIdentity,
  parseIdentity,
  serializeIdentity,
  type BrowserIdentity,
} from './infra/bili/browser-identity.ts'
import { makeAsrProbe } from './infra/ai/asr-probe.ts'
import { makeAsr } from './infra/asr/switch.ts'
import { YtDlpDownloader } from './infra/audio/yt-dlp.ts'
import { OpenAiCompatLlm } from './infra/ai/openai-compat.ts'
import { SqliteCookieJar, type Cipher } from './infra/bili/cookie-jar.ts'
import { BiliHttp } from './infra/bili/http-client.ts'
import { BiliAuthClient } from './infra/bili/login.ts'
import { BiliProfileClient } from './infra/bili/profile.ts'
import { BiliReaderClient } from './infra/bili/reader.ts'
import { BiliRelationsClient } from './infra/bili/relations.ts'
import { BiliSubtitleClient } from './infra/bili/subtitle.ts'
import { ExecCommandRunner } from './infra/command/exec.ts'
import { FsStorageStats } from './infra/fs/disk-usage.ts'
import { FsMarkdownWriter } from './infra/fs/markdown-writer.ts'
import { migrate } from './infra/db/migrations.ts'
import { SqliteStateRepo } from './infra/db/repo-state.ts'
import { SqliteDeliveryRepo, SqliteLlmCallRepo } from './infra/db/repo-delivery.ts'
import { SqliteAnchorRepo, SqliteUpdateRepo } from './infra/db/repo-feed.ts'
import {
  SqliteJobArtifactRepo,
  SqliteJobRepo,
  SqliteSummaryRepo,
} from './infra/db/repo-summary.ts'
import { SqliteFilterRuleRepo, SqliteSubscriptionRepo } from './infra/db/repo-subscriptions.ts'
import { SqliteWriteAuditRepo } from './infra/db/repo-write-audit.ts'
import { makePushNotifiers } from './infra/notify/push-all-in-one.ts'
import { openDatabase } from './infra/db/sqlite.ts'
import { loadMasterKey } from './infra/secret/key-manager.ts'
import { open, parseBox, seal } from './infra/secret/secret-box.ts'
import { SqliteSecretStore } from './infra/secret/store.ts'
import type { ProbeResult } from '#shared/contract/probe.ts'
import type { Asr } from './ports/asr.ts'
import type { AudioDownloader } from './ports/audio.ts'
import type {
  BiliAuth,
  BiliProfile,
  BiliReader,
  BiliRelationWriter,
  SubtitleFetcher,
} from './ports/bili.ts'
import type { MarkdownWriter } from './ports/markdown.ts'
import type { StorageStats } from './ports/storage.ts'
import type { Clock } from './ports/clock.ts'
import type { CommandRunner } from './ports/command.ts'
import type { Llm } from './ports/llm.ts'
import type { ConfigStore } from './ports/config-store.ts'
import type { CookieJar } from './ports/cookie-jar.ts'
import type { EventBus } from './ports/event-bus.ts'
import type { Logger } from './ports/logger.ts'
import type { StateRepo } from './ports/state.ts'
import type { Repos } from './ports/index.ts'
import {
  FEISHU_APP_SECRET,
  NTFY_AUTH,
  WEBHOOK_AUTHORIZATION,
  WXPUSHER_APP_TOKEN,
} from './app/notify.ts'

/**
 * 真实持久化内核：SQLite、迁移、8 个仓储、secret-box 和配置。
 * 测试也使用真实临时库与加密，仅替换进程边界外的依赖。
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
  /** 本地可执行文件探测。fetch 之外的第二个进程边界，测试同样要能换掉。 */
  commands?: CommandRunner
}

export interface Core {
  db: DatabaseSync
  repos: Repos
  secrets: SqliteSecretStore
  config: ConfigStore
  cookies: CookieJar
  state: StateRepo
  identity: BrowserIdentity
  biliAuth: BiliAuth
  biliReader: BiliReader
  biliRelations: BiliRelationWriter
  biliProfile: BiliProfile
  subtitles: SubtitleFetcher
  audio: AudioDownloader
  asr: Asr
  markdown: MarkdownWriter
  storage: StorageStats
  llm: Llm
  probeAsr: () => Promise<ProbeResult>
  notifiers: ReturnType<typeof makePushNotifiers>
  close(): void
}

export function openCore(opts: CoreOptions): Core {
  const { dataDir, clock } = opts
  // 组装根这几行也打 tag：日志页上每一行都该能说清是哪个模块写的。
  const logger = opts.logger.child({ mod: 'core' })
  const now = () => clock.now()

  const dbFile = opts.dbFile ?? join(dataDir, 'app.db')
  const db = openDatabase(dbFile)
  const applied = migrate(db, clock.now())
  if (applied.length > 0) logger.info({ versions: applied }, '数据库迁移已应用')

  const master = loadMasterKey({
    path: opts.masterKeyPath ?? join(dataDir, 'master.key'),
    passphrase: opts.masterKeyPassphrase,
  })
  const secrets = new SqliteSecretStore(db, master.key, now)

  // 新 key 配现有密文表示原 key 丢失；立即停止并说明恢复方式，避免首次解密时才失败。
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
      '已生成新的 master key，它加密了所有 cookie 与 apiKey，丢失后不可恢复，请纳入备份',
    )
  }

  const seeded = seedConfig(db, opts.seedFile ?? null, clock.now(), logger)
  const config = new SqliteConfigStore(db, now, seeded.from)

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
    artifacts: new SqliteJobArtifactRepo(db),
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
  const subtitles = new BiliSubtitleClient(http, logger)
  const markdown = new FsMarkdownWriter({
    dataDir,
    dir: () => config.getSection('output').markdownDir,
  })
  const storage = new FsStorageStats({
    dataDir,
    dbFile,
    audioDir: join(dataDir, 'audio'),
    markdownDir: () => config.getSection('output').markdownDir,
  })

  const netFetch = opts.fetch ?? globalThis.fetch
  const llm = new OpenAiCompatLlm({
    fetch: netFetch,
    clock,
    logger,
    // 用时读：页面上改完 baseURL / model / apiKey，下一次调用就按新的来。
    config: () => config.getSection('ai'),
    apiKey: () => secrets.get(LLM_API_KEY),
  })
  const commands = opts.commands ?? new ExecCommandRunner()
  const audio = new YtDlpDownloader({
    commands,
    cookies,
    clock,
    logger,
    dir: join(dataDir, 'audio'),
    identity,
  })
  const asr = makeAsr({
    fetch: netFetch,
    commands,
    logger,
    config: () => config.getSection('asr'),
    apiKey: () => secrets.get(ASR_API_KEY),
  })
  const probeAsr = makeAsrProbe({
    fetch: netFetch,
    clock,
    config: () => config.getSection('asr'),
    apiKey: () => secrets.get(ASR_API_KEY),
    commands,
  })
  const notifiers = makePushNotifiers({
    config: () => config.getSection('notify'),
    wxpusherToken: () => secrets.get(WXPUSHER_APP_TOKEN),
    ntfyAuth: () => secrets.get(NTFY_AUTH),
    feishuSecret: () => secrets.get(FEISHU_APP_SECRET),
    webhookAuthorization: () => secrets.get(WEBHOOK_AUTHORIZATION),
    fetch: netFetch,
    logger,
  })

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
    subtitles,
    audio,
    asr,
    markdown,
    storage,
    llm,
    probeAsr,
    notifiers,
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
    logger.warn({}, '浏览器身份解析失败，已重新生成')
  }
  const fresh = createBrowserIdentity()
  state.set('browser-identity', serializeIdentity(fresh))
  logger.info({ ua: fresh.userAgent }, '浏览器身份已生成')
  return fresh
}
