import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'

import type { AsrConfig } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'
import type { Asr } from '../../ports/asr.ts'
import type { Logger } from '../../ports/logger.ts'
import { joinUrl } from '../ai/openai-compat.ts'
import { maskSecret } from '../secret/secret-box.ts'
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
    const file = await openAsBlob(audioPath)
    const language = opts.language ?? cfg.language
    form.set('file', file, basename(audioPath))
    form.set('model', cfg.model)
    form.set('language', language)
    form.set('response_format', 'verbose_json')

    const key = this.deps.apiKey()
    const url = joinUrl(cfg.baseURL, '/audio/transcriptions')
    // 云端转写最常见的坑是 baseURL 拼错、model 名不对、语言码不认，所以把送出去的
    // 每个字段原样记一遍（key 只记掩码）。对着日志比对文档就能定位。
    this.deps.logger.info(
      {
        url,
        method: 'POST',
        baseURL: cfg.baseURL,
        fields: { model: cfg.model, language, response_format: 'verbose_json' },
        file: { name: basename(audioPath), path: audioPath, bytes: file.size, type: file.type },
        authorization: key === null ? '(没有 apiKey)' : `Bearer ${maskSecret(key)}`,
        timeoutMs: opts.signal === undefined ? TIMEOUT_MS : null,
      },
      '云端转写请求',
    )

    let res: Response
    try {
      res = await this.deps.fetch(url, {
        method: 'POST',
        headers: key === null ? {} : { authorization: `Bearer ${key}` },
        body: form,
        signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      // 连不上、DNS 不对、超时都走这里，日志里要能看出是打哪个地址失败的。
      this.deps.logger.warn({ url, err: String(err) }, '云端转写请求没成功发出')
      throw err
    }
    const body = await res.text()
    if (!res.ok) {
      // 对方的原话最有用，别截短到看不出是哪个字段被拒了。
      this.deps.logger.warn(
        {
          url,
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get('content-type'),
          body: body.slice(0, 2000),
        },
        '云端转写被拒',
      )
      throw new Error(`转写接口 HTTP ${res.status}：${body.slice(0, 300)}`)
    }

    const cues = parseWhisperJson(JSON.parse(body))
    this.deps.logger.info({ cues: cues.length, model: cfg.model }, '云端转写完成')
    return cues
  }
}
