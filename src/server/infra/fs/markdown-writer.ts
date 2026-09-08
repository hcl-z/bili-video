import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

import type { MarkdownWriter } from '../../ports/markdown.ts'

export interface FsMarkdownDeps {
  /** 数据目录。配置里的相对路径按它解析。 */
  dataDir: string
  /** 用时读：页面上改完目录，下一篇就落到新地方。 */
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
    // basename：目录来自配置，文件名来自 bvid，但穿越路径的代价太大，不赌。
    const path = join(dir, basename(name))
    // 先写临时文件再 rename：写一半被打断不会留下半份文件，重跑覆盖也是原子的。
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
