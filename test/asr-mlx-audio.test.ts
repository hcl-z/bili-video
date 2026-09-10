import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { AsrConfig } from '#shared/contract/config.ts'
import { MlxAudioAsr } from '../src/server/infra/asr/mlx-audio.ts'
import type { CommandRunner } from '../src/server/types/platform.ts'
import { CollectingLogger } from './fakes/logger.ts'

const config: AsrConfig = {
  provider: 'mlx-audio',
  baseURL: '',
  model: 'mlx-community/Qwen3-ASR-0.6B-4bit',
  language: 'Chinese',
  useOfficialSubtitles: true,
  concurrency: 1,
  segmentSec: 120,
}

describe('mlx-audio 转写', () => {
  it('通过 Python 模块生成 JSON，并把语言码转换成 Qwen3-ASR 名称', async () => {
    const seen: { bin?: string; args?: string[] } = {}
    const commands: CommandRunner = {
      probe: async () => ({ found: true, detail: '' }),
      run: async (bin, args) => {
        seen.bin = bin
        seen.args = args
        const output = args[args.indexOf('--output-path') + 1]!
        await writeFile(
          `${output}.json`,
          JSON.stringify({ text: '你好', segments: [{ start: 0, end: 2.5, text: '你好' }] }),
        )
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      },
    }
    const dir = await mkdtemp(join(tmpdir(), 'mlx-audio-test-'))
    const audio = join(dir, 'sample.m4a')
    await writeFile(audio, 'fake')

    try {
      const asr = new MlxAudioAsr({ commands, logger: new CollectingLogger(), config: () => config })
      const cues = await asr.transcribe(audio, { language: 'zh' })

      assert.equal(seen.bin, 'python3')
      assert.deepEqual(seen.args?.slice(0, 2), ['-m', 'mlx_audio.stt.generate'])
      assert.equal(seen.args?.[seen.args.indexOf('--language') + 1], 'Chinese')
      assert.equal(seen.args?.[seen.args.indexOf('--format') + 1], 'json')
      assert.equal(seen.args?.[seen.args.indexOf('--max-tokens') + 1], '65536')
      assert.deepEqual(cues, [{ from: 0, to: 2.5, text: '你好' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
