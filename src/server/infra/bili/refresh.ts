import { constants, createPublicKey, publicEncrypt } from 'node:crypto'
import { z } from 'zod'

import { fail, ok, type Result } from '#shared/contract/failure.ts'
import { shapeFailure } from '../../domain/bili-error.ts'

/**
 * cookie 续期链上的两个纯步骤。抽出来单独放，是因为它们是整条链里唯一能被彻底测死的部分：
 * `correspondPath` 可以用本地生成的密钥对验证（解出来必须是 `refresh_<ts>`），
 * `parseRefreshCsrf` 可以用真实页面结构的片段验证。
 *
 * RSA 公钥（PEM）由配置注入，不写死在代码里 —— 它会随 B 站前端发版变化，
 * 而写错的后果是续期永远失败，且失败得很安静。
 */

/** RSA-OAEP(SHA-256) 加密 `refresh_<timestamp>`，输出小写十六进制。 */
export function correspondPath(publicKeyPem: string, timestampMs: number): string {
  if (publicKeyPem.trim() === '') {
    throw new Error('correspond/1 的 RSA 公钥未配置（config.bili.correspondPublicKeyPem）')
  }
  const key = createPublicKey(publicKeyPem)
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`refresh_${timestampMs}`),
  )
  return encrypted.toString('hex')
}

/**
 * 从 correspond 页面里抠出 refresh_csrf。页面结构是 `<div id="1-name">…</div>`。
 *
 * 抠不到就返回 null 让调用方给出明确失败：这里静默返回空串会让下一步带着空 csrf
 * 去请求，换回一个和「续期失败」无关的错误码。
 */
export function parseRefreshCsrf(html: string): string | null {
  const match = /<div\s+id="1-name">\s*([0-9a-zA-Z]+)\s*<\/div>/.exec(html)
  return match?.[1] ?? null
}

const CookieInfoSchema = z.object({
  refresh: z.boolean(),
  /** 上次 cookie 刷新的时间戳（ms），是 correspondPath 的输入。 */
  timestamp: z.number().int().nonnegative().optional(),
})
export type CookieInfo = z.infer<typeof CookieInfoSchema>

export function parseCookieInfo(data: unknown): Result<CookieInfo> {
  const parsed = CookieInfoSchema.safeParse(data)
  return parsed.success ? ok(parsed.data) : fail(shapeFailure('cookie/info', data))
}

const RefreshResultSchema = z.object({
  status: z.number().int(),
  message: z.string().default(''),
  refresh_token: z.string().min(1),
})

/** cookie/refresh 的 data 段。status 非 0 是终态失败：换不出新 token 就只能重新扫码。 */
export function parseRefreshResult(data: unknown): Result<{ refreshToken: string }> {
  const parsed = RefreshResultSchema.safeParse(data)
  if (!parsed.success) return fail(shapeFailure('cookie/refresh', data))
  if (parsed.data.status !== 0) {
    return fail({
      kind: 'fatal',
      code: parsed.data.status,
      message: `cookie/refresh 失败：${parsed.data.message}`,
      retryAfterMs: null,
    })
  }
  return ok({ refreshToken: parsed.data.refresh_token })
}
