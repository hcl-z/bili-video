import { readFile, rm } from 'node:fs/promises'

import type { AsrConfig } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'
import type { Asr } from '../../ports/asr.ts'
import type { CommandRunner } from '../../ports/command.ts'
import type { Logger } from '../../ports/logger.ts'
import { joinUrl } from '../ai/openai-compat.ts'
import { maskSecret } from '../secret/secret-box.ts'
import { splitAudio } from './audio-split.ts'

export interface ChatAudioAsrDeps {
  fetch: typeof fetch
  commands: CommandRunner
  logger: Logger
  config: () => AsrConfig
  apiKey: () => string | null
}

const TIMEOUT_MS = 10 * 60_000

/**
 * 把音频塞进 chat/completions 的那一类转写接口（小米 MiMo、Qwen-Omni 等）。
 *
 * 和 Whisper 那套差两件事：音频是 data URL 塞在消息里，且回来的只有纯文本、没有时间轴。
 * 所以先按固定时长切段，段序号就是时间戳 —— 精度等于段长，但至少章节能落回原视频。
 */
export class ChatAudioAsr implements Asr {
  readonly provider = 'chat-audio' as const
  private readonly deps: ChatAudioAsrDeps

  constructor(deps: ChatAudioAsrDeps) {
    this.deps = deps
  }

  async transcribe(
    audioPath: string,
    opts: { language?: string; signal?: AbortSignal } = {},
  ): Promise<Cue[]> {
    const cfg = this.deps.config()
    if (cfg.baseURL.trim() === '') throw new Error('云端转写没配 baseURL')

    const seg = cfg.segmentSec
    const { dir, files } = await splitAudio(this.deps.commands, audioPath, seg)
    this.deps.logger.info({ parts: files.length, segmentSec: seg }, '音频已切段')

    try {
      const cues: Cue[] = []
      // 顺序跑：这类接口的限流普遍很紧，并发发出去只会换成 429。
      for (const [i, file] of files.entries()) {
        const text = await this.one(file, cfg, opts, i)
        if (text !== '') cues.push({ from: i * seg, to: (i + 1) * seg, text })
      }
      if (cues.length === 0) throw new Error('每一段都没转出文字')
      this.deps.logger.info({ cues: cues.length, model: cfg.model }, '云端转写完成')
      return cues
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async one(
    file: string,
    cfg: AsrConfig,
    opts: { language?: string; signal?: AbortSignal },
    index: number,
  ): Promise<string> {
    const b64 = (await readFile(file)).toString('base64')
    const url = joinUrl(cfg.baseURL, '/chat/completions')
    const key = this.deps.apiKey()
    const body = {
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: `data:audio/mpeg;base64,${b64}` } },
          ],
        },
      ],
      // OpenAI SDK 的 extra_body 就是并进请求体根上的，所以这里直接放平级。
      asr_options: { language: opts.language ?? cfg.language },
      stream: false,
    }

    this.deps.logger.info(
      {
        url,
        part: index,
        model: cfg.model,
        language: body.asr_options.language,
        base64Bytes: b64.length,
        authorization: key === null ? '(没有 apiKey)' : `Bearer ${maskSecret(key)}`,
      },
      '云端转写请求（chat-audio）',
    )

    const res = await this.deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    })
    const raw = await res.text()
    if (!res.ok) {
      this.deps.logger.warn(
        { url, part: index, status: res.status, body: raw.slice(0, 2000) },
        '云端转写被拒（chat-audio）',
      )
      throw new Error(`转写接口 HTTP ${res.status}：${raw.slice(0, 300)}`)
    }
    return pickText(raw)
  }
}

/** 只要 choices[0].message.content。有些实现回数组形状，两种都收。 */
function pickText(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`转写接口回的不是 JSON：${raw.slice(0, 200)}`)
  }
  const choice = (parsed as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'object' && p !== null ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('')
      .trim()
  }
  throw new Error(`转写接口回的形状不对：${raw.slice(0, 200)}`)
}
