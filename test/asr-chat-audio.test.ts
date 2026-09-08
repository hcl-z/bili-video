import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { ChatAudioAsr } from '../src/server/infra/asr/chat-audio.ts'
import type { CommandResult, CommandRunner } from '../src/server/ports/command.ts'
import { FakeFetch } from './fakes/bili-fetch.ts'
import { CollectingLogger } from './fakes/logger.ts'

/** chat-audio 那类接口：音频塞进 chat，回来只有文字，时间戳靠切段补出来。 */

const CFG = {
  provider: 'chat-audio' as const,
  baseURL: 'https://llm.test/v1',
  model: 'asr-1',
  language: 'zh',
  concurrency: 1 as const,
  segmentSec: 120,
}

/** 假 ffmpeg：不真转码，按段数在输出目录里造几个文件。 */
function fakeFfmpeg(parts: number): CommandRunner {
  return {
    probe: async () => ({ found: true, detail: 'fake' }),
    run: async (_bin, args): Promise<CommandResult> => {
      const pattern = args[args.length - 1]!
      const dir = pattern.slice(0, pattern.lastIndexOf('/'))
      for (let i = 0; i < parts; i += 1) {
        await writeFile(join(dir, `part-000${i}.mp3`), `fake-audio-${i}`)
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
}

const reply = (text: string) => ({ raw: { choices: [{ message: { content: text } }] } })

describe('chat-audio 转写', () => {
  it('逐段送出去，段序号变成时间戳，请求体是 input_audio 的 data URL', async () => {
    const fetch = new FakeFetch().on('/chat/completions', (_req, hit) => reply(`第 ${hit} 段的内容`))
    const asr = new ChatAudioAsr({
      fetch: fetch.fetch,
      commands: fakeFfmpeg(3),
      logger: new CollectingLogger(),
      config: () => CFG,
      apiKey: () => 'sk-test-key-value',
    })

    const dir = await mkdtemp(join(tmpdir(), 'asr-test-'))
    const audio = join(dir, 'BV1x.m4a')
    await writeFile(audio, 'not really audio')

    const cues = await asr.transcribe(audio)

    assert.equal(cues.length, 3)
    assert.deepEqual(
      cues.map((c) => [c.from, c.to, c.text]),
      [
        [0, 120, '第 0 段的内容'],
        [120, 240, '第 1 段的内容'],
        [240, 360, '第 2 段的内容'],
      ],
    )

    const body = JSON.parse(fetch.requests[0]?.body ?? '{}') as {
      model: string
      asr_options: { language: string }
      messages: Array<{ content: Array<{ type: string; input_audio: { data: string } }> }>
    }
    assert.equal(body.model, 'asr-1')
    assert.equal(body.asr_options.language, 'zh')
    assert.equal(body.messages[0]?.content[0]?.type, 'input_audio')
    assert.match(body.messages[0]?.content[0]?.input_audio.data ?? '', /^data:audio\/mpeg;base64,/)
    assert.equal(fetch.requests[0]?.headers['authorization'], 'Bearer sk-test-key-value')

    // 切段的临时目录跑完就删。
    assert.equal((await readdir(tmpdir())).some((f) => f.startsWith('bili-asr-')), false)
  })

  it('对方回 4xx 时抛错，让降级链退到下一级', async () => {
    const fetch = new FakeFetch().on('/chat/completions', {
      status: 404,
      raw: '<html>404 Not Found</html>',
    })
    const asr = new ChatAudioAsr({
      fetch: fetch.fetch,
      commands: fakeFfmpeg(1),
      logger: new CollectingLogger(),
      config: () => CFG,
      apiKey: () => null,
    })

    const dir = await mkdtemp(join(tmpdir(), 'asr-test-'))
    const audio = join(dir, 'BV1y.m4a')
    await writeFile(audio, 'not really audio')

    await assert.rejects(() => asr.transcribe(audio), /HTTP 404/)
  })
})
