import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildServer, type Server } from '../../src/server/build-server.ts'
import { openCore, type Core } from '../../src/server/wiring.ts'
import { InMemoryEventBus } from '../../src/server/infra/event-bus/in-memory.ts'
import type { Ports } from '../../src/server/ports/index.ts'
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
  dataDir: string
  /** 用同一个 dataDir 重新装配一遍，用来测「重启后……」这类行为。 */
  restart(): Promise<Harness>
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
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'bili-video-test-'))
  const owned = opts.dataDir === undefined
  const clock = new FakeClock(opts.startAt)
  const logger = new CollectingLogger()
  const events = new InMemoryEventBus()
  const notifier = new RecordingNotifier()

  const core = openCore({
    dataDir,
    clock,
    logger,
    events,
    seedFile: opts.seedFile === undefined ? 'config.example.yaml' : opts.seedFile,
  })

  const ports: Ports = {
    version: 'test',
    clock,
    logger,
    events,
    config: core.config,
    secrets: core.secrets,
    repos: core.repos,
    external: { notifiers: [notifier], bili: null, asr: null, llm: null, audio: null },
  }

  // 端口 0 = 让内核分配。测试不该去抢 8788，也不该因为本机正好起着服务而失败。
  core.config.setSection('server', { ...core.config.getSection('server'), port: 0 })

  const server = buildServer(ports, { webRoot: opts.webRoot ?? null })

  const harness: Harness = {
    server,
    core,
    ports,
    clock,
    logger,
    notifier,
    events,
    dataDir,
    async restart() {
      await server.stop()
      core.close()
      return createHarness({ ...opts, dataDir })
    },
    async close() {
      await server.stop()
      core.close()
      if (owned) rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return harness
}
