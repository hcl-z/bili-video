import type { AddressInfo } from 'node:net'
import process from 'node:process'
import { serve, type ServerType } from '@hono/node-server'
import type { Hono } from 'hono'

import { AiService } from './app/ai.ts'
import { AuthLifecycle } from './app/auth-lifecycle.ts'
import { Poller } from './app/poller.ts'
import { SummaryQueue } from './app/queue-runner.ts'
import { RuleService } from './app/rules.ts'
import { SubscriptionService } from './app/subscriptions.ts'
import { SummarizeVideo } from './app/summarize-video.ts'
import { createHttpApp } from './http/app.ts'
import { renderQr } from './infra/bili/qr-terminal.ts'
import { TimedRegex } from './infra/regex/timed-regex.ts'
import type { Ports } from './ports/index.ts'

/**
 * ★ 组装根。所有实现都从 ports 注入进来，这里不 new 任何适配器。
 *
 * 这是主测试缝：测试传假件拿到 app，用 app.request() 在进程内驱动，不起网络、不等真时间。
 * 因此这里绝不能出现模块级单例或 `import db from './db'` —— 那会让缝立刻失效。
 */
export interface Server {
  app: Hono
  /** app 层服务。启动流程和测试都要拿它做事，所以摆在外面而不是藏在闭包里。 */
  services: Services
  /** 起 HTTP 监听，返回实际绑定的地址（port 配 0 时才知道真端口）。 */
  start(): Promise<AddressInfo>
  /**
   * 起监听之后要做的事：核对登录态，需要时在终端出码。
   *
   * 刻意不在 start() 里 await —— 扫码要等人，工作台不该为此推迟到能打开。
   * 永不 reject：启动期的问题落日志和快照，不该把进程带走。
   */
  bootstrap(): Promise<void>
  stop(): Promise<void>
}

/** 组装出来的 app 层服务。null = 依赖的适配器还没接上。 */
export interface Services {
  auth: AuthLifecycle | null
  subs: SubscriptionService
  rules: RuleService
  poll: Poller
  ai: AiService
  queue: SummaryQueue
}

/** 超过一天的音频文件当孤儿清掉。 */
const ORPHAN_AUDIO_MS = 24 * 3_600_000

export interface BuildOptions {
  webRoot?: string | null
  /** 二维码往哪儿写。默认 stdout —— 扫码是终端里的动作，不该被日志格式化。 */
  showQr?: (art: string, url: string) => void
}

