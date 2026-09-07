/**
 * 时间是依赖，不是全局。退避、cron、免扰时段、24h 补推窗口全都要靠推进假时钟来测，
 * 直接调 Date.now() 的话这些分支只能靠真等。
 */
export interface Clock {
  /** epoch ms */
  now(): number
  sleep(ms: number): Promise<void>
  /** 注册一个 cron 任务，返回取消函数。 */
  schedule(cron: string, task: () => void | Promise<void>): Cancel
}

export type Cancel = () => void
