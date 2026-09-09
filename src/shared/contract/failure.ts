import { z } from 'zod'

/**
 * 失败必须显式穷举，禁止裸 catch{}。
 * - auth-lost：登录态失效（-101），停止 cron 等待重登，不盲重试。
 * - risk-control：风控（-352 / -403），清 WBI key、重取 ticket 重试一次后退避。
 * - rate-limit：限流（-509），退避后重试。
 * - transient：网络抖动、5xx 或超时，可重试。
 * - fatal：参数错误、目标不存在等，重试无效。
 * 类型置于 shared 供工作台显示；错误码映射在 domain/bili-error.ts。
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
