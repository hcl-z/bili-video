import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

import type { RuntimeInfo } from '../../ports/runtime.ts'

const CONTAINER_MARKERS = /(?:docker|containerd|kubepods|podman)/i

export function detectRuntime(): RuntimeInfo {
  if (process.env['BILI_VIDEO_DOCKER'] === '1') return { isDocker: true }
  if (existsSync('/.dockerenv')) return { isDocker: true }

  try {
    return { isDocker: CONTAINER_MARKERS.test(readFileSync('/proc/1/cgroup', 'utf8')) }
  } catch {
    return { isDocker: false }
  }
}
