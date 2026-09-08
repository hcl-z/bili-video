import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CommandRunner } from '../../ports/command.ts'
import { tail } from '../command/tail.ts'

/** 转成 16k 单声道 mp3 再切段：语音识别用不上更高的采样率，体积小一个量级。 */
const ARGS = (input: string, segmentSec: number, pattern: string): string[] => [
  '-hide_banner',
  '-nostdin',
  '-i',
  input,
  '-vn',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-b:a',
  '32k',
  '-f',
  'segment',
  '-segment_time',
  String(segmentSec),
  '-reset_timestamps',
  '1',
  pattern,
]

const TIMEOUT_MS = 10 * 60_000

export interface AudioSegments {
  dir: string
  /** 按时间顺序。第 i 段从 i * segmentSec 秒开始。 */
  files: string[]
}

/** 用 ffmpeg 把音频切成等长段。ffmpeg 是 yt-dlp 的依赖，走到这一步它一定在。 */
export async function splitAudio(
  commands: CommandRunner,
  audioPath: string,
  segmentSec: number,
  bin = 'ffmpeg',
): Promise<AudioSegments> {
  const dir = await mkdtemp(join(tmpdir(), 'bili-asr-'))
  const res = await commands.run(bin, ARGS(audioPath, segmentSec, join(dir, 'part-%04d.mp3')), {
    timeoutMs: TIMEOUT_MS,
  })
  if (res.code !== 0) {
    throw new Error(`ffmpeg 切段失败（退出码 ${res.code ?? '(被杀)'}）：${tail(res.stderr)}`)
  }

  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.mp3'))
    .sort()
    .map((f) => join(dir, f))
  if (files.length === 0) throw new Error('ffmpeg 没切出任何音频段')
  return { dir, files }
}
