import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'

import type { AsrConfig } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'
import type { Asr } from '../../ports/asr.ts'
import type { Logger } from '../../ports/logger.ts'
import { joinUrl } from '../ai/openai-compat.ts'
import { parseWhisperJson } from './whisper-json.ts'

export interface OpenAiCompatAsrDeps {
  fetch: typeof fetch
  logger: Logger
  config: () => AsrConfig
  apiKey: () => string | null
}

const TIMEOUT_MS = 30 * 60_000

/** 云端转写。容器里只能走这条（拿不到 Metal）。 */
export class OpenAiCompatAsr implements Asr {
  readonly provider = 'openai-compat' as const
  private readonly deps: OpenAiCompatAsrDeps

  constructor(deps: OpenAiCompatAsrDeps) {
    this.deps = deps
  }

  async transcribe(audioPath: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<Cue[]> {
    const cfg = this.deps.config()
    if (cfg.baseURL.trim() === '') throw new Error('云端转写没配 baseURL')

    const form = new FormData()
    // openAsBlob 是流式的：一小时的音频不会整个读进内存。
    form.set('file', await openAsBlob(audioPath), basename(audioPath))
    form.set('model', cfg.model)
    form.set('language', opts.language ?? cfg.language)
    form.set('response_format', 'verbose_json')

    const key = this.deps.apiKey()
    const res = await this.deps.fetch(joinUrl(cfg.baseURL, '/audio/transcriptions'), {
      method: 'POST',
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`转写接口 HTTP ${res.status}：${body.slice(0, 300)}`)

    const cues = parseWhisperJson(JSON.parse(body))
    this.deps.logger.info({ cues: cues.length, model: cfg.model }, '云端转写完成')
    return cues
  }
}
