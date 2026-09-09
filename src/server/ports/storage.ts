/**
 * 磁盘占用。是端口而不是直接 statSync：系统页要显示「库和产物一共吃了多少」，
 * 而这几个路径只有组装根知道 —— 让路由层自己去拼 dataDir 会把布局知识散出去。
 */
export interface StorageStats {
  usage(): Promise<DiskUsage>
}

export interface DiskUsage {
  /** 数据库文件本体加 WAL/SHM —— 它们一起决定「库占了多大」。 */
  dbBytes: number
  audioBytes: number
  markdownBytes: number
  audioDir: string
  markdownDir: string
}
