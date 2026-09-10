import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import type { LogLine } from '#shared/contract/events.ts'
import { errFields } from '../src/server/log-fields.ts'
import { buildTargets, createLogger } from '../src/server/log.ts'

const dirs: string[] = []
function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bili-video-log-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})


async function waitForLog(dir: string, wantLines: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.log'))
    if (files.length === 1) {
      const body = readFileSync(join(dir, files[0]!), 'utf8')
      if (body.trim().split('\n').filter(Boolean).length >= wantLines) return files[0]!
    }
    assert.ok(files.length <= 1, `只该有一个当天的文件，实际 ${JSON.stringify(files)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`等不到日志落盘：${JSON.stringify(readdirSync(dir))}`)
}

describe('日志', () => {
  it('按天命名落盘，结构化 JSON 一行一条', async () => {
    const dir = freshDir()
    const logger = createLogger({ level: 'info', dir, retentionDays: 7, json: true, stdout: false })

    logger.info({ uid: '123' }, '轮询完成')
    logger.error({ err: 'boom' }, '推送失败')
    await logger.close()
    const file = await waitForLog(dir, 2)

    // pino-roll 的 dateFormat: yyyy-MM-dd —— 文件名里必须带日期，否则「按天轮转」是假的。
    assert.match(file, /app\.\d{4}-\d{2}-\d{2}(\.\d+)?\.log/)

    const lines = readFileSync(join(dir, file), 'utf8').trim().split('\n')
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(
      parsed.map((p) => p['msg']),
      ['轮询完成', '推送失败'],
    )
    assert.equal(parsed[0]!['uid'], '123')
    assert.ok(typeof parsed[0]!['time'] === 'number')
  })

  it('低于 level 的行不写', async () => {
    const dir = freshDir()
    const logger = createLogger({ level: 'warn', dir, retentionDays: 7, json: true, stdout: false })

    logger.debug({}, '看不见')
    logger.info({}, '也看不见')
    logger.warn({}, '看得见')
    await logger.close()
    const file = await waitForLog(dir, 1)

    const body = readFileSync(join(dir, file), 'utf8')
    assert.ok(!body.includes('看不见'))
    assert.ok(body.includes('看得见'))
  })

  it('每条日志同时喂给 sink，供 /api/logs/stream 用', async () => {
    const seen: LogLine[] = []
    const logger = createLogger({
      level: 'info',
      dir: null,
      retentionDays: 7,
      json: true,
      stdout: false,
      sink: (line) => seen.push(line),
    })

    logger.info({}, '一')
    logger.child({ scope: 'poll' }).warn({}, '二')
    await logger.close()

    assert.deepEqual(
      seen.map((l) => [l.level, l.msg]),
      [
        ['info', '一'],
        ['warn', '二'],
      ],
    )
    assert.ok(seen.every((l) => l.at > 0))
  })

  it('sink 带上模块 tag、结构化字段与错误摘要，堆栈只留在文件里', async () => {
    const seen: LogLine[] = []
    const logger = createLogger({
      level: 'info',
      dir: null,
      retentionDays: 7,
      json: true,
      stdout: false,
      sink: (line) => seen.push(line),
    })

    logger
      .child({ mod: 'queue' })
      .error(
        { bvid: 'BV1x', stage: 'asr', ...errFields(new TypeError('炸了')) },
        '任务失败',
      )
    await logger.close()

    const line = seen[0]!
    assert.equal(line.mod, 'queue')
    assert.equal(line.err, 'TypeError: 炸了')
    assert.deepEqual(line.data, { bvid: 'BV1x', stage: 'asr' })
    // 堆栈几十行，推到浏览器只会把日志页刷爆。
    assert.ok(!Object.hasOwn(line.data, 'stack'))
  })

  it('child 带上 bindings 并共用同一个 sink', async () => {
    const dir = freshDir()
    const seen: LogLine[] = []
    const logger = createLogger({
      level: 'info',
      dir,
      retentionDays: 7,
      json: true,
      stdout: false,
      sink: (line) => seen.push(line),
    })

    logger.child({ scope: 'poll' }).child({ uid: '9' }).info({}, '嵌套')
    await logger.close()
    const file = await waitForLog(dir, 1)

    const row = JSON.parse(readFileSync(join(dir, file), 'utf8').trim()) as Record<string, unknown>
    assert.equal(row['scope'], 'poll')
    assert.equal(row['uid'], '9')
    assert.equal(seen.length, 1)
  })

  it('保留天数原样换算成 pino-roll 的保留份数（一天一个文件）', () => {
    // 守的是配置意图：这些参数错了不会报错，只会安静地把磁盘写满或把日志提前删掉。
    const targets = buildTargets({ level: 'info', dir: '/tmp/x', retentionDays: 7, json: true })
    const roll = targets.find((t) => t.target === 'pino-roll')
    assert.ok(roll, '有日志目录时必须挂上 pino-roll')

    const options = roll.options as {
      frequency: string
      dateFormat: string
      limit: { count: number; removeOtherLogFiles: boolean }
    }
    assert.equal(options.frequency, 'daily')
    assert.equal(options.dateFormat, 'yyyy-MM-dd')
    assert.equal(options.limit.count, 7)
    assert.equal(options.limit.removeOtherLogFiles, true)
  })

  it('本地给人看用 pino-pretty，容器里输出结构化 JSON', () => {
    const local = buildTargets({ level: 'info', dir: null, retentionDays: 7, json: false })
    assert.deepEqual(
      local.map((t) => t.target),
      ['pino-pretty'],
    )

    const container = buildTargets({ level: 'info', dir: null, retentionDays: 7, json: true })
    assert.deepEqual(
      container.map((t) => t.target),
      ['pino/file'],
    )
    assert.equal((container[0]!.options as { destination: number }).destination, 1)
  })
})
