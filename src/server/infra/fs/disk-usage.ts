import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type { DiskUsage, StorageStats } from '../../ports/storage.ts'

export interface FsStorageDeps {
  dataDir: string
  dbFile: string
  audioDir: string
  /** 用时读：落盘目录是配置项，改完这里就该报新目录的占用。 */
  markdownDir: () => string
}

export class FsStorageStats implements StorageStats {
  private readonly deps: FsStorageDeps

  constructor(deps: FsStorageDeps) {
    this.deps = deps
  }

  async usage(): Promise<DiskUsage> {
    const db = this.deps.dbFile
    const audioDir = this.deps.audioDir
    const markdownDir = this.resolveMarkdownDir()
    // WAL 模式下未 checkpoint 的写入全在 -wal 里，只 stat 主文件会少算一大截。
    const [main, wal, shm, audioBytes, markdownBytes] = await Promise.all([
      fileSize(db),
      fileSize(`${db}-wal`),
      fileSize(`${db}-shm`),
      dirSize(audioDir),
      dirSize(markdownDir),
    ])

    return {
      dbBytes: main + wal + shm,
      audioBytes,
      markdownBytes,
      audioDir,
      markdownDir,
    }
  }

  private resolveMarkdownDir(): string {
    const dir = this.deps.markdownDir()
    return isAbsolute(dir) ? dir : resolve(this.deps.dataDir, dir)
  }
}

/** 目录不存在算 0：还没写过一篇总结不是错误。 */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? await dirSize(path) : await fileSize(path)
  }
  return total
}
