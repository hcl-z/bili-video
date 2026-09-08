import { ZodError } from 'zod'

import type { Failure } from '#shared/contract/failure.ts'
import { errorBody, zodIssues } from './errors.ts'

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; body: ReturnType<typeof errorBody> }

/** zod 在 HTTP 边界跑完，穿过去就是确定类型（「Parse, don't validate」的三处边界之一）。 */
export async function parseBody<T>(
  req: Request,
  schema: { parse(v: unknown): T },
): Promise<ParseResult<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, body: errorBody('invalid-request', '请求体必须是 JSON') }
  }
  try {
    return { ok: true, value: schema.parse(raw) }
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, body: errorBody('invalid-request', '入参校验失败', zodIssues(err)) }
    }
    throw err
  }
}

/** 失败分类 → HTTP 状态。分类是业务概念，状态码只是它在 HTTP 上的投影。 */
export function statusOf(f: Failure): 400 | 401 | 429 | 502 {
  switch (f.kind) {
    case 'fatal':
      return 400
    case 'auth-lost':
      return 401
    case 'rate-limit':
    case 'risk-control':
      return 429
    case 'transient':
      return 502
  }
}
