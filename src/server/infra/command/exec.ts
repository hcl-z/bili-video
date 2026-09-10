import { execFile } from 'node:child_process'

import type { CommandResult, CommandRunner, RunOptions } from '../../types/platform.ts'


const PROBE_TIMEOUT_MS = 5_000

const RUN_TIMEOUT_MS = 15 * 60_000
/** yt-dlp 正常输出就有几十 KB，默认 1MB 不够长视频的进度行 */
const MAX_BUFFER = 8 * 1024 * 1024

export class ExecCommandRunner implements CommandRunner {
  async probe(bin: string, args: string[]): Promise<{ found: boolean; detail: string }> {
    return await new Promise((resolve) => {
      // 不走 shell：bin 与 args 直接进 execve，用户填进配置的字符串拼不出命令注入
      execFile(bin, args, { timeout: PROBE_TIMEOUT_MS, shell: false }, (err, stdout, stderr) => {
        if (err === null) return resolve({ found: true, detail: firstLine(stdout || stderr) })
        // ENOENT = PATH 上没有；其它错（非 0 退出、超时）说明它在，只是这次没跑通
        const code = (err as NodeJS.ErrnoException).code
        resolve({
          found: code !== 'ENOENT',
          detail: firstLine(stderr) || err.message,
        })
      })
    })
  }

  async run(bin: string, args: string[], opts: RunOptions = {}): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS,
          signal: opts.signal,
          shell: false,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err === null) return resolve({ code: 0, stdout, stderr, timedOut: false })
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }

          if (e.code === 'ENOENT') return reject(new Error(`${bin} 不在 PATH 上`))
          resolve({
            code: typeof e.code === 'number' ? e.code : null,
            stdout,
            stderr: stderr || err.message,
            timedOut: e.killed === true,
          })
        },
      )
    })
  }
}

const firstLine = (s: string): string => s.split('\n')[0]?.trim() ?? ''
