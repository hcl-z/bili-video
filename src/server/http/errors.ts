import type { Context } from 'hono'
import { ZodError } from 'zod'

import type { ErrorResponse } from '#shared/contract/api.ts'
import { errFields } from '../log-fields.ts'
import type { Logger } from '../types/platform.ts'

/** /api 下一律回结构化 JSON —— 前端不应去 catch 一段 HTML */
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


export function makeErrorHandler(root: Logger): (err: Error, c: Context) => Response {
  const logger = root.child({ mod: 'http' })
  return (err, c) => {
    if (err instanceof ZodError) {

      logger.info({ path: c.req.path, issues: zodIssues(err) }, '入参校验失败')
      return c.json(errorBody('invalid-request', '入参校验失败', zodIssues(err)), 400)
    }
    logger.error({ path: c.req.path, method: c.req.method, ...errFields(err) }, '未捕获异常')
    return c.json(errorBody('internal', err.message), 500)
  }
}
