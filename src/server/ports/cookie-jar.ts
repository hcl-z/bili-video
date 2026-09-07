/**
 * cookie 存取。加密落库（和 SESSDATA 同一套 secret-box），因为 SESSDATA 就等于账号本身。
 *
 * 是 port 而不是 infra 内部类型：`app/auth-lifecycle` 要问「还有多久到期」，
 * `/api/system` 要把它显示出来，两处都不该认识 SQLite。
 */
export interface CookieJar {
  /** 拼好的 `Cookie` 请求头；空 jar 返回空串。 */
  header(): string
  get(name: string): string | null
  /** `bili_jct`，写接口和续期链都要带它做 csrf。 */
  csrf(): string | null
  /** 从响应的 Set-Cookie 头数组写入（`res.headers.getSetCookie()`）。 */
  setFromResponse(setCookie: string[], now: number): void
  clear(): void
  names(): string[]
  /** 最早到期的那条的时间戳；会话 cookie（没有到期时间）不参与。null = 无从判断。 */
  earliestExpiry(): number | null
  isEmpty(): boolean
}
