/** OpenAI 兼容的一组 baseURL + apiKey + model 即可，不引任何 AI SDK。 */
export interface Llm {
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmCompletion>
  /** AI 配置页的连通性测试。 */
  ping(): Promise<{ ok: boolean; error: string | null; ms: number }>
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
