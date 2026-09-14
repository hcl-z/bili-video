import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import process from 'node:process'
import { ASR_API_KEY, LLM_API_KEY } from './app/ai.ts'
import { seedConfig, SqliteConfigStore } from './config/store.ts'
import {
  createBrowserIdentity,
  parseIdentity,
  serializeIdentity,
  type BrowserIdentity,
} from './infra/bili/browser-identity.ts'
import { assertAsrProviderAvailable } from './domain/asr-provider.ts'
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
import {
  ServerConfigSchema,
  type AppConfig,
} from '#shared/contract/config.ts'
import type { ProbeResult } from '#shared/contract/probe.ts'
import type { Asr } from './types/ai.ts'
import type { AudioDownloader } from './types/ai.ts'
import type {
  BiliAuth,
  BiliProfile,
  BiliReader,
  BiliRelationWriter,
  SubtitleFetcher,
} from './types/bili.ts'
import type { MarkdownWriter } from './types/delivery.ts'
import type { StorageStats } from './types/delivery.ts'
import type { Clock } from './types/platform.ts'
import type { CommandRunner } from './types/platform.ts'
import type { Llm } from './types/ai.ts'
import type { ConfigStore } from './types/persistence.ts'
import type { CookieJar } from './types/bili.ts'
import type { EventBus } from './types/platform.ts'
import type { Logger } from './types/platform.ts'
import type { RuntimeInfo } from './types/platform.ts'
import type { StateRepo } from './types/persistence.ts'
import type { Repos } from './types/index.ts'
import {
  FEISHU_APP_SECRET,
  NTFY_AUTH,
  PUSHPLUS_TOKEN,
  WEBHOOK_AUTHORIZATION,
  WXPUSHER_APP_TOKEN,
} from './app/notify.ts'
import { serve, type ServerType } from '@hono/node-server'
import type { Hono } from 'hono'
import { AiService } from './app/ai.ts'
import { AuthLifecycle } from './app/auth-lifecycle.ts'
import { BackupService } from './app/backup.ts'
import { DeliveryService } from './app/delivery.ts'
import { HealthMonitor } from './app/health.ts'
import { NotifyService } from './app/notify.ts'
import { Poller } from './app/poller.ts'
import { SummaryQueue } from './app/queue-runner.ts'
import { RuleService } from './app/rules.ts'
import { SubscriptionService } from './app/subscriptions.ts'
import { SummarizeVideo } from './app/summarize-video.ts'
import { UpFeedService } from './app/up-feed.ts'
import { createHttpApp } from './http/app.ts'
import { LogBuffer } from './http/routes/logs.ts'
import { renderQr } from './infra/bili/qr-terminal.ts'
import { InMemoryEventBus } from './infra/event-bus/in-memory.ts'
import { SystemClock } from './infra/clock/system-clock.ts'
import { detectRuntime } from './infra/runtime/detect.ts'
import { createLogger } from './log.ts'
import { errFields } from './log-fields.ts'
import { TimedRegex } from './infra/regex/timed-regex.ts'
import type { ServerDeps } from './types/index.ts'

/** 真实持久化内核：SQLite、迁移、8 个仓储、secret-box 和配置。 测试也使用真实临时库与加密，仅替换进程边界外的依赖 */
export interface CoreOptions {
  dataDir: string
  clock: Clock
  logger: Logger
  events: EventBus
  dbFile?: string
  masterKeyPath?: string

  masterKeyPassphrase?: string | undefined
  /** 出网用的 fetch。**这是唯一的进程边界测试替身注入点** —— 测试换掉它， 于是 cookie 加解密、身份、签名、错误分类全都是真的在跑 */
  fetch?: typeof fetch
  /** 本地可执行文件探测。fetch 之外的第二个进程边界，测试同样要能换掉 */
  commands?: CommandRunner
  runtime?: RuntimeInfo
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
  runtime: RuntimeInfo
  close(): void
}

