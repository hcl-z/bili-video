import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { buildServer } from './build-server.ts'
import { SystemClock } from './infra/clock/system-clock.ts'
import { InMemoryEventBus } from './infra/event-bus/in-memory.ts'
import { createLogger } from './log.ts'
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

// 容器里 json=true，由 docker logs 收走；本地 pino-pretty 给人看。
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
    seedFile: process.env['CONFIG_SEED'] ?? 'config.example.yaml',
    masterKeyPath: process.env['MASTER_KEY_PATH'],
    masterKeyPassphrase: process.env['MASTER_KEY'],
  })
} catch (err) {
  // master key 缺失/损坏这类问题必须响亮地死，不能带着半个内核继续跑。
  logger.fatal({ err: String(err) }, '启动失败')
  await logger.close()
  process.exit(1)
}

// 上次进程崩在中途的总结任务，捡回来续跑。
const revived = core.repos.jobs.resetRunning(clock.now())
if (revived > 0) logger.warn({ jobs: revived }, '重置上次未跑完的总结任务')

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
  // 后面几票逐个把 null 换成真适配器（读接口、关注、字幕、ASR、LLM、下载器、通知渠道）。
  external: {
    notifiers: [],
    biliAuth: core.biliAuth,
    biliReader: null,
    biliRelations: null,
    subtitles: null,
    asr: null,
    llm: null,
    audio: null,
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
  logger.info({ signal }, '正在退出')
  clock.stopAll()
  await server.stop()
  core.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
