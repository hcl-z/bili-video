import type { AuthState, Fault, FaultKind, PollStatus } from '#shared/contract/api.ts'

/** 三类故障的判定。纯函数，因为「什么算故障」和「告警发不发」是两件事： 前者要能单独摆出来看，后者是编排（见 app/health.ts）。 只判这三类，因为只有它们会让系统**静默地不干活**：登录掉了、拉不到动态、 转写一直失败。AI 调用失败不在内，应项路有降级链兜着，总结照样出得来 */
export interface HealthInput {
  auth: { state: AuthState; lastError: string | null }
  poll: { status: PollStatus; consecutiveFailures: number; lastError: string | null }
  asr: { consecutiveFailures: number; lastError: string | null }
}

export interface FaultThresholds {
  pollFailures: number
  asrFailures: number
}


export const DEFAULT_THRESHOLDS: FaultThresholds = { pollFailures: 3, asrFailures: 3 }


export type DetectedFault = Omit<Fault, 'since'>

export function detectFaults(
  input: HealthInput,
  thresholds: FaultThresholds = DEFAULT_THRESHOLDS,
): DetectedFault[] {
  const faults: DetectedFault[] = []

  // auth-lost 是终态：cron 已经被摘掉，不催人重新登录的话系统就这么保持静默
  if (input.auth.state === 'auth-lost' || input.poll.status === 'auth-lost') {
    faults.push(fault('auth', input.auth.lastError ?? 'cookie 已经不能用了，要重新扫码登录'))
  }

  if (input.poll.consecutiveFailures >= thresholds.pollFailures) {
    faults.push(
      fault(
        'poll',
        `连续 ${input.poll.consecutiveFailures} 轮拉取失败：${input.poll.lastError ?? '原因不明'}`,
      ),
    )
  }

  if (input.asr.consecutiveFailures >= thresholds.asrFailures) {
    faults.push(
      fault(
        'asr',
        `连续 ${input.asr.consecutiveFailures} 次转写失败：${input.asr.lastError ?? '原因不明'}`,
      ),
    )
  }

  return faults
}

const fault = (kind: FaultKind, message: string): DetectedFault => ({ kind, message })
