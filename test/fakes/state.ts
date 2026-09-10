import type { StateKey, StateRepo } from '../../src/server/types/persistence.ts'

/** 内存运行态。真实现（SQLite）另有单测，这里只是让 app 层的测试不必开库 */
export class MemoryStateRepo implements StateRepo {
  private readonly map = new Map<StateKey, string>()

  constructor(initial: Partial<Record<StateKey, string>> = {}) {
    for (const [key, value] of Object.entries(initial)) this.map.set(key as StateKey, value!)
  }

  get(key: StateKey): string | null {
    return this.map.get(key) ?? null
  }

  set(key: StateKey, value: string): void {
    this.map.set(key, value)
  }
}