export function buildServer(ports: Ports, opts: BuildOptions = {}): Server {
  const startedAt = ports.clock.now()
  const auth = makeAuthLifecycle(ports, opts)
  const timedRegex = new TimedRegex(
    () => ports.config.getSection('filter').regexTimeoutMs,
    ports.logger,
  )
  const rules = new RuleService({
    rules: ports.repos.rules,
    config: ports.config,
    clock: ports.clock,
    logger: ports.logger,
    match: (pattern, text) => timedRegex.test(pattern, text),
  })
  const ai = new AiService({
    config: ports.config,
    secrets: ports.secrets,
    events: ports.events,
    logger: ports.logger,
    llm: ports.external.llm,
    probeAsr: ports.external.probeAsr,
  })
  const queue = new SummaryQueue({
    jobs: ports.repos.jobs,
    summarize: new SummarizeVideo({
      subtitles: ports.external.subtitles,
      audio: ports.external.audio,
      asr: ports.external.asr,
      // 走 AiService 而不是 ports.external.llm：总开关关着时它给 null。
      llm: () => ai.llm(),
      chunkConfig: () => ports.config.getSection('ai').chunk,
      asrConfig: () => ports.config.getSection('asr'),
      updates: ports.repos.updates,
      subs: ports.repos.subscriptions,
      summaries: ports.repos.summaries,
      llmCalls: ports.repos.llmCalls,
      markdown: ports.markdown,
      clock: ports.clock,
      logger: ports.logger,
      events: ports.events,
    }),
    llm: () => ai.llm(),
    config: ports.config,
    clock: ports.clock,
    logger: ports.logger,
    events: ports.events,
  })
  const services: Services = {
    auth,
    subs: new SubscriptionService({
      subs: ports.repos.subscriptions,
      clock: ports.clock,
      logger: ports.logger,
      relations: ports.external.biliRelations,
      profile: ports.external.biliProfile,
      autoFollow: () => ports.config.getSection('bili').write.autoFollow,
    }),
    rules,
    poll: new Poller({
      reader: ports.external.biliReader,
      subs: ports.repos.subscriptions,
      updates: ports.repos.updates,
      anchors: ports.repos.anchors,
      state: ports.state,
      rules,
      config: ports.config,
      clock: ports.clock,
      logger: ports.logger,
      events: ports.events,
      // 没装 auth 适配器时当「不能干活」，别对着空 cookie 打一串请求。
      loggedIn: () => auth?.isUsable() ?? false,
      onVideo: (v) => queue.enqueue(v),
    }),
    ai,
    queue,
  }
  const app = createHttpApp(ports, {
    startedAt,
    webRoot: opts.webRoot ?? null,
    auth: services.auth,
    subs: services.subs,
    poll: services.poll,
    rules: services.rules,
    ai: services.ai,
    queue: services.queue,
  })

  let listening: ServerType | null = null

  return {
    app,
    services,

    async start(): Promise<AddressInfo> {
      if (listening !== null) throw new Error('server already started')
      const { host, port } = ports.config.getSection('server')
      return await new Promise<AddressInfo>((resolve, reject) => {
        const srv = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
          ports.logger.info({ ...info, version: ports.version }, '工作台已启动')
          resolve(info)
        })
        srv.once('error', reject)
        listening = srv
      })
    },

    async bootstrap(): Promise<void> {
      // 正则在这里预编译一遍。坏规则运行时只是「不命中」，不报出来就永远查不到。
      for (const bad of services.rules.validateAll()) {
        ports.logger.error(
          { id: bad.id, scope: bad.scope, kind: bad.kind, pattern: bad.pattern },
          '过滤规则里的正则编译不过，这一条不会生效',
        )
      }
      services.poll.start()
      services.queue.start()
      // 上次跑挂了留下的音频没人删，攒着能把磁盘吃光。
      try {
        await ports.external.audio?.sweepOrphans(ORPHAN_AUDIO_MS)
      } catch (err) {
        ports.logger.warn({ err: String(err) }, '清理音频临时文件失败')
      }

      const auth = services.auth
      if (auth === null) {
        ports.logger.warn({}, 'B 站适配器未接入，跳过登录态核对')
        return
      }
      try {
        const checked = await auth.ensureFresh()
        // 需要重新登录才出码。已经登录着的进程重启不该再打一张没人扫的码。
        if (checked.ok && checked.value.action === 'relogin') {
          ports.logger.info({ reason: checked.value.reason }, '需要扫码登录')
          await auth.loginByQr()
        }
        // 登录上了才补关注：没登录时查关系必然失败，白打一串请求。
        if (auth.snapshot().state === 'logged-in') {
          const synced = await services.subs.syncFollows()
          if (synced.followed > 0 || synced.notice !== null) {
            ports.logger.info(synced, '启动期补关注')
          }
        }
      } catch (err) {
        ports.logger.error({ err: String(err) }, '启动期核对登录态出错')
      }
    },

    async stop(): Promise<void> {
      services.poll.stop()
      services.queue.stop()
      // 在飞的任务还在写库，等它们收尾再让调用方关连接。超过 10 秒就不等了（HTTP 那层自己有超时）。
      await services.queue.drain(10_000)
      const srv = listening
      listening = null
      if (srv !== null) {
        await new Promise<void>((resolve) => srv.close(() => resolve()))
      }
      await ports.logger.close()
    },
  }
}

function makeAuthLifecycle(ports: Ports, opts: BuildOptions): AuthLifecycle | null {
  const auth = ports.external.biliAuth
  if (auth === null) return null
  return new AuthLifecycle({
    auth,
    cookies: ports.cookies,
    state: ports.state,
    clock: ports.clock,
    events: ports.events,
    logger: ports.logger,
    // 用时读配置：页面上改完提前续期的天数，下一轮就生效。
    refreshThresholdMs: () => ports.config.getSection('bili').refreshThresholdDays * 86_400_000,
    showQr: opts.showQr ?? defaultShowQr,
    renderQr,
  })
}

/** 字符画写 stdout，不走 logger —— 把二维码塞进日志文件对谁都没用。 */
function defaultShowQr(art: string, url: string): void {
  process.stdout.write(`\n${art}\n用 B 站 App 扫上面的二维码登录\n若终端显示不全，可打开：${url}\n\n`)
}
