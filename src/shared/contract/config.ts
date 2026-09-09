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

/**
 * WBI 签名的 64 位混淆表：把 `imgKey + subKey` 的 64 个字符按这张表重排，取前 32 位当密钥。
 *
 * 留空 = 未配置。需要 WBI 的接口会明确报错并说清缺什么，而不是发一个签名错的请求
 * 换回 -352 —— 那会被当成风控，白白触发退避。
 */
const MixinTableSchema = z
  .array(z.number().int().min(0).max(63))
  .refine((a) => a.length === 0 || a.length === 64, '混淆表必须正好 64 项，或留空表示未配置')
  .refine((a) => a.length === 0 || new Set(a).size === a.length, '混淆表里有重复下标')
  .default([])

export const BiliConfigSchema = z.object({
  /** 提前多少天开始续 cookie。B 站的 SESSDATA 是月级有效期。 */
  refreshThresholdDays: z.number().int().min(1).max(60).default(15),
  wbiMixinTable: MixinTableSchema,
  /**
   * `bili_ticket` 的签名参数。空 = 未配置，风控重试链里「重取 ticket」那一步会跳过并说明原因。
   * 这些是 B 站 web 端 JS 里的公开常量，不是密钥，所以放配置而不是 secrets。
   */
  ticket: z
    .object({
      keyId: z.string().default(''),
      hmacKey: z.string().default(''),
    })
    .default({}),
  /** cookie 续期链里 `correspond/1` 用的 RSA 公钥（PEM）。空 = 不做自动续期，到期只能重新扫码。 */
  correspondPublicKeyPem: z.string().default(''),
  /**
   * 写接口（只有「自动关注」）的独立限流。和读接口的轮询节奏完全无关 ——
   * 写接口的风控严得多，3–5 个订阅一次加完就没事了，所以给得很保守。
   */
  write: z
    .object({
      /** 刹车。关掉后订阅照样能加，只是不再自动关注，得自己去 B 站点关注。 */
      autoFollow: z.boolean().default(true),
      minIntervalMs: z.number().int().min(0).max(60_000).default(3_000),
      maxPerHour: z.number().int().min(1).max(200).default(20),
    })
    .default({}),
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
  /**
   * 单次调用的总超时。阅读版总结一次要吐上万 token，按 30–40 token/s 算就是好几分钟，
   * 给小了会在快写完的时候被自己掐死。流式下还有一道 90s 的空闲超时管「假死」。
   */
  timeoutMs: z.number().int().min(10_000).max(1_800_000).default(600_000),
})

export const AsrConfigSchema = z.object({
  /**
   * 容器里拿不到 Metal，必须是云端那两种；启动校验会断言这条。
   *
   * openai-compat = Whisper 那套 /audio/transcriptions；
   * chat-audio = 把音频塞进 chat/completions 的 input_audio（MiMo、Qwen-Omni 这类）。
   */
  provider: z.enum(['mlx-whisper', 'openai-compat', 'chat-audio']).default('mlx-whisper'),
  /** 只有云端两种用得上；mlx-whisper 是本地进程，没有 baseURL。apiKey 同 LLM，加密存 secrets 表。 */
  baseURL: z.string().default(''),
  model: z.string().default('mlx-community/whisper-large-v3-turbo'),
  language: z.string().default('zh'),
  /** ASR 是分钟级重活，并发 1 —— 免得把 16GB 内存吃满。 */
  concurrency: z.literal(1).default(1),
  /**
   * chat-audio 专用：切成多长一段送过去（秒）。
   *
   * 这类接口没有时间轴，切段是唯一能拿到时间戳的办法，段长就是时间戳的精度；
   * 同时它们多半有请求体上限（MiMo 是 base64 后 10MB），段太长会被拒。
   */
  segmentSec: z.number().int().min(30).max(1800).default(120),
})

export const OutputConfigSchema = z.object({
  /** 总结 Markdown 的落盘目录。相对路径按 DATA_DIR 解析。 */
  markdownDir: z.string().min(1).default('summaries'),
})

export const NotifyConfigSchema = z.object({
  wxpusher: z
    .object({
      enabled: z.boolean().default(false),
      /** appToken 加密存 secrets 表，不在这里。 */
      uids: z
        .array(z.string().min(1))
        .transform((values) => [...new Set(values)])
        .default([]),
    })
    .default({}),
  ntfy: z
    .object({
      enabled: z.boolean().default(false),
      server: z.string().url().default('https://ntfy.sh'),
      topic: z
        .string()
        .regex(/^$|^[-_A-Za-z0-9]{1,64}$/, 'topic 只能包含字母、数字、短横线和下划线，最长 64 位')
        .default(''),
    })
    .default({}),
  feishu: z
    .object({
      enabled: z.boolean().default(false),
      appId: z.string().default(''),
      receiveIdType: z
        .enum(['open_id', 'union_id', 'user_id', 'email', 'chat_id'])
        .default('open_id'),
      receiveId: z.string().default(''),
    })
    .default({}),
  webhook: z
    .object({
      enabled: z.boolean().default(false),
      url: z.union([z.literal(''), z.string().url()]).default(''),
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
  bili: BiliConfigSchema.default({}),
  filter: FilterConfigSchema.default({}),
  ai: AiConfigSchema.default({}),
  asr: AsrConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  notify: NotifyConfigSchema.default({}),
  catchup: CatchupConfigSchema.default({}),
  health: HealthConfigSchema.default({}),
  log: LogConfigSchema.default({}),
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type ConfigSection = keyof AppConfig
export type AiConfig = z.infer<typeof AiConfigSchema>
export type AsrConfig = z.infer<typeof AsrConfigSchema>
export type ChunkConfig = z.infer<typeof ChunkConfigSchema>
export type OutputConfig = z.infer<typeof OutputConfigSchema>
export type NotifyConfig = z.infer<typeof NotifyConfigSchema>

/** section 名 → 该 section 的 schema。配置的按段读写都过这张表。 */
export const CONFIG_SECTIONS = {
  server: ServerConfigSchema,
  poll: PollConfigSchema,
  bili: BiliConfigSchema,
  filter: FilterConfigSchema,
  ai: AiConfigSchema,
  asr: AsrConfigSchema,
  output: OutputConfigSchema,
  notify: NotifyConfigSchema,
  catchup: CatchupConfigSchema,
  health: HealthConfigSchema,
  log: LogConfigSchema,
} as const

export const CONFIG_SECTION_NAMES = Object.keys(CONFIG_SECTIONS) as ConfigSection[]

export const defaultConfig = (): AppConfig => AppConfigSchema.parse({})
