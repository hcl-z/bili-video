import type { Failure } from '#shared/contract/failure.ts'
import { classifyProbe } from './ai-probe.ts'

/**
 * LLM 的失败分类。和 bili-error.ts 同一个思路，只是这边只有 HTTP 状态码可看。
 *
 * 关键是可重试性：鉴权错、模型名错、参数错重试一万次都一样，只有限流和 5xx 值得再来一次。
 */
export function llmFailure(status: number, body: string): Failure {
  const { detail } = classifyProbe(status, body)
  const kind = status === 429 ? 'rate-limit' : status >= 500 ? 'transient' : 'fatal'
  return { kind, code: null, message: detail, retryAfterMs: null }
}

/** 连不上、超时，或回来的形状对不上：都当抖动，重试有意义。 */
export function llmTransient(err: unknown): Failure {
  return {
    kind: 'transient',
    code: null,
    message: err instanceof Error ? err.message : String(err),
    retryAfterMs: null,
  }
}
