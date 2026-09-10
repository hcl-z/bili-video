import type { AsrConfig } from '#shared/contract/config.ts'
import type { Result } from '#shared/contract/failure.ts'
import type { ProbeResult } from '#shared/contract/probe.ts'
import type { Cue } from '#shared/contract/summary.ts'


export interface Asr {
  readonly provider: AsrConfig['provider']
  transcribe(audioPath: string, opts?: { language?: string; signal?: AbortSignal }): Promise<Cue[]>
}

/** yt-dlp 子进程。匿名请求会 412，必须带登录 cookie */
export interface AudioDownloader {
  download(bvid: string, opts?: { signal?: AbortSignal }): Promise<DownloadedAudio>

  cleanup(path: string): Promise<void>
  sweepOrphans(olderThanMs: number): Promise<number>
}

export interface DownloadedAudio {
  path: string
  bytes: number
  durationSec: number | null
}

/** OpenAI 兼容的一组 baseURL + apiKey + model 即可，不引任何 AI SDK */
export interface Llm {
  /** 失败是值，不是异常 —— 和其它出网边界一样，调用方要穷举 FailureKind */
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<Result<LlmCompletion>>
  /** AI 配置页的连通性测试。发一次最小请求，失败要明确说明卡在哪一步 */
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

  usage: { model: string; inTokens: number; outTokens: number; ms: number }
}
