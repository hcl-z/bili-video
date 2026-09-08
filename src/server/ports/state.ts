/**
 * 派生运行态。**不是配置** —— 配置是人在页面上改的（app_config），
 * 这里是系统自己攒出来、重启要接着用的东西。
 *
 * key 是闭合联合而不是 string：打错一个字应该编译不过，而不是安静地读到 null
 * 然后重新生成一个浏览器身份。
 */
export type StateKey =
  /** 序列化的 BrowserIdentity。换 UA 等于在同一个 cookie 会话里换了台电脑。 */
  | 'browser-identity'
  /** 登录账号的 uid 与昵称，给 /api/system 显示，省得每次去问 B 站。 */
  | 'auth-uid'
  | 'auth-uname'
  /** 连续续期失败次数。到上限就转「登录已失效」，不再无效重试。 */
  | 'refresh-failures'
  /** 聚合流的 update_baseline，下一轮先拿它问心跳。 */
  | 'feed-baseline'

export interface StateRepo {
  get(key: StateKey): string | null
  set(key: StateKey, value: string): void
}
