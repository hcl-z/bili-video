import { parseSetCookie } from '../../src/server/infra/bili/cookie-jar.ts'
import type { CookieJar } from '../../src/server/types/bili.ts'

/** 内存 cookie jar。假的只有「存何处」—— Set-Cookie 的解析仍然走真实现， 否则测试会绕开这套系统里最容易出错的一段（Max-Age 与 Expires 的优先级） */
export class MemoryCookieJar implements CookieJar {
  private readonly jar = new Map<string, { value: string; expires: number | null }>()
  readonly received: string[] = []

  constructor(initial: Record<string, string> = {}, expires: number | null = null) {
    for (const [name, value] of Object.entries(initial)) this.jar.set(name, { value, expires })
  }

  header(): string {
    return [...this.jar].map(([name, c]) => `${name}=${c.value}`).join('; ')
  }

  get(name: string): string | null {
    return this.jar.get(name)?.value ?? null
  }

  csrf(): string | null {
    return this.get('bili_jct')
  }

  setFromResponse(setCookie: string[], now: number): void {
    this.received.push(...setCookie)
    for (const line of setCookie) {
      const parsed = parseSetCookie(line, now)
      if (parsed !== null) this.jar.set(parsed.name, { value: parsed.value, expires: parsed.expires })
    }
  }

  clear(): void {
    this.jar.clear()
  }

  names(): string[] {
    return [...this.jar.keys()]
  }

  earliestExpiry(): number | null {
    const stamps = [...this.jar.values()].map((c) => c.expires).filter((e): e is number => e !== null)
    return stamps.length === 0 ? null : Math.min(...stamps)
  }

  isEmpty(): boolean {
    return this.jar.size === 0
  }
}
