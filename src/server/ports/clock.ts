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
  /**
   * 表达式合法吗。返回人话的错误，null = 合法。
   *
   * 归时钟管而不是单开一个端口：cron 的语义（六位含秒）本来就是调度器定的。
   * 假时钟也必须真解析 —— 「非法表达式当场拒绝」正是要测的那条行为。
   */
  checkCron(cron: string): string | null
}

export type Cancel = () => void
