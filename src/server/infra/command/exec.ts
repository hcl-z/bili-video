import { execFile } from 'node:child_process'

import type { CommandRunner } from '../../ports/command.ts'

/** 探测不该等：命令在不在 PATH 上，几秒内就该有答案。 */
const TIMEOUT_MS = 5_000

export class ExecCommandRunner implements CommandRunner {
  async probe(bin: string, args: string[]): Promise<{ found: boolean; detail: string }> {
    return await new Promise((resolve) => {
      // 不走 shell：bin 与 args 直接进 execve，用户填进配置的字符串拼不出命令注入。
      execFile(bin, args, { timeout: TIMEOUT_MS, shell: false }, (err, stdout, stderr) => {
        if (err === null) return resolve({ found: true, detail: firstLine(stdout || stderr) })
        // ENOENT = PATH 上没有；其它错（非 0 退出、超时）说明它在，只是这次没跑通。
        const code = (err as NodeJS.ErrnoException).code
        resolve({
          found: code !== 'ENOENT',
          detail: firstLine(stderr) || err.message,
        })
      })
    })
  }
}

const firstLine = (s: string): string => s.split('\n')[0]?.trim() ?? ''
