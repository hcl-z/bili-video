import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { AsrConfig } from '#shared/contract/config.ts'
import type { Cue } from '#shared/contract/summary.ts'
import type { Asr } from '../../ports/asr.ts'
import type { CommandRunner } from '../../ports/command.ts'
import type { Logger } from '../../ports/logger.ts'
import { tail } from '../command/tail.ts'
import { parseWhisperJson } from './whisper-json.ts'

export interface MlxWhisperDeps {
  commands: CommandRunner
  logger: Logger
  config: () => AsrConfig
  bin?: string
}

const TIMEOUT_MS = 60 * 60_000

/**
 * 本机 mlx-whisper（Apple Silicon 上跑 Metal）。
 *
 * 它只会把结果写成文件，不往 stdout 吐 JSON，所以每次给一个临时目录、读回来、删掉。
 * 参数名按 `mlx_whisper --help`：这台机器上没装，等真装上跑一次可能要对。
 */
export class MlxWhisperAsr implements Asr {
  readonly provider = 'mlx-whisper' as const
  private readonly deps: MlxWhisperDeps

  constructor(deps: MlxWhisperDeps) {
    this.deps = deps
  }

  async transcribe(audioPath: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<Cue[]> {
    const cfg = this.deps.config()
    const outDir = await mkdtemp(join(tmpdir(), 'bili-asr-'))
    try {
      const res = await this.deps.commands.run(
        this.deps.bin ?? 'mlx_whisper',
        [
          audioPath,
          '--model',
          cfg.model,
          '--language',
          opts.language ?? cfg.language,
          '--output-dir',
          outDir,
          '--output-format',
          'json',
        ],
        { timeoutMs: TIMEOUT_MS, signal: opts.signal },
      )
      if (res.code !== 0) {
        throw new Error(`mlx_whisper 退出码 ${res.code ?? '(被杀)'}：${tail(res.stderr || res.stdout)}`)
      }
      const name = basename(audioPath).replace(/\.[^.]+$/, '')
      const raw = await readFile(join(outDir, `${name}.json`), 'utf8')
      const cues = parseWhisperJson(JSON.parse(raw))
      this.deps.logger.info({ cues: cues.length, model: cfg.model }, '本地转写完成')
      return cues
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }
}

