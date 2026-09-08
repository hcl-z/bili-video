import { z } from 'zod'
import { AiConfigSchema, AppConfigSchema, AsrConfigSchema } from './config.ts'
import { SummaryJobSchema } from './job.ts'
import { ProbeResultSchema } from './probe.ts'
import {
  FilterRuleSchema,
  RuleKindSchema,
  RuleScopeSchema,
  SubscriptionSchema,
} from './subscription.ts'
import { UpdateSchema } from './update.ts'

/**
 * 每个 /api 端点的 req/res schema。前端从 z.infer 拿类型，
 * 后端用同一个 schema 做入参校验 —— 契约不会前后端各写一份。
 */

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  /** 进程启动时刻（epoch ms），配 uptimeMs 一起看能判断有没有偷偷重启过。 */
  startedAt: z.number().int(),
  uptimeMs: z.number().int().min(0),
  now: z.number().int(),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

export const ConfigResponseSchema = z.object({
  config: AppConfigSchema,
  /** 页面上要明确写「YAML 已不再生效」，这个字段就是那句话的依据。 */
  seededFrom: z.string().nullable(),
})
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>

/**
 * 登录态。五个状态互斥且穷举 —— 工作台上「转圈」不是一个状态，
 * 「不知道」必须落到 logged-out 或 auth-lost 之一，否则页面会永远等下去。
 */
export const AuthStateSchema = z.enum([
  /** 本地没有 cookie，等人来扫码。 */
  'logged-out',
  /** 二维码已打印，等扫。 */
  'waiting-scan',
  /** 扫了，等手机上点确认。 */
  'scanned',
  'logged-in',
  /** 有 cookie 但已经不能用了（续期链走不通或 B 站说没登录）。要人重新扫码。 */
  'auth-lost',
])
export type AuthState = z.infer<typeof AuthStateSchema>

export const AuthSnapshotSchema = z.object({
  state: AuthStateSchema,
  uid: z.string().nullable(),
  uname: z.string().nullable(),
  /** cookie 到期时刻（epoch ms）；null = 无从判断。 */
  expiresAt: z.number().int().nullable(),
  /** 剩余有效期，已过期是 0 而不是负数。 */
  remainingMs: z.number().int().min(0).nullable(),
  /** 连续续期失败次数。工作台要能看见「已经失败几次了」。 */
  refreshFailures: z.number().int().min(0),
  /** 上次核对登录态的时刻；null = 本进程还没核对过。 */
  checkedAt: z.number().int().nullable(),
  /** 最近一次失败的原因，给人看的一句话。 */
  lastError: z.string().nullable(),
})
export type AuthSnapshot = z.infer<typeof AuthSnapshotSchema>

/** auth-lost 是终态：cron 已经被摘掉，页面看到它就该催人重新登录。 */
export const PollStatusSchema = z.enum(['idle', 'running', 'backoff', 'disabled', 'auth-lost'])
export type PollStatus = z.infer<typeof PollStatusSchema>

export const PollSnapshotSchema = z.object({
  status: PollStatusSchema,
  lastRunAt: z.number().int().nullable(),
  lastOk: z.boolean().nullable(),
  lastError: z.string().nullable(),
  /** 退避到什么时候；null = 不在退避中。 */
  resumeAt: z.number().int().nullable(),
  consecutiveFailures: z.number().int().min(0),
})
export type PollSnapshot = z.infer<typeof PollSnapshotSchema>

export const SystemResponseSchema = z.object({
  auth: AuthSnapshotSchema,
  poll: PollSnapshotSchema,
  version: z.string(),
  startedAt: z.number().int(),
  uptimeMs: z.number().int().min(0),
  now: z.number().int(),
})
export type SystemResponse = z.infer<typeof SystemResponseSchema>

export const SubscriptionsResponseSchema = z.object({
  subs: z.array(SubscriptionSchema),
})
export type SubscriptionsResponse = z.infer<typeof SubscriptionsResponseSchema>

/** 用户粘进来的原文：uid、`UID:123`、空间页链接、或者一整段分享文本。 */
export const AddSubscriptionRequestSchema = z.object({
  input: z.string().min(1),
})
export type AddSubscriptionRequest = z.infer<typeof AddSubscriptionRequestSchema>

/**
 * 订阅成功但关注没成功是常态（写接口最容易撞风控），所以这两层分开回：
 * sub 是已经落库的结果，notice 是「还差一步」的人话，页面照原样显示。
 */
export const SubscriptionResultSchema = z.object({
  sub: SubscriptionSchema,
  notice: z.string().nullable(),
})
export type SubscriptionResult = z.infer<typeof SubscriptionResultSchema>

