import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { buildServer } from './build-server.ts'
import { SystemClock } from './infra/clock/system-clock.ts'
import { InMemoryEventBus } from './infra/event-bus/in-memory.ts'
import { createLogger } from './log.ts'
import { errFields } from './log-fields.ts'
import type { Ports } from './ports/index.ts'
import { openCore, type Core } from './wiring.ts'

/**
 * 薄入口：只负责「用真实 infra 填出 ports，交给 buildServer」。
 *
 * 任何判断、任何编排都不该写在这里 —— 写在这里的东西测不到（测试走 buildServer 那条缝）。
 * 所以这个文件只允许出现 new / 读环境变量 / 进程信号。
 */
const VERSION = '0.1.0'

const dataDir = resolve(process.env['DATA_DIR'] ?? './data')
const webRoot = resolve(process.env['WEB_ROOT'] ?? './dist/web')

const clock = new SystemClock()
const events = new InMemoryEventBus()

const logger = createLogger({
  level: (process.env['LOG_LEVEL'] as 'info') ?? 'info',
  dir: join(dataDir, 'logs'),
  retentionDays: 7,
  json: process.env['LOG_JSON'] === '1',
  // 日志同时进事件总线，供工作台的 /api/logs/stream 实时看。
  sink: (line) => events.emitLog(line),
})

let core: Core
try {
  core = openCore({
    dataDir,
    clock,
    logger,
    events,
    masterKeyPath: process.env['MASTER_KEY_PATH'],
    masterKeyPassphrase: process.env['MASTER_KEY'],
  })
} catch (err) {
  // master key 缺失/损坏这类问题必须响亮地死，不能带着半个内核继续跑。
  logger.child({ mod: 'boot' }).fatal(errFields(err), '启动失败')
  await logger.close()
  process.exit(1)
}

const ports: Ports = {
  version: VERSION,
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

// 只在构建产物存在时挂静态资源：`pnpm dev` 时前端由 Vite 自己伺服。
const server = buildServer(ports, {
  webRoot: existsSync(join(webRoot, 'index.html')) ? webRoot : null,
})

await server.start()
// 不 await：扫码要等人，工作台不该为此推迟到能打开。bootstrap 自己不抛。
void server.bootstrap()

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  logger.child({ mod: 'boot' }).info({ signal }, '进程关停中')
  clock.stopAll()
  await server.stop()
  core.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
