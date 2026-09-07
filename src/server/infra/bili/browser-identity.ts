/**
 * 浏览器身份：UA + `sec-ch-ua` 系列客户端提示头，两者版本互相咬合。
 *
 * 抄参考实现的这条结论：**每实例生成一次并保持稳定**。逐请求随机 UA 直觉上像是
 * 「更难追踪」，实际上正好相反 —— 真实浏览器的 UA 在一个会话里是不动的，
 * 跳变本身就是机器人特征。所以这里生成一次就存下来，连重启都不换。
 */
export interface BrowserIdentity {
  userAgent: string
  /** 直接摊进 fetch 的 headers。 */
  headers: Record<string, string>
}

/** Chrome 136–141。太老会被当成过期客户端，太新则本机根本还没发布。 */
export const CHROME_MAJORS: readonly number[] = [136, 137, 138, 139, 140, 141]

interface Platform {
  /** UA 括号里那段。 */
  token: string
  /** `sec-ch-ua-platform` 的值，带引号。 */
  hint: string
}

const PLATFORMS: Platform[] = [
  { token: 'Macintosh; Intel Mac OS X 10_15_7', hint: '"macOS"' },
  { token: 'Windows NT 10.0; Win64; x64', hint: '"Windows"' },
  { token: 'X11; Linux x86_64', hint: '"Linux"' },
]

const pick = <T>(xs: readonly T[], rand: () => number): T =>
  xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))]!

export function createBrowserIdentity(rand: () => number = Math.random): BrowserIdentity {
  const major = pick(CHROME_MAJORS, rand)
  const platform = pick(PLATFORMS, rand)

  const userAgent =
    `Mozilla/5.0 (${platform.token}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`

  return {
    userAgent,
    headers: {
      'user-agent': userAgent,
      // 品牌列表里两个真品牌必须和 UA 的主版本一致；`Not)A;Brand` 是 Chrome 自己
      // 用来防止服务端硬编码品牌名的占位项，版本号固定 99。
      'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not)A;Brand";v="99"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': platform.hint,
    },
  }
}

export function serializeIdentity(id: BrowserIdentity): string {
  return JSON.stringify(id)
}

/** 存的内容坏了返回 null —— 让调用方重新生成一个，而不是带着半个身份去发请求。 */
export function parseIdentity(json: string): BrowserIdentity | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { userAgent, headers } = raw as Record<string, unknown>
  if (typeof userAgent !== 'string' || userAgent === '') return null
  if (typeof headers !== 'object' || headers === null) return null
  const entries = Object.entries(headers as Record<string, unknown>)
  if (!entries.every(([, v]) => typeof v === 'string')) return null
  if (!('user-agent' in (headers as object)) || !('sec-ch-ua' in (headers as object))) return null
  return { userAgent, headers: Object.fromEntries(entries) as Record<string, string> }
}
