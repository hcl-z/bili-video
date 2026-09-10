import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildServer, type Server } from '../../src/server/server.ts'
import { openCore, type Core } from '../../src/server/server.ts'
import { InMemoryEventBus } from '../../src/server/infra/event-bus/in-memory.ts'
import type { Asr } from '../../src/server/types/ai.ts'
import type { AudioDownloader } from '../../src/server/types/ai.ts'
import type { CommandRunner } from '../../src/server/types/platform.ts'
import type { ServerDeps } from '../../src/server/types/index.ts'
import { FakeFetch } from '../fakes/bili-fetch.ts'
import { FakeClock } from '../fakes/clock.ts'
import { CollectingLogger } from '../fakes/logger.ts'
import { RecordingNotifier } from '../fakes/notifier.ts'

/** 主测试缝：装配好的服务，只有进程边界外的数据是假的。 真的部分：SQLite（临时目录里的实际数据库，跑真 migrations）、config、secret-box、http、app、domain。 假的部分：时钟、logger、通知渠道，以及后续 ticket 才会接上的 B 站 / ASR / LLM / 下载器 */
export interface Harness {
  server: Server
  core: Core
  deps: ServerDeps
  clock: FakeClock
  logger: CollectingLogger
  notifier: RecordingNotifier
  events: InMemoryEventBus
  /** 出网的唯一测试替身。给它替换就等于「B 站这么回」 */
  fetch: FakeFetch
  /** 终端二维码的落点，断言「码有没有给出去」 */
  qrs: string[]
  dataDir: string

  restart(over?: Partial<HarnessOptions>): Promise<Harness>
  close(): Promise<void>
}

export interface HarnessOptions {

  dataDir?: string
  startAt?: number

  webRoot?: string

  fetch?: FakeFetch
  /** 装配前先塞进 cookie 罐的 Set-Cookie 行，等于「上次已经登录过」。 必须在 buildServer 之前 —— 登录态的初值是构造时看 cookie 罐定的 */
  cookies?: string[]

  ownsDataDir?: boolean
  /** 把运行态固定下来，测试容器分支时不依赖宿主机是否真的在 Docker 中 */
  isDocker?: boolean
  /** 本地可执行文件的测试替身。不给就是真的去 PATH 上找，测试里避免这么干 */
  commands?: CommandRunner
  /** 音频下载与转写的测试替身。默认 null = 「这个进程没接 ASR」， 于是没字幕的视频直接退到简介兜底 —— 不给测试替身就绝不会真去 exec yt-dlp */
  audio?: AudioDownloader | null
  asr?: Asr | null
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'bili-video-test-'))
  const owned = opts.ownsDataDir ?? opts.dataDir === undefined
  const clock = new FakeClock(opts.startAt)
  const logger = new CollectingLogger()
  const events = new InMemoryEventBus()
  const notifier = new RecordingNotifier()
  const fetch = opts.fetch ?? new FakeFetch()

  const core = openCore({
    dataDir,
    clock,
    logger,
    events,
    runtime: { isDocker: opts.isDocker ?? false },
    fetch: fetch.fetch,
    ...(opts.commands === undefined ? {} : { commands: opts.commands }),
  })

  if (opts.cookies !== undefined && core.cookies.isEmpty()) {
    core.cookies.setFromResponse(opts.cookies, clock.now())
  }

  const deps: ServerDeps = {
    version: 'test',
    clock,
    logger,
    events,
    config: core.config,
    secrets: core.secrets,
    repos: core.repos,
    state: core.state,
    cookies: core.cookies,
    // 真 writer，写进临时 dataDir —— 「落盘了没有」才测得到
    markdown: core.markdown,
    storage: core.storage,
    runtime: { isDocker: opts.isDocker ?? false },
    external: {
      notifiers: [notifier],
      biliAuth: core.biliAuth,
      biliReader: core.biliReader,
      // 关注与名片都是实际适配器，只有 fetch 是假的 —— 限流和审计因此也是真在跑
      biliRelations: core.biliRelations,
      biliProfile: core.biliProfile,
      subtitles: core.subtitles,
      asr: opts.asr ?? null,
      llm: core.llm,
      audio: opts.audio ?? null,
      probeAsr: core.probeAsr,
    },
  }

  // 端口 0 = 让内核分配。测试不应去抢 8788，也不应因为本机正好起着服务而失败
  core.config.setSection('server', { ...core.config.getSection('server'), port: 0 })

  const qrs: string[] = []
  const server = buildServer(deps, {
    webRoot: opts.webRoot ?? null,
    // 不往 stdout 写：测试输出里塞单个二维码没查看得下去
    showQr: (_art, url) => qrs.push(url),
  })

  const harness: Harness = {
    server,
    core,
    deps,
    clock,
    logger,
    notifier,
    events,
    fetch,
    qrs,
    dataDir,
    async restart(over: Partial<HarnessOptions> = {}) {
      await server.stop()
      core.close()
      // 带上同一个 FakeFetch：重启后打过的桩还在，否则「重启后登录态还在」没法测

      return createHarness({ ...opts, dataDir, fetch, ownsDataDir: owned, ...over })
    },
    async close() {
      await server.stop()
      core.close()
      if (owned) rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return harness
}