export function openCore(opts: CoreOptions): Core {
  const { dataDir, clock } = opts

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

  seedConfig(db, clock.now(), logger)
  const config = new SqliteConfigStore(db, now)
  const legacyAsr = config.getSection('asr')
  if (legacyAsr.model === 'mlx-community/whisper-large-v3-turbo') {
    config.setSection('asr', {
      ...legacyAsr,
      provider: 'mlx-audio',
      model: 'mlx-community/Qwen3-ASR-0.6B-4bit',
      language: 'Chinese',
    })
    logger.info({}, '本地 ASR 已迁移到 mlx-audio Qwen3-ASR')
  }
  const runtime = opts.runtime ?? { isDocker: false }
  if (runtime.isDocker && config.getSection('asr').provider === 'mlx-audio') {
    config.setSection('asr', { ...config.getSection('asr'), provider: 'openai-compat' })
    logger.warn({}, 'Docker 内不支持本地 ASR，已切换到 openai-compat')
  }
  assertAsrProviderAvailable(runtime.isDocker, config.getSection('asr').provider)

  // cookie 和 SESSDATA 一样敏感（SESSDATA 本身就是其中单条），走同一套 secret-box
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

    config: () => config.getSection('bili'),
  })
  const biliAuth = new BiliAuthClient({
    http,
    cookies,
    clock,
    logger,
    config: () => config.getSection('bili'),
    // refresh_token 是凭据，和 SESSDATA 同级 —— 走加密的 secrets 表，不进 runtime_state
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
    // 用时读：页面上改完限流参数，下一次关注就按新的来
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
    // 用时读：页面上改完 baseURL / model / apiKey，下一次调用就按新的来
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
    pushplusToken: () => secrets.get(PUSHPLUS_TOKEN),
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
    runtime,
    close() {
      db.close()
    },
  }
}

/** 浏览器身份：存过就读回，没存过就生成一份存下来。 「每实例一次并保持稳定」的实例边界是**cookie 会话**，不是进程 —— 重启换 UA 等于在同一个会话里换了台电脑，那正是风控在找的信号，所以它必须落库 */
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

export interface RunningServer {
  server: Server
  stop(signal?: string): Promise<void>
}

/** 生产组合根：环境变量、真实适配器、业务服务与 HTTP 生命周期都在这里闭合 */
export async function openServer(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const dataDir = resolve(env['DATA_DIR'] ?? './data')
  const webRoot = resolve(env['WEB_ROOT'] ?? './dist/web')
  const clock = new SystemClock()
  const events = new InMemoryEventBus()
  const runtime = detectRuntime()
  const logger = createLogger({
    level: (env['LOG_LEVEL'] as 'info') ?? 'info',
    dir: join(dataDir, 'logs'),
    retentionDays: 7,
    json: env['LOG_JSON'] === '1',
    sink: (line) => events.emitLog(line),
  })

  let core: Core
  try {
    core = openCore({
      dataDir,
      clock,
      logger,
      events,
      runtime,
      masterKeyPath: env['MASTER_KEY_PATH'],
      masterKeyPassphrase: env['MASTER_KEY'],
    })
  } catch (err) {
    logger.child({ mod: 'boot' }).fatal(errFields(err), '启动失败')
    await logger.close()
    throw err
  }

  const deps: ServerDeps = {
    version: '0.1.0',
    clock,
    logger,
    events,
    config: core.config,
    secrets: core.secrets,
    repos: core.repos,
    state: core.state,
    cookies: core.cookies,
    markdown: core.markdown,
    storage: core.storage,
    runtime,
    external: {
      notifiers: core.notifiers,
      biliAuth: core.biliAuth,
      biliReader: core.biliReader,
      biliRelations: core.biliRelations,
      biliProfile: core.biliProfile,
      subtitles: core.subtitles,
      asr: core.asr,
      llm: core.llm,
      audio: core.audio,
      probeAsr: core.probeAsr,
    },
  }
  const server = buildServer(deps, {
    webRoot: existsSync(join(webRoot, 'index.html')) ? webRoot : null,
    listen: resolveListenConfig(core.config.getSection('server'), env),
  })
  try {
    await server.start()
  } catch (err) {
    await server.stop()
    core.close()
    throw err
  }
  void server.bootstrap()

  let stopped = false
  return {
    server,
    async stop(signal) {
      if (stopped) return
      stopped = true
      logger.child({ mod: 'boot' }).info({ signal: signal ?? 'manual' }, '进程关停中')
      clock.stopAll()
      await server.stop()
      core.close()
    },
  }
}

