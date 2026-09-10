import type { Cue } from '#shared/contract/summary.ts'
import type { Asr } from '../../src/server/ports/asr.ts'
import type { AudioDownloader, DownloadedAudio } from '../../src/server/ports/audio.ts'

/** 音频下载假件。`fails` 为真就模拟下载失败那条路。 */
export class FakeAudioDownloader implements AudioDownloader {
  fails = false
  downloaded: string[] = []
  cleaned: string[] = []
  swept = 0

  async download(bvid: string): Promise<DownloadedAudio> {
    if (this.fails) throw new Error('412 拿不到播放地址')
    this.downloaded.push(bvid)
    return { path: `/tmp/fake/${bvid}.m4a`, bytes: 1024, durationSec: 60 }
  }

  async cleanup(path: string): Promise<void> {
    this.cleaned.push(path)
  }

  async sweepOrphans(): Promise<number> {
    this.swept += 1
    return 0
  }
}

export class FakeAsr implements Asr {
  readonly provider = 'mlx-audio' as const
  cues: Cue[] = [{ from: 0, to: 3, text: '转写出来的第一句' }]
  fails = false
  calls = 0

  async transcribe(): Promise<Cue[]> {
    this.calls += 1
    if (this.fails) throw new Error('模型没加载起来')
    return this.cues
  }
}
