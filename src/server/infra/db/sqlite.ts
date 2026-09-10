import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Node 24 内置 node:sqlite —— 零原生编译，镜像干净（放弃 better-sqlite3 就是为这个）。 它是同步 API，所以整个仓储层也是同步的，不假装有异步边界 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL：读写不互相阻塞。单进程单用户下这几条足够，不需要连接池
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/** SQLite 没有布尔类型，边界上统一转 0/1，不让 0/1 漏进业务代码 */
export const toInt = (b: boolean): number => (b ? 1 : 0)
export const toBool = (n: unknown): boolean => n === 1 || n === 1n || n === true


export type Row = Record<string, unknown>

export const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new TypeError(`expected string, got ${typeof v}`)
  return v
}
export const num = (v: unknown): number => {
  if (typeof v === 'bigint') return Number(v)
  if (typeof v !== 'number') throw new TypeError(`expected number, got ${typeof v}`)
  return v
}
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v))
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v))