/** 唯一生产入口：启动后只处理进程信号 */
export async function runServer(): Promise<void> {
  let running: RunningServer
  try {
    running = await openServer()
  } catch {
    process.exitCode = 1
    return
  }

  const shutdown = async (signal: string): Promise<void> => {
    await running.stop(signal)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}


export interface Server {
  app: Hono
  /** app 层服务。启动流程和测试都要拿它做事，所以摆在外面而不是藏在闭包里 */
  services: Services
  /** 起 HTTP 监听，返回实际绑定的地址（port 配 0 时才知道真端口） */
  start(): Promise<AddressInfo>
  /** 起监听之后要做的事：核对登录态，需要时在终端出码。 刻意不在 start() 里 await —— 扫码要等人，工作台不应为此推迟到能打开。 永不 reject：启动期的问题落日志和快照，不应把进程带走 */
  bootstrap(): Promise<void>
  stop(): Promise<void>
}


export interface Services {
  auth: AuthLifecycle | null
  subs: SubscriptionService
  rules: RuleService
  poll: Poller
  ai: AiService
  notify: NotifyService
  delivery: DeliveryService
  queue: SummaryQueue
  ups: UpFeedService
  health: HealthMonitor
  backup: BackupService
}

const ORPHAN_AUDIO_MS = 24 * 3_600_000

export interface BuildOptions {
  webRoot?: string | null
  listen?: AppConfig['server']
  /** 二维码往何处写。默认 stdout —— 扫码是终端里的动作，不应被日志格式化 */
  showQr?: (art: string, url: string) => void
}

/** 测试组合根：所有依赖都可替换，生产环境由 openServer() 补齐 */
export function buildServer(deps: ServerDeps, opts: BuildOptions = {}): Server {
  const startedAt = deps.clock.now()
  const log = deps.logger.child({ mod: 'server' })
  const auth = makeAuthLifecycle(deps, opts)
  const timedRegex = new TimedRegex(
    () => deps.config.getSection('filter').regexTimeoutMs,
    deps.logger,
  )
  const rules = new RuleService({
    rules: deps.repos.rules,
    subscriptions: deps.repos.subscriptions,
    config: deps.config,
    clock: deps.clock,
    logger: deps.logger,
    match: (pattern, text) => timedRegex.test(pattern, text),
  })
  const ai = new AiService({
    config: deps.config,
    secrets: deps.secrets,
    events: deps.events,
    logger: deps.logger,
    runtime: deps.runtime,
    llm: deps.external.llm,
    probeAsr: deps.external.probeAsr,
  })
  const queue = new SummaryQueue({
    jobs: deps.repos.jobs,
    artifacts: deps.repos.artifacts,
    summarize: new SummarizeVideo({
      subtitles: deps.external.subtitles,
      audio: deps.external.audio,
      asr: deps.external.asr,
      // 走 AiService 而不是 deps.external.llm：总开关关着时它给 null
      llm: () => ai.llm(),
      chunkConfig: () => deps.config.getSection('ai').chunk,
      promptConfig: () => deps.config.getSection('prompt'),
      asrConfig: () => deps.config.getSection('asr'),
      updates: deps.repos.updates,
      subs: deps.repos.subscriptions,
      summaries: deps.repos.summaries,
      artifacts: deps.repos.artifacts,
      llmCalls: deps.repos.llmCalls,
      markdown: deps.markdown,
      clock: deps.clock,
      logger: deps.logger,
      events: deps.events,
    }),
    llm: () => ai.llm(),
    config: deps.config,
    clock: deps.clock,
    logger: deps.logger,
    events: deps.events,
  })
  const poll = new Poller({
    reader: deps.external.biliReader,
    subs: deps.repos.subscriptions,
    updates: deps.repos.updates,
    anchors: deps.repos.anchors,
    state: deps.state,
    rules,
    config: deps.config,
    clock: deps.clock,
    logger: deps.logger,
    events: deps.events,
    // 没装 auth 适配器时当「不能干活」，避免对着空 cookie 发送多次请求
    loggedIn: () => auth?.isUsable() ?? false,
    onVideo: (v) => queue.enqueue(v),
  })
  const delivery = new DeliveryService({
    updates: deps.repos.updates,
    summaries: deps.repos.summaries,
    subscriptions: deps.repos.subscriptions,
    deliveries: deps.repos.deliveries,
    notifiers: deps.external.notifiers,
    config: deps.config,
    clock: deps.clock,
    events: deps.events,
    logger: deps.logger,
  })
  const notify = new NotifyService({
    config: deps.config,
    secrets: deps.secrets,
    notifiers: deps.external.notifiers,
    events: deps.events,
    logger: deps.logger,
  })
  const services: Services = {
    auth,
    subs: new SubscriptionService({
      subs: deps.repos.subscriptions,
      clock: deps.clock,
      logger: deps.logger,
      relations: deps.external.biliRelations,
      profile: deps.external.biliProfile,
      autoFollow: () => deps.config.getSection('bili').write.autoFollow,
    }),
    rules,
    poll,
    ai,
    notify,
    delivery,
    queue,
    ups: new UpFeedService({
      reader: deps.external.biliReader,
      subs: deps.repos.subscriptions,
      updates: deps.repos.updates,
      summaries: deps.repos.summaries,
      jobs: deps.repos.jobs,
      queue,
      clock: deps.clock,
      logger: deps.logger,
    }),
    health: new HealthMonitor({
      auth: () => auth?.snapshot() ?? null,
      poll: () => poll.snapshot(),
      jobs: deps.repos.jobs,
      deliveries: deps.repos.deliveries,
      notifiers: deps.external.notifiers,
      config: deps.config,
      clock: deps.clock,
      logger: deps.logger,
      events: deps.events,
    }),
    backup: new BackupService({
      config: deps.config,
      subs: deps.repos.subscriptions,
      rules: deps.repos.rules,
      updates: deps.repos.updates,
      summaries: deps.repos.summaries,
      clock: deps.clock,
      version: deps.version,
    }),
  }
  // 日志缓冲装在这里而不是路由里：它订阅了事件总线，得有人在关停时取消订阅
  const logs = new LogBuffer(deps.events)
  const app = createHttpApp(deps, {
    startedAt,
    webRoot: opts.webRoot ?? null,
    logs,
    auth: services.auth,
    subs: services.subs,
    poll: services.poll,
    rules: services.rules,
    ai: services.ai,
    notify: services.notify,
    queue: services.queue,
    ups: services.ups,
    health: services.health,
    backup: services.backup,
  })

  let listening: ServerType | null = null

  return {
    app,
    services,

    async start(): Promise<AddressInfo> {
      if (listening !== null) throw new Error('server already started')
      const { host, port } = opts.listen ?? deps.config.getSection('server')
      return await new Promise<AddressInfo>((resolve, reject) => {
        const srv = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
          log.info({ ...info, version: deps.version }, 'HTTP 服务已监听')
          resolve(info)
        })
        srv.once('error', reject)
        listening = srv
      })
    },

    async bootstrap(): Promise<void> {

      for (const bad of services.rules.validateAll()) {
        log.error(
          { ruleId: bad.id, scope: bad.scope, kind: bad.kind, pattern: bad.pattern },
          '过滤规则正则编译失败，该规则不会生效',
        )
      }
      services.poll.start()
      services.delivery.start()
      services.queue.start()
      services.health.start()
      // 上次跑挂了留下的音频没人删，累积能把磁盘吃光
      try {
        await deps.external.audio?.sweepOrphans(ORPHAN_AUDIO_MS)
      } catch (err) {
        log.warn(errFields(err), '音频临时文件清理失败')
      }

      const auth = services.auth
      if (auth === null) {
        log.warn({ reason: 'biliAuth 未装配' }, '登录态核对已跳过')
        return
      }
      try {
        const checked = await auth.ensureFresh()
        // 需要重新登录才出码。已经登录着的进程重启不应再打单个没人扫的码
        if (checked.ok && checked.value.action === 'relogin') {
          log.info({ reason: checked.value.reason }, '需要重新扫码登录')
          await auth.loginByQr()
        }
        // 登录上了才补关注：没登录时查关系必然失败，无效发送多次请求
        if (auth.snapshot().state === 'logged-in') {
          const synced = await services.subs.syncFollows()
          if (synced.followed > 0 || synced.notice !== null) {
            log.info(synced, '启动期关注同步完成')
          }
        }
      } catch (err) {
        log.error(errFields(err), '启动期登录态核对异常')
      }
    },

    async stop(): Promise<void> {
      services.poll.stop()
      services.delivery.stop()
      services.queue.stop()
      services.health.stop()
      logs.close()
      // 在飞的任务还在写库，等它们收尾再让调用方关连接。超过 10 秒就不等了（HTTP 那层自己有超时）
      await Promise.all([services.queue.drain(10_000), services.delivery.drain()])
      const srv = listening
      listening = null
      if (srv !== null) {
        await new Promise<void>((resolve) => srv.close(() => resolve()))
      }
      await deps.logger.close()
    },
  }
}

export function resolveListenConfig(
  config: AppConfig['server'],
  env: NodeJS.ProcessEnv,
): AppConfig['server'] {
  return ServerConfigSchema.parse({
    host: env['SERVER_HOST'] ?? config.host,
    port: env['SERVER_PORT'] === undefined ? config.port : Number(env['SERVER_PORT']),
  })
}

function makeAuthLifecycle(deps: ServerDeps, opts: BuildOptions): AuthLifecycle | null {
  const auth = deps.external.biliAuth
  if (auth === null) return null
  return new AuthLifecycle({
    auth,
    cookies: deps.cookies,
    state: deps.state,
    clock: deps.clock,
    events: deps.events,
    logger: deps.logger,
    // 用时读配置：页面上改完提前续期的天数，下一轮就生效
    refreshThresholdMs: () => deps.config.getSection('bili').refreshThresholdDays * 86_400_000,
    showQr: opts.showQr ?? defaultShowQr,
    renderQr,
  })
}

/** 字符画写 stdout，不走 logger —— 把二维码塞进日志文件对谁都无效 */
function defaultShowQr(art: string, url: string): void {
  process.stdout.write(`\n${art}\n用 B 站 App 扫上面的二维码登录\n若终端显示不全，可打开：${url}\n\n`)
}
