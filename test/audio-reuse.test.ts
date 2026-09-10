import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { YtDlpDownloader } from '../src/server/infra/audio/yt-dlp.ts'
import type { CommandResult, CommandRunner } from '../src/server/types/platform.ts'
import { FakeClock } from './fakes/clock.ts'
import { CollectingLogger } from './fakes/logger.ts'

class SpyCommands implements CommandRunner {
  runs = 0
  private readonly onRun: (dir: string) => Promise<void>

  constructor(onRun: (dir: string) => Promise<void>) {
    this.onRun = onRun
  }

  async probe(): Promise<{ found: boolean; detail: string }> {
    return { found: true, detail: 'fake' }
  }

  async run(_bin: string, args: string[]): Promise<CommandResult> {
    this.runs += 1
    const out = args[args.indexOf('-o') + 1]!
    await this.onRun(out.slice(0, out.lastIndexOf('/')))
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
}

const cookies = {
  names: () => ['SESSDATA'],
  get: () => 'x',
  earliestExpiry: () => null,
}

async function downloader(dir: string, commands: CommandRunner) {
  return new YtDlpDownloader({
    commands,

    cookies: cookies as never,
    clock: new FakeClock(1_000),
    logger: new CollectingLogger(),
    dir,
    identity: { userAgent: 'UA', buvid3: 'b3', buvid4: 'b4' } as never,
  })
}

describe('音频下载', () => {
  it('本地已有可用音频就跳过下载，直接返回那一份', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-test-'))
    const big = 'x'.repeat(200 * 1024)
    const commands = new SpyCommands(async (out) => {
      await writeFile(join(out, 'BV1x.m4a'), big)
    })
    const dl = await downloader(dir, commands)

    const first = await dl.download('BV1x')
    assert.equal(commands.runs, 1)
    assert.equal(first.bytes, big.length)

    // 第二次：文件还在，yt-dlp 一次都不应跑
    const second = await dl.download('BV1x')
    assert.equal(commands.runs, 1)
    assert.equal(second.path, first.path)

    // cookie 文件是一次性的，两次都不留在盘上
    assert.deepEqual(await readdir(dir), ['BV1x.m4a'])
    await rm(dir, { recursive: true, force: true })
  })

  it('半截文件不算数：删掉重下', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-test-'))
    await writeFile(join(dir, 'BV1y.m4a'), 'truncated')
    const commands = new SpyCommands(async (out) => {
      await writeFile(join(out, 'BV1y.m4a'), 'x'.repeat(200 * 1024))
    })
    const dl = await downloader(dir, commands)

    const got = await dl.download('BV1y')
    assert.equal(commands.runs, 1)
    assert.equal(got.bytes, 200 * 1024)
    await rm(dir, { recursive: true, force: true })
  })
})