/** 三个开关，缺省表示不改。 */
export const PatchSubscriptionRequestSchema = z.object({
  enableDynamic: z.boolean().optional(),
  enableVideo: z.boolean().optional(),
  enableAi: z.boolean().optional(),
})
export type PatchSubscriptionRequest = z.infer<typeof PatchSubscriptionRequestSchema>

/** 更新流的查询串。被过滤的默认也列出来（灰显），filtered=0 才只看通过的。 */
export const UpdatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  uid: z.string().optional(),
  before: z.coerce.number().int().optional(),
  filtered: z.enum(['0', '1']).default('1'),
})
export type UpdatesQuery = z.infer<typeof UpdatesQuerySchema>

export const UpdatesResponseSchema = z.object({
  updates: z.array(UpdateSchema),
  /** uid → 昵称头像，页面要显示是谁发的。 */
  ups: z.record(z.string(), z.object({ name: z.string(), face: z.string().nullable() })),
})
export type UpdatesResponse = z.infer<typeof UpdatesResponseSchema>

export const PollResultSchema = z.object({
  ok: z.boolean(),
  /** 真正新入库的条数。 */
  found: z.number().int().min(0),
  /** 已经在库里的（重复轮询的正常结果）。 */
  skipped: z.number().int().min(0),
  blocked: z.number().int().min(0),
  /** 跳过或失败的人话原因；正常跑完是 null。 */
  reason: z.string().nullable(),
})
export type PollResult = z.infer<typeof PollResultSchema>

export const JobsResponseSchema = z.object({
  jobs: z.array(SummaryJobSchema),
  /** bvid → 标题链接，页面要显示是哪个视频而不是一串 BV 号。 */
  videos: z.record(z.string(), z.object({ title: z.string(), url: z.string() })),
})
export type JobsResponse = z.infer<typeof JobsResponseSchema>

export const RulesResponseSchema = z.object({
  rules: z.array(FilterRuleSchema),
  /** 规则 id → 正则超时次数。只列有过超时的。 */
  timeouts: z.record(z.string(), z.number().int()),
})
export type RulesResponse = z.infer<typeof RulesResponseSchema>

export const AddRuleRequestSchema = z.object({
  scope: RuleScopeSchema,
  kind: RuleKindSchema,
  pattern: z.string().min(1),
  enabled: z.boolean().default(true),
})
export type AddRuleRequest = z.infer<typeof AddRuleRequestSchema>

export const PatchRuleRequestSchema = z.object({ enabled: z.boolean() })
export type PatchRuleRequest = z.infer<typeof PatchRuleRequestSchema>

/** 样本测试框的入参。uid 为空表示只用全局规则试。 */
export const TestRulesRequestSchema = z.object({
  sample: z.string().min(1),
  uid: z.string().nullable().default(null),
})
export type TestRulesRequest = z.infer<typeof TestRulesRequestSchema>

export const TestRulesResponseSchema = z.object({
  hits: z.array(z.object({ id: z.number().int(), label: z.string(), timedOut: z.boolean() })),
  verdict: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pass') }),
    z.object({ kind: z.literal('blocked'), reason: z.string() }),
    z.object({ kind: z.literal('held'), reason: z.string() }),
  ]),
  /** 实际生效的那套规则，页面据此显示「per-UP 覆盖了全局」。 */
  used: z.array(FilterRuleSchema),
})
export type TestRulesResponse = z.infer<typeof TestRulesResponseSchema>

/** apiKey 在响应里的唯一形态。明文永远不出服务端。 */
export const SecretStateSchema = z.object({
  configured: z.boolean(),
  /** 形如 `sk-1****9abc`；没配是 null。 */
  masked: z.string().nullable(),
  updatedAt: z.number().int().nullable(),
})
export type SecretState = z.infer<typeof SecretStateSchema>

export const AiSettingsResponseSchema = z.object({
  ai: AiConfigSchema,
  asr: AsrConfigSchema,
  llmKey: SecretStateSchema,
  asrKey: SecretStateSchema,
})
export type AiSettingsResponse = z.infer<typeof AiSettingsResponseSchema>

/**
 * apiKey 的三态由值本身表达：缺省或空串 = 不修改，null = 清空，其余 = 写新值。
 * 「空串等于不修改」是因为表单只写不读 —— 用户没动那个框时它就是空的。
 */
export const PatchAiSettingsRequestSchema = z.object({
  ai: AiConfigSchema.partial().optional(),
  asr: AsrConfigSchema.partial().optional(),
  llmApiKey: z.string().nullable().optional(),
  asrApiKey: z.string().nullable().optional(),
})
export type PatchAiSettingsRequest = z.infer<typeof PatchAiSettingsRequestSchema>

export const AiTestResponseSchema = z.object({ llm: ProbeResultSchema, asr: ProbeResultSchema })
export type AiTestResponse = z.infer<typeof AiTestResponseSchema>

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** zod 校验失败时的逐字段问题，没有就是 null。 */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
  }),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
