import { z } from 'zod'

/**
 * 配置的唯一真相是数据库的 `app_config` 表；`config.example.yaml` 只在首次启动时 seed。
 * 这里的 schema 是 YAML 与 DB 两处的共同入口 —— 「Parse, don't validate」的三处边界之一。
 *
 * 每个 section 是 `app_config` 里的一行（key = section 名，value_json = 该对象），
 * 因此改一个 section 不会覆写别的 section。
 */

export const ServerConfigSchema = z.object({
  /** 只听回环地址。改成 0.0.0.0 等于放弃「无登录系统」这个前提，别改（spec Q31a）。 */
  host: z.string().default('127.0.0.1'),
  /** 0 = 让内核分配一个空闲端口。测试用它，生产别用（客户端没法猜到端口）。 */
  port: z.number().int().min(0).max(65535).default(8788),
})

export const PollConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** 秒位错到 :30，避开全网客户端堆在整分的流量尖峰。 */
  cron: z.string().default('30 */2 * * * *'),
})

export const QuietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  /** 本地时间 HH:mm，允许跨午夜（start > end 表示跨天）。 */
  start: z.string().regex(/^\d{2}:\d{2}$/).default('23:30'),
  end: z.string().regex(/^\d{2}:\d{2}$/).default('07:30'),
})

export const FilterConfigSchema = z.object({
  quietHours: QuietHoursSchema.default({}),
  /** 用户手写正则的执行超时，防 ReDoS 把轮询卡死。 */
  regexTimeoutMs: z.number().int().min(1).max(5000).default(100),
})

export const ChunkConfigSchema = z.object({
  /** 全文超过这个 token 数才分段，否则整篇一次总结。 */
  thresholdTokens: z.number().int().min(1000).default(12000),
  sizeTokens: z.number().int().min(500).default(8000),
  overlapTokens: z.number().int().min(0).default(400),
})

export const AiConfigSchema = z.object({
  /** 总开关。关掉后只推送不总结，AI 成本归零。 */
  enabled: z.boolean().default(true),
  /** OpenAI 兼容即可，不绑任何 SDK。apiKey 不在这里 —— 它加密存 secrets 表。 */
  baseURL: z.string().default(''),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.3),
  chunk: ChunkConfigSchema.default({}),
  llmConcurrency: z.number().int().min(1).max(8).default(2),
})

export const AsrConfigSchema = z.object({
  /** 容器里拿不到 Metal，必须是 openai-compat；启动校验会断言这条。 */
  provider: z.enum(['mlx-whisper', 'openai-compat']).default('mlx-whisper'),
  model: z.string().default('mlx-community/whisper-large-v3-turbo'),
  language: z.string().default('zh'),
  /** ASR 是分钟级重活，并发 1 —— 免得把 16GB 内存吃满。 */
  concurrency: z.literal(1).default(1),
})

export const NotifyConfigSchema = z.object({
  wxpusher: z
    .object({
      enabled: z.boolean().default(false),
      /** appToken 加密存 secrets 表，不在这里。 */
      uids: z.array(z.string()).default([]),
    })
    .default({}),
  ntfy: z
    .object({
      enabled: z.boolean().default(false),
      server: z.string().default('https://ntfy.sh'),
      topic: z.string().default(''),
    })
    .default({}),
})

export const CatchupConfigSchema = z.object({
  /** 睡眠/停机唤醒后补推的时间窗；更老的只入库。 */
  windowHours: z.number().int().min(1).max(168).default(24),
  /** 窗口内积压超过这个条数就只发一条汇总，不逐条轰炸。 */
  overflowThreshold: z.number().int().min(1).default(20),
})

export const HealthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().default('0 */30 * * * *'),
})

export const LogConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  retentionDays: z.number().int().min(1).max(90).default(7),
})

export const AppConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  poll: PollConfigSchema.default({}),
  filter: FilterConfigSchema.default({}),
  ai: AiConfigSchema.default({}),
  asr: AsrConfigSchema.default({}),
  notify: NotifyConfigSchema.default({}),
  catchup: CatchupConfigSchema.default({}),
  health: HealthConfigSchema.default({}),
  log: LogConfigSchema.default({}),
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type ConfigSection = keyof AppConfig

/** section 名 → 该 section 的 schema。配置的按段读写都过这张表。 */
export const CONFIG_SECTIONS = {
  server: ServerConfigSchema,
  poll: PollConfigSchema,
  filter: FilterConfigSchema,
  ai: AiConfigSchema,
  asr: AsrConfigSchema,
  notify: NotifyConfigSchema,
  catchup: CatchupConfigSchema,
  health: HealthConfigSchema,
  log: LogConfigSchema,
} as const

export const CONFIG_SECTION_NAMES = Object.keys(CONFIG_SECTIONS) as ConfigSection[]

export const defaultConfig = (): AppConfig => AppConfigSchema.parse({})
