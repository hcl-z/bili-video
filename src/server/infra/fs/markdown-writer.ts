import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

import type { MarkdownWriter } from '../../types/delivery.ts'

export interface FsMarkdownDeps {

  dataDir: string

  dir: () => string
}

export class FsMarkdownWriter implements MarkdownWriter {
  private readonly deps: FsMarkdownDeps

  constructor(deps: FsMarkdownDeps) {
    this.deps = deps
  }

  async write(name: string, content: string): Promise<string> {
    const dir = this.resolveDir()
    await mkdir(dir, { recursive: true })

    const path = join(dir, basename(name))
    // 先写临时文件再 rename：写半数被打断不会留下半份文件，重跑覆盖也是原子的
    const tmp = `${path}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
    return path
  }

  private resolveDir(): string {
    const dir = this.deps.dir()
    return isAbsolute(dir) ? dir : resolve(this.deps.dataDir, dir)
  }
}
