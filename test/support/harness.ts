import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildServer, type Server } from '../../src/server/build-server.ts'
import { openCore, type Core } from '../../src/server/wiring.ts'
import { InMemoryEventBus } from '../../src/server/infra/event-bus/in-memory.ts'
import type { Asr } from '../../src/server/ports/asr.ts'
import type { AudioDownloader } from '../../src/server/ports/audio.ts'
import type { CommandRunner } from '../../src/server/ports/command.ts'
import type { Ports } from '../../src/server/ports/index.ts'
import { FakeFetch } from '../fakes/bili-fetch.ts'
import { FakeClock } from '../fakes/clock.ts'
import { CollectingLogger } from '../fakes/logger.ts'
import { RecordingNotifier } from '../fakes/notifier.ts'

/**
 * 主测试缝：装配好的服务，只有进程边界外的东西是假的。
 *
 * 真的部分：SQLite（临时目录里的真库，跑真 migrations）、config、secret-box、http、app、domain。
 * 假的部分：时钟、logger、通知渠道，以及后续 ticket 才会接上的 B 站 / ASR / LLM / 下载器。
 */
export interface Harness {
  server: Server
  core: Core
  ports: Ports
  clock: FakeClock
  logger: CollectingLogger
  notifier: RecordingNotifier
  events: InMemoryEventBus
  /** 出网的唯一假件。给它打桩就等于「B 站这么回」。 */
  fetch: FakeFetch
  /** 终端二维码的落点，断言「码有没有给出去」。 */
  qrs: string[]
  dataDir: string
  /** 用同一个 dataDir 重新装配一遍，用来测「重启后……」这类行为。 */
  restart(over?: Partial<HarnessOptions>): Promise<Harness>
  close(): Promise<void>
}

export interface HarnessOptions {
  /** 首次启动 seed 用的 YAML；null 表示不 seed。默认用仓库里的 config.example.yaml。 */
  seedFile?: string | null
  /** 复用已有目录（restart 场景）。 */
  dataDir?: string
  startAt?: number
  /** 托管前端产物的目录；默认不挂静态资源。 */
  webRoot?: string
  /** 复用同一个 FakeFetch（restart 场景要保留打过的桩）。 */
  fetch?: FakeFetch
  /**
   * 装配前先塞进 cookie 罐的 Set-Cookie 行，等于「上次已经登录过」。
   * 必须在 buildServer 之前 —— 登录态的初值是构造时看 cookie 罐定的。
   */
  cookies?: string[]
  /** restart 内部用：把临时目录的所有权交给新实例，免得跑完一屋子 tmp 目录没人收。 */
  ownsDataDir?: boolean
  /** 本地可执行文件的假件。不给就是真的去 PATH 上找，测试里别这么干。 */
  commands?: CommandRunner
  /**
   * 音频下载与转写的假件。默认 null = 「这个进程没接 ASR」，
   * 于是没字幕的视频直接退到简介兜底 —— 不给假件就绝不会真去 exec yt-dlp。
   */
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
    seedFile: opts.seedFile === undefined ? 'config.example.yaml' : opts.seedFile,
    fetch: fetch.fetch,
    ...(opts.commands === undefined ? {} : { commands: opts.commands }),
  })

  if (opts.cookies !== undefined && core.cookies.isEmpty()) {
    core.cookies.setFromResponse(opts.cookies, clock.now())
  }

  const ports: Ports = {
    version: 'test',
    clock,
    logger,
    events,
    config: core.config,
    secrets: core.secrets,
    repos: core.repos,
    state: core.state,
    cookies: core.cookies,
    // 真 writer，写进临时 dataDir —— 「落盘了没有」才测得到。
    markdown: core.markdown,
    external: {
      notifiers: [notifier],
      biliAuth: core.biliAuth,
      biliReader: core.biliReader,
      // 关注与名片都是真适配器，只有 fetch 是假的 —— 限流和审计因此也是真在跑。
      biliRelations: core.biliRelations,
      biliProfile: core.biliProfile,
      subtitles: core.subtitles,
      asr: opts.asr ?? null,
      llm: core.llm,
      audio: opts.audio ?? null,
      probeAsr: core.probeAsr,
    },
  }

  // 端口 0 = 让内核分配。测试不该去抢 8788，也不该因为本机正好起着服务而失败。
  core.config.setSection('server', { ...core.config.getSection('server'), port: 0 })

  const qrs: string[] = []
  const server = buildServer(ports, {
    webRoot: opts.webRoot ?? null,
    // 不往 stdout 写：测试输出里塞一张二维码没人看得下去。
    showQr: (_art, url) => qrs.push(url),
  })

  const harness: Harness = {
    server,
    core,
    ports,
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
      // 带上同一个 FakeFetch：重启后打过的桩还在，否则「重启后登录态还在」没法测。
      // over 用来改这次启动的参数，典型是 startAt（抓取地板按启动时刻算）。
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
