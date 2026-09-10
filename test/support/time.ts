import { CLOCK_START } from '../fakes/clock.ts'

/** 假动态的发布时间。轮询只抓「服务启动之后」发的，所以固定的 2023 年时间戳会被 地板挡掉 —— 一律写成「启动后 n 秒」 */
export const pubAt = (afterStartSec: number): number =>
  Math.trunc(CLOCK_START / 1000) + afterStartSec
