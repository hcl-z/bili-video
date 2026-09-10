/** 假 fetch。B 站的每单条路径（风控重试、二维码状态迁移、续期链）都只能靠编排响应序列来测， 真打网络既不稳定也会把账号送进风控。 匹配方式是「URL 子串 → 处理函数」，按注册顺序取第一个命中的： 顺序有意义，让测试可以先注册单条更具体的规则覆盖通用规则 */

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null

  query: URLSearchParams
}

type Handler = (req: RecordedRequest, hit: number) => FakeResponse

export interface FakeResponse {
  status?: number

  code?: number
  message?: string
  data?: unknown
  /** 直接指定整个 body。对象会被 JSON 序列化（用来测形状不对的响应）， 字符串原样发出（续期链里的 correspond 页面是 HTML，不是 JSON） */
  raw?: unknown
  setCookie?: string[]
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = []
  private readonly rules: { match: string; handler: Handler; hits: number; hang?: boolean }[] = []

  /** 注册单条规则。handler 拿到第几次命中（从 0 开始），用来编排状态迁移 */
  on(match: string, handler: Handler | FakeResponse): this {
    const fn: Handler = typeof handler === 'function' ? handler : () => handler
    this.rules.push({ match, handler: fn, hits: 0 })
    return this
  }

  /** 依次返回给定响应，用完后重复最后一个 —— 轮询类接口最常见的形状 */
  onSequence(match: string, responses: FakeResponse[]): this {
    return this.on(match, (_req, hit) => responses[Math.min(hit, responses.length - 1)]!)
  }


  onHang(match: string): this {
    this.rules.push({ match, handler: () => ({}), hits: 0, hang: true })
    return this
  }

  countOf(match: string): number {
    return this.requests.filter((r) => r.url.includes(match)).length
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const req: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
      query: new URL(url).searchParams,
    }
    this.requests.push(req)

    const rule = this.rules.find((r) => url.includes(r.match))
    if (rule === undefined) {
      // 静默返回 404 会让「测试忘了替换」看起来像「业务判空」，所以失败出来
      throw new Error(`FakeFetch 没有匹配 ${url} 的规则`)
    }
    rule.hits += 1
    if (rule.hang === true) return await new Promise<Response>(() => {})
    return toResponse(rule.handler(req, rule.hits - 1))
  }
}

function toResponse(res: FakeResponse): Response {
  const html = typeof res.raw === 'string'
  const headers = new Headers({ 'content-type': html ? 'text/html' : 'application/json' })
  for (const line of res.setCookie ?? []) headers.append('set-cookie', line)
  const body = html
    ? (res.raw as string)
    : JSON.stringify(
        res.raw !== undefined
          ? res.raw
          : { code: res.code ?? 0, message: res.message ?? '0', data: res.data ?? null },
      )
  return new Response(body, { status: res.status ?? 200, headers })
}
