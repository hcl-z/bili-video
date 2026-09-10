import type { AiConfig } from '#shared/contract/config.ts'
import type { ProbeResult } from '#shared/contract/probe.ts'
import { fail, ok, type Result } from '#shared/contract/failure.ts'
import { classifyProbe, networkProbe, notConfigured, probeOk } from '../../domain/ai-probe.ts'
import { llmFailure, llmTransient } from '../../domain/llm-error.ts'
import type { Clock } from '../../types/platform.ts'
import type { Llm, LlmCompletion, LlmMessage, LlmOptions } from '../../types/ai.ts'
import type { Logger } from '../../types/platform.ts'
import { failureFields } from '../../log-fields.ts'

export interface OpenAiCompatDeps {
  fetch: typeof fetch
  clock: Clock
  logger: Logger
  /** 用时读：页面上改完 baseURL / model，下一次调用就按新的来，不重启 */
  config: () => AiConfig
  apiKey: () => string | null
}

const PROBE_TIMEOUT_MS = 15_000

export class OpenAiCompatLlm implements Llm {
  private readonly deps: OpenAiCompatDeps
  private readonly logger: Logger

  constructor(deps: OpenAiCompatDeps) {
    this.deps = deps
    this.logger = deps.logger.child({ mod: 'llm' })
  }

  async complete(messages: LlmMessage[], opts: LlmOptions = {}): Promise<Result<LlmCompletion>> {
    const cfg = this.deps.config()
    const model = opts.model ?? cfg.model
    const started = this.deps.clock.now()

    try {
      const res = await this.post(
        '/chat/completions',
        {
          model,
          messages,
          temperature: opts.temperature ?? cfg.temperature,
          ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
        },
        cfg.timeoutMs,
        opts.signal,
      )
      const body = await res.text()
      if (!res.ok) {
        const failure = llmFailure(res.status, body)
        this.logger.warn(failureFields(failure), 'LLM 调用失败')
        return fail(failure)
      }

      const parsed = parseCompletion(body)
      const ms = this.deps.clock.now() - started
      return ok({
        text: parsed.text,
        usage: { model, inTokens: parsed.inTokens, outTokens: parsed.outTokens, ms },
      })
    } catch (err) {
      return fail(llmTransient(err))
    }
  }

  /** 最小请求：`max_tokens: 1` 的一次 chat/completions。 不用 `/models` 列表 —— 它过得去不代表指定的 model 能用（很多兼容实现的 /models 是写死的单个表），而「model 不存在」正是要区分出来的三种失败之一 */
  async ping(): Promise<ProbeResult> {
    const cfg = this.deps.config()
    if (cfg.baseURL.trim() === '') return notConfigured('baseURL')
    if (cfg.model.trim() === '') return notConfigured('模型名')

    const started = this.deps.clock.now()
    try {
      const res = await this.post(
        '/chat/completions',
        { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        PROBE_TIMEOUT_MS,
      )
      const body = await res.text()
      const ms = this.deps.clock.now() - started
      if (res.ok) return probeOk(ms)
      const { stage, detail } = classifyProbe(res.status, body)
      this.logger.warn({ stage, detail }, 'LLM 连通性测试失败')
      return { ok: false, ms, stage, detail }
    } catch (err) {
      return networkProbe(err, this.deps.clock.now() - started)
    }
  }

  private async post(
    path: string,
    payload: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const key = this.deps.apiKey()
    return await this.deps.fetch(joinUrl(this.deps.config().baseURL, path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
  }
}

/** 用户填 baseURL 时带不带尾斜杠都得能用。 */
export function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}${path}`
}

function parseCompletion(body: string): { text: string; inTokens: number; outTokens: number } {
  const parsed: unknown = JSON.parse(body)
  const obj = parsed as {
    choices?: Array<{ message?: { content?: unknown } }>
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  const content = obj.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error(`LLM 回的形状不对：${body.slice(0, 200)}`)
  }
  return {
    text: content,
    inTokens: intOr0(obj.usage?.prompt_tokens),
    outTokens: intOr0(obj.usage?.completion_tokens),
  }
}

const intOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
