import type { AppConfig, ConfigSection } from '#shared/contract/config.ts'
import type { ConfigResponse, ErrorResponse, HealthResponse } from '#shared/contract/api.ts'

/**
 * 数据层：所有请求走这一个函数，因此「怎么报错」只有一种写法。
 *
 * 后端只听 127.0.0.1，没有登录系统（spec Q31a），所以这里没有 token、没有 401 处理。
 * dev 下 /api 由 Vite 代理到 8788；打包后前端由后端自己伺服，同源。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  })

  if (!res.ok) {
    // 后端所有错误都是 { error: { code, message } }；解不出来才退回状态码文本。
    let code = 'unknown'
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as ErrorResponse
      code = body.error.code
      message = body.error.message
    } catch {
      // 非 JSON 响应（比如代理没起来时的 HTML），保留状态码文本。
    }
    throw new ApiError(res.status, code, message)
  }

  return (await res.json()) as T
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  config: () => request<ConfigResponse>('/config'),

  // PATCH 回的是**整份**配置（和 GET 同一个 body），不是被改的那一段 ——
  // 于是页面拿到的永远是服务端认过的全量真相，不需要自己合并。
  patchConfig: <S extends ConfigSection>(section: S, patch: Partial<AppConfig[S]>) =>
    request<ConfigResponse>(`/config/${section}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
}
