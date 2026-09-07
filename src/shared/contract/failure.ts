import { z } from 'zod'

/**
 * 失败显式分类。调用方必须穷举这几种，禁止裸 catch{}。
 *
 * - auth-lost    登录态没了（-101）。停 cron 等重登，不盲重试。
 * - risk-control 风控（-352 / -403）。非终态：清 WBI key 重取 ticket 重试一次，再退避。
 * - rate-limit   限流（-509）。退避后重试。
 * - transient    网络抖动、5xx、超时。可重试。
 * - fatal        参数错、目标不存在等，重试不会变好。
 *
 * 类型放在 shared 而不是 domain，是因为工作台要把它显示出来；
 * 「错误码 → 分类」的映射函数在 domain/bili-error.ts。
 */
export const FailureKindSchema = z.enum([
  'auth-lost',
  'risk-control',
  'rate-limit',
  'transient',
  'fatal',
])
export type FailureKind = z.infer<typeof FailureKindSchema>

export const FailureSchema = z.object({
  kind: FailureKindSchema,
  /** B 站返回的 code，非 B 站来源为 null。 */
  code: z.number().int().nullable(),
  message: z.string(),
  /** 建议的退避毫秒数；null 表示由调用方决定。 */
  retryAfterMs: z.number().int().min(0).nullable(),
})
export type Failure = z.infer<typeof FailureSchema>

/** 结果类型。成功/失败都是值，不靠异常传递可预期的失败。 */
export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = <T = never>(failure: Failure): Result<T> => ({ ok: false, failure })
