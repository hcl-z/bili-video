import type { ProbeResult, ProbeStage } from '#shared/contract/probe.ts'

/**
 * 连通性测试的失败分级。纯函数：给一个 HTTP 状态码和响应体，答「卡在哪一步」。
 *
 * 分级本身就是这一票的价值 —— 「测试失败」这四个字对排查毫无帮助，
 * 而「连上了但 model 不存在」直接指向要改哪个框。
 */
export function classifyProbe(status: number, body: string): { stage: ProbeStage; detail: string } {
  const msg = summarize(body)
  // 状态码一路带上：429 和 5xx 都落在 unknown 里，只有它能让人分清限流和上游炸了。
  const detail = msg === null ? `HTTP ${status}` : `HTTP ${status}：${msg}`
  if (status === 401 || status === 403) return { stage: 'auth', detail }
  // 404 在 OpenAI 兼容实现里既可能是「模型不存在」也可能是「baseURL 少了 /v1」，
  // 所以要看正文措辞，不能只看状态码。
  if (status === 404) {
    return { stage: /model/i.test(body) ? 'model' : 'network', detail }
  }
  if (status === 400 && /model/i.test(body)) return { stage: 'model', detail }
  return { stage: 'unknown', detail }
}

export function probeOk(ms: number): ProbeResult {
  return { ok: true, ms, stage: null, detail: null }
}

/** fetch 抛出来的都是连不上：DNS、超时、拒绝连接、证书。 */
export function networkProbe(err: unknown, ms: number): ProbeResult {
  return {
    ok: false,
    ms,
    stage: 'network',
    detail: err instanceof Error ? err.message : String(err),
  }
}

/** 还没配到能发请求的程度。missing 是缺的那样东西，直接进给人看的那句话。 */
export function notConfigured(missing: string): ProbeResult {
  return { ok: false, ms: 0, stage: 'not-configured', detail: `还没配 ${missing}` }
}

/** OpenAI 兼容的错误体是 `{error:{message}}`，但各家实现都在偏航，所以两条路都试。 */
function summarize(body: string): string | null {
  const trimmed = body.trim()
  if (trimmed === '') return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null) {
      const err = (parsed as { error?: unknown }).error
      if (typeof err === 'string') return err
      if (typeof err === 'object' && err !== null) {
        const msg = (err as { message?: unknown }).message
        if (typeof msg === 'string' && msg !== '') return msg
      }
      const msg = (parsed as { message?: unknown }).message
      if (typeof msg === 'string' && msg !== '') return msg
    }
  } catch {
    // 不是 JSON，原文截一段就够了。
  }
  return trimmed.slice(0, 200)
}
