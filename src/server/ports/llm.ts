import type { Result } from '#shared/contract/failure.ts'
import type { ProbeResult } from '#shared/contract/probe.ts'

/** OpenAI 兼容的一组 baseURL + apiKey + model 即可，不引任何 AI SDK。 */
export interface Llm {
  /** 失败是值，不是异常 —— 和其它出网端口一样，调用方要穷举 FailureKind。 */
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<Result<LlmCompletion>>
  /** AI 配置页的连通性测试。发一次最小请求，失败要说清卡在哪一步。 */
  ping(): Promise<ProbeResult>
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface LlmCompletion {
  text: string
  /** 只记账不拦截：分段总结会调多次，逐次记才准。 */
  usage: { model: string; inTokens: number; outTokens: number; ms: number }
}
