import type { AppConfig, ConfigSection } from '#shared/contract/config.ts'
import type { Cancel } from './clock.ts'

/**
 * 配置以数据库为唯一真相，`config.yaml` 只在首次启动 seed。
 * 消费方必须在**用的时候**调 get()，不能在启动时抓一份存起来 —— 否则热生效不成立。
 */
export interface ConfigStore {
  get(): AppConfig
  getSection<K extends ConfigSection>(section: K): AppConfig[K]
  /** 写库 + 重新解析 + 通知订阅者。不需要重启。 */
  setSection<K extends ConfigSection>(section: K, value: AppConfig[K]): void
  onChange(handler: (section: ConfigSection, config: AppConfig) => void): Cancel
  /** seed 来源文件路径；null 表示这次启动不是首次（页面用它写「YAML 已不再生效」）。 */
  seededFrom(): string | null
}
