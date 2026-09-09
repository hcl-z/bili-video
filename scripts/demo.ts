import { rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'

import { buildServer } from '../src/server/build-server.ts'
import { SystemClock } from '../src/server/infra/clock/system-clock.ts'
import { InMemoryEventBus } from '../src/server/infra/event-bus/in-memory.ts'
import { createLogger } from '../src/server/log.ts'
import type { Asr } from '../src/server/ports/asr.ts'
import type { AudioDownloader } from '../src/server/ports/audio.ts'
import type { Ports } from '../src/server/ports/index.ts'
import { openCore } from '../src/server/wiring.ts'
import { FakeFetch } from '../test/fakes/bili-fetch.ts'
import { DEMO_UP, demoAsrCues, demoBili, demoVideos } from './demo-data.ts'

/**
 * 假 B 站试跑：真实库、队列和页面，出网响应预编排。
 * 无小号或 LLM key 也可走抓取、入队、字幕、总结、落盘和页面实时更新，并复现无字幕与模型异常分支。
 */
const args = new Set(process.argv.slice(2))
const dataDir = resolve(process.env['DEMO_DATA_DIR'] ?? './.demo-data')
const webRoot = resolve('./dist/web')
const realLlm = args.has('--llm')
// 默认放慢：每一步真的停一下，SSE 推的阶段变化才看得见。
const stepMs = args.has('--fast') ? 0 : 1500

if (args.has('--fresh')) rmSync(dataDir, { recursive: true, force: true })

const clock = new SystemClock()
const events = new InMemoryEventBus()
const logger = createLogger({
  level: 'info',
  dir: join(dataDir, 'logs'),
  retentionDays: 1,
  json: false,
  sink: (line) => events.emitLog(line),
})

const fake = demoBili(new FakeFetch())
const slow = async (url: string): Promise<void> => {
  if (stepMs === 0) return
  if (url.includes('player/wbi/v2') || url.includes('/chat/completions')) {
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** 真 LLM 模式仅放行该域名；其余请求仍为假响应，不访问 B 站。 */
const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  await slow(url)
  if (realLlm && url.includes('/chat/completions')) return globalThis.fetch(input, init)
  return fake.fetch(input, init)
}

const core = openCore({
  dataDir,
  clock,
  logger,
  events,
  seedFile: 'config.example.yaml',
  fetch: fetchImpl,
})

/** 没字幕那条走「下音频 → 转写」，这里两步都是假的：demo 不该要求装 yt-dlp 和本地模型。 */
const audio: AudioDownloader = {
  download: async (bvid) => {
    await slow('/chat/completions')
    return { path: `${bvid}.m4a`, bytes: 3 << 20, durationSec: 130 }
  },
  cleanup: async () => {},
  sweepOrphans: async () => 0,
}
const asr: Asr = {
  provider: 'mlx-whisper',
  transcribe: async (path) => {
    await slow('/chat/completions')
    return demoAsrCues(basename(path, '.m4a'))
  },
}

// 预置登录态，demo 无需先扫码。
if (core.cookies.isEmpty()) {
  core.cookies.setFromResponse(['SESSDATA=demo; Path=/; Domain=.bilibili.com'], clock.now())
}

core.repos.subscriptions.upsert({ ...DEMO_UP, enableDynamic: true, enableVideo: true, enableAi: true })
// 使用 8789，避免与通常占用 8788 的正式服务冲突。
core.config.setSection('server', {
  ...core.config.getSection('server'),
  port: Number(process.env['DEMO_PORT'] ?? 8789),
})
core.config.setSection('bili', {
  ...core.config.getSection('bili'),
  // 真 WBI 签名要一张 64 元的置换表，假 nav 配这张就够跑通签名。
  wbiMixinTable: Array.from({ length: 64 }, (_, i) => i),
})
core.config.setSection('ai', {
  ...core.config.getSection('ai'),
  enabled: true,
  ...(realLlm ? {} : { baseURL: 'https://llm.demo/v1', model: 'demo-model' }),
})

const ports: Ports = {
  version: 'demo',
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
    notifiers: [],
    biliAuth: core.biliAuth,
    biliReader: core.biliReader,
    biliRelations: core.biliRelations,
    biliProfile: core.biliProfile,
    subtitles: core.subtitles,
    asr,
    llm: core.llm,
    audio,
    probeAsr: core.probeAsr,
  },
}

const server = buildServer(ports, { webRoot })
const addr = await server.start()
await server.bootstrap()

const port = typeof addr === 'object' ? addr.port : 0
console.log('')
console.log(`  工作台   http://127.0.0.1:${port}`)
console.log(`  数据目录 ${dataDir}（Markdown 在 ${join(dataDir, 'summaries')}）`)
console.log(`  假视频   ${demoVideos().map((v) => v.bvid).join('、')}`)
console.log(`  LLM      ${realLlm ? '真的（用配置里的 baseURL/apiKey）' : '假的（编排好的回答）'}`)
console.log(`  节奏     ${stepMs === 0 ? '不减速' : `每步慢 ${stepMs}ms，方便看阶段`}`)
console.log('')
console.log('  打开「更新流」点一次抓取，或等下面这轮自动抓完，再去「队列」看阶段。')
console.log('')

const first = await server.services.poll.pollOnce()
logger.child({ mod: 'demo' }).info({ found: first.found }, 'demo 首轮抓取完成')

let closing = false
const shutdown = async (): Promise<void> => {
  if (closing) return
  closing = true
  clock.stopAll()
  await server.stop()
  core.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
