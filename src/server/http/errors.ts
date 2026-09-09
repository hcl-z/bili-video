import type { Context } from 'hono'
import { ZodError } from 'zod'

import type { ErrorResponse } from '#shared/contract/api.ts'
import { errFields } from '../log-fields.ts'
import type { Logger } from '../ports/logger.ts'

/** /api 下一律回结构化 JSON —— 前端不该去 catch 一段 HTML。 */
export function errorBody(
  code: string,
  message: string,
  issues: ErrorResponse['error']['issues'] = null,
): ErrorResponse {
  return { error: { code, message, issues } }
}

export function zodIssues(err: ZodError): ErrorResponse['error']['issues'] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

/**
 * 未捕获异常的兜底。对外只给 code 和一句话，堆栈进日志 ——
 * 服务只听 127.0.0.1，但把内部路径回给页面依然没有好处。
 *
 * 拿 logger 是必须的：500 只回给页面不落日志，等于线上事故没有现场。
 */
export function makeErrorHandler(root: Logger): (err: Error, c: Context) => Response {
  const logger = root.child({ mod: 'http' })
  return (err, c) => {
    if (err instanceof ZodError) {
      // 入参不合法是调用方的问题，不是事故；info 级别，别把日志刷满。
      logger.info({ path: c.req.path, issues: zodIssues(err) }, '入参校验失败')
      return c.json(errorBody('invalid-request', '入参校验失败', zodIssues(err)), 400)
    }
    logger.error({ path: c.req.path, method: c.req.method, ...errFields(err) }, '未捕获异常')
    return c.json(errorBody('internal', err.message), 500)
  }
}
