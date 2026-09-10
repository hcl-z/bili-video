import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AsrConfig } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'
import type { Asr } from '../../ports/asr.ts'
import type { CommandRunner } from '../../ports/command.ts'
import type { Logger } from '../../ports/logger.ts'
import { tail } from '../command/tail.ts'
import { parseWhisperJson } from './whisper-json.ts'

export interface MlxAudioDeps {
  commands: CommandRunner
  logger: Logger
  config: () => AsrConfig
  python?: string
}

const TIMEOUT_MS = 60 * 60_000
const MAX_TOKENS = 65_536
const CHUNK_DURATION_SECONDS = 30

export class MlxAudioAsr implements Asr {
  readonly provider = 'mlx-audio' as const
  private readonly deps: MlxAudioDeps

  constructor(deps: MlxAudioDeps) {
    this.deps = deps
  }

  async transcribe(audioPath: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<Cue[]> {
    const cfg = this.deps.config()
    const outDir = await mkdtemp(join(tmpdir(), 'bili-asr-'))
    const outputPath = join(outDir, 'transcript')
    try {
      const res = await this.deps.commands.run(
        this.deps.python ?? 'python3',
        [
          '-m',
          'mlx_audio.stt.generate',
          '--model',
          cfg.model,
          '--audio',
          audioPath,
          '--output-path',
          outputPath,
          '--format',
          'json',
          '--language',
          languageName(opts.language ?? cfg.language),
          '--chunk-duration',
          String(CHUNK_DURATION_SECONDS),
          '--max-tokens',
          String(MAX_TOKENS),
        ],
        { timeoutMs: TIMEOUT_MS, signal: opts.signal },
      )
      if (res.code !== 0) {
        throw new Error(`mlx_audio 退出码 ${res.code ?? '(被杀)'}：${tail(res.stderr || res.stdout)}`)
      }
      const raw = await readFile(`${outputPath}.json`, 'utf8')
      const cues = parseWhisperJson(JSON.parse(raw))
      this.deps.logger.info({ cues: cues.length, model: cfg.model }, '本地转写完成')
      return cues
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  yue: 'Cantonese',
  ja: 'Japanese',
  ko: 'Korean',
}

function languageName(language: string): string {
  return LANGUAGE_NAMES[language.trim().toLowerCase()] ?? language.trim()
}
