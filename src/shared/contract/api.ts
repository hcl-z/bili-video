import { z } from 'zod'
import { AppConfigSchema } from './config.ts'
import { SubscriptionSchema } from './subscription.ts'

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

export const SystemResponseSchema = z.object({
  auth: AuthSnapshotSchema,
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

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** zod 校验失败时的逐字段问题，没有就是 null。 */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
  }),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
