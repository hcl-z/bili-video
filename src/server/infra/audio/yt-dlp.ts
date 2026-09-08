import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AudioDownloader, DownloadedAudio } from '../../ports/audio.ts'
import type { BrowserIdentity } from '../bili/browser-identity.ts'
import type { Clock } from '../../ports/clock.ts'
import type { CommandRunner } from '../../ports/command.ts'
import type { CookieJar } from '../../ports/cookie-jar.ts'
import type { Logger } from '../../ports/logger.ts'
import { tail } from '../command/tail.ts'

export interface YtDlpDeps {
  commands: CommandRunner
  cookies: CookieJar
  clock: Clock
  logger: Logger
  /** 音频临时目录（绝对路径）。 */
  dir: string
  identity: BrowserIdentity
  bin?: string
}

const TIMEOUT_MS = 20 * 60_000
/** 小于这个就当没下完：一分钟的音频也有几百 KB。 */
const MIN_USABLE_BYTES = 64 * 1024
/** 只留音频，m4a 是 B 站源流的容器，不用转码。 */
const FORMAT = 'bestaudio[ext=m4a]/bestaudio/best'

/**
 * yt-dlp 取音频。
 *
 * 匿名请求 B 站会 412，补 buvid3/Referer/UA 也一样 —— 必须给它登录 cookie。
 * cookie 只能通过文件传（yt-dlp 没有「直接给我一个 Cookie 头」的参数），
 * 所以每次下载都现写一个 0600 的 Netscape 文件，跑完立刻删。
 */
export class YtDlpDownloader implements AudioDownloader {
  private readonly deps: YtDlpDeps

  constructor(deps: YtDlpDeps) {
    this.deps = deps
  }

  async download(bvid: string, opts: { signal?: AbortSignal } = {}): Promise<DownloadedAudio> {
    const { dir } = this.deps
    await mkdir(dir, { recursive: true })

    // 上次失败留下的音频还在就直接用：重跑不必再下一遍，也躲开 yt-dlp 对着
    // 已下完的文件续传时的 416。
    const kept = await this.existing(bvid)
    if (kept !== null) {
      this.deps.logger.info({ bvid, bytes: kept.bytes, path: kept.path }, '音频已在本地，跳过下载')
      return kept
    }

    const cookieFile = join(dir, `${safe(bvid)}.cookies.txt`)
    const url = `https://www.bilibili.com/video/${safe(bvid)}`

    await writeFile(cookieFile, netscapeCookies(this.deps.cookies, this.deps.clock.now()), {
      encoding: 'utf8',
      mode: 0o600,
    })
    try {
      const res = await this.deps.commands.run(
        this.deps.bin ?? 'yt-dlp',
        [
          '--no-playlist',
          '--no-progress',
          '--no-part',
          '-f',
          FORMAT,
          '-x',
          '--audio-format',
          'm4a',
          '--cookies',
          cookieFile,
          '--user-agent',
          this.deps.identity.userAgent,
          '--referer',
          url,
          '-o',
          join(dir, `${safe(bvid)}.%(ext)s`),
          url,
        ],
        { timeoutMs: TIMEOUT_MS, signal: opts.signal },
      )
      if (res.code !== 0) {
        throw new Error(`yt-dlp 退出码 ${res.code ?? '(被杀)'}：${tail(res.stderr || res.stdout)}`)
      }
      const path = await this.findOutput(bvid)
      const info = await stat(path)
      this.deps.logger.info({ bvid, bytes: info.size }, '音频已下载')
      return { path, bytes: info.size, durationSec: null }
    } finally {
      await rm(cookieFile, { force: true })
    }
  }

  async cleanup(path: string): Promise<void> {
    await rm(path, { force: true })
  }

  /**
   * 已经在本地的那份。太小的当没下完 —— 中断的下载留下的半截文件送去转写
   * 只会得到一份缺半截的字幕，那比重下一遍更糟。
   */
  private async existing(bvid: string): Promise<DownloadedAudio | null> {
    let path: string
    try {
      path = await this.findOutput(bvid)
    } catch {
      return null
    }
    const info = await stat(path)
    if (info.size < MIN_USABLE_BYTES) {
      await rm(path, { force: true })
      return null
    }
    return { path, bytes: info.size, durationSec: null }
  }

  /** 启动时扫一遍：失败保留的音频没人删，攒着能把磁盘吃光。 */
  async sweepOrphans(olderThanMs: number): Promise<number> {
    const cutoff = this.deps.clock.now() - olderThanMs
    let names: string[]
    try {
      names = await readdir(this.deps.dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      const path = join(this.deps.dir, name)
      try {
        const info = await stat(path)
        if (!info.isFile() || info.mtimeMs >= cutoff) continue
        await rm(path, { force: true })
        removed += 1
      } catch {
        // 并发删掉了或者读不到，都不值得让启动失败。
      }
    }
    if (removed > 0) this.deps.logger.info({ removed }, '清理了过期的音频临时文件')
    return removed
  }

  /** -x 之后的扩展名不一定是 m4a（转码失败会留原容器），按前缀找。 */
  private async findOutput(bvid: string): Promise<string> {
    const prefix = `${safe(bvid)}.`
    const names = (await readdir(this.deps.dir))
      .filter((n) => n.startsWith(prefix) && !n.endsWith('.cookies.txt'))
      .sort((a, b) => (a.endsWith('.m4a') ? -1 : b.endsWith('.m4a') ? 1 : 0))
    const found = names[0]
    if (found === undefined) throw new Error('yt-dlp 跑完了，但目录里没有音频文件')
    return join(this.deps.dir, found)
  }
}

/** bvid 会拼进路径和 URL，只放白名单字符。 */
const safe = (bvid: string): string => {
  if (!/^[A-Za-z0-9]{3,20}$/.test(bvid)) throw new Error(`bvid 形状不对：${bvid}`)
  return bvid
}


/** Netscape cookie 文件：域、含子域、路径、仅 HTTPS、到期秒、名、值，制表符分隔。 */
function netscapeCookies(jar: CookieJar, now: number): string {
  const expiry = Math.floor((jar.earliestExpiry() ?? now + 30 * 86_400_000) / 1000)
  const lines = ['# Netscape HTTP Cookie File']
  for (const name of jar.names()) {
    const value = jar.get(name)
    if (value === null) continue
    lines.push(['.bilibili.com', 'TRUE', '/', 'TRUE', String(expiry), name, value].join('\t'))
  }
  return `${lines.join('\n')}\n`
}
