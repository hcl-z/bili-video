import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SystemResponseSchema } from '#shared/contract/api.ts'
import { createHarness, type Harness } from './support/harness.ts'
import { FakeFetch } from './fakes/bili-fetch.ts'

/** 登录全流程走主测试缝：只有 fetch 是假的，SQLite、加密、签名、错误分类全是真的在跑。 这里刻意不去 stub BiliAuth 接口。接口一 stub，被 stub 掉的正好是最容易写错的两处： 轮询响应的两层 code，和「cookie 是从响应头里来的」这件事 */

const UID = 20250907
const UNAME = '小号阿玖'
/** 真 cookie 是 ASCII，值里塞中文会在 Headers 那层就失败 */
const SESSDATA = 'f00dcafe%2C1790000000%2Cabcd1%2Ac1'
const CSRF = '0123456789abcdef0123456789abcdef'
const FAR_FUTURE = 'Tue, 07 Sep 2027 12:00:00 GMT'

/** 扫码登录成功那一刻 B 站塞回来的三条 cookie */
function loginCookies(): string[] {
  return [
    `SESSDATA=${SESSDATA}; Path=/; Domain=.bilibili.com; Expires=${FAR_FUTURE}; HttpOnly`,
    `bili_jct=${CSRF}; Path=/; Domain=.bilibili.com; Expires=${FAR_FUTURE}`,
    `DedeUserID=${UID}; Path=/; Domain=.bilibili.com; Expires=${FAR_FUTURE}`,
  ]
}

/**
 * 一台「等着被扫码」的假 B 站：出码 → 未扫 → 已扫 → 确认（带 cookie）。
 * poll 的第三次之后一直返回确认，重启后再问也还是登录着。
 */
function biliWaitingForScan(): FakeFetch {
  return new FakeFetch()
    .on('qrcode/generate', {
      data: { url: 'https://login.bilibili.com/h5-app/passport/login/scan?qrcode_key=qk-1', qrcode_key: 'qk-1' },
    })
    .onSequence('qrcode/poll', [
      { data: { code: 86101, message: '未扫码' } },
      { data: { code: 86090, message: '二维码已扫码未确认' } },
      { data: { code: 0, message: '0', refresh_token: 'rt-first' }, setCookie: loginCookies() },
    ])
    .on('web-interface/nav', { data: { isLogin: true, mid: UID, uname: UNAME } })
    .on('cookie/info', (_req, hit) => ({ data: { refresh: false, timestamp: 1_757_000_000_000 + hit } }))
}

async function systemOf(h: Harness) {
  const res = await h.server.app.request('/api/system')
  assert.equal(res.status, 200)
  return SystemResponseSchema.parse(await res.json())
}

describe('扫码登录全流程（主测试缝）', () => {
  it('伪造的轮询响应驱动出「待扫码 → 已扫码 → 成功」，cookie 加密落库', async () => {
    const h = await createHarness({ fetch: biliWaitingForScan() })
    const seen: boolean[] = []
    h.events.on((e) => {
      if (e.type === 'auth.changed') seen.push(e.loggedIn)
    })
    try {
      await h.server.bootstrap()

      // 二维码给出去了，给的是 B 站返回的那个 url，不是我们自己编的。
      assert.equal(h.qrs.length, 1)
      assert.match(h.qrs[0]!, /qrcode_key=qk-1/)

      // 三次轮询走完三个状态，最后一次才是确认。
      assert.equal(h.fetch.countOf('qrcode/poll'), 3)
      // 起点本来就是 logged-out，所以只有三次变化。
      const states = h.logger.lines
        .filter((l) => l.msg === '登录态变更')
        .map((l) => (l.obj as { to: string }).to)
      assert.deepEqual(states, ['waiting-scan', 'scanned', 'logged-in'])
      // 每次变化都发了事件，否则页面上的登录态会停在旧值。
      assert.deepEqual(seen, [false, false, true])

      // cookie 进库了，而且库里那份是密文 —— 明文落盘等于 master key 白加。
      const rows = h.core.db.prepare('SELECT name, blob_json, expires FROM cookies').all() as {
        name: string
        blob_json: string
        expires: number | null
      }[]
      assert.deepEqual(
        rows.map((r) => r.name).sort(),
        ['DedeUserID', 'SESSDATA', 'bili_jct'],
      )
      const sessdata = rows.find((r) => r.name === 'SESSDATA')!
      assert.ok(!sessdata.blob_json.includes(SESSDATA), `SESSDATA 明文落库了：${sessdata.blob_json}`)
      assert.equal(sessdata.expires, Date.parse(FAR_FUTURE))
      // 读回来是原值：加密的是「存法」，不是内容。
      assert.equal(h.deps.cookies.get('SESSDATA'), SESSDATA)

      // refresh_token 是凭据，走加密的 secrets 表，不进 runtime_state。
      assert.equal(h.core.secrets.get('bili-refresh-token'), 'rt-first')
      const leaked = h.core.db
        .prepare("SELECT key FROM runtime_state WHERE value_json LIKE '%rt-first%'")
        .all()
      assert.deepEqual(leaked, [], 'refresh_token 漏进了明文的 runtime_state')
    } finally {
      await h.close()
    }
  })

  it('/api/system 给出登录态、昵称和 cookie 剩余有效期', async () => {
    const h = await createHarness({ fetch: biliWaitingForScan() })
    try {
      const before = await systemOf(h)
      assert.equal(before.auth.state, 'logged-out')
      assert.equal(before.auth.uname, null)
      assert.equal(before.auth.remainingMs, null, '没有 cookie 时是「不知道」，不是 0')

      await h.server.bootstrap()

      const after = await systemOf(h)
      assert.equal(after.auth.state, 'logged-in')
      assert.equal(after.auth.uid, String(UID))
      assert.equal(after.auth.uname, UNAME)
      assert.equal(after.auth.expiresAt, Date.parse(FAR_FUTURE))
      assert.equal(after.auth.remainingMs, Date.parse(FAR_FUTURE) - h.clock.now())
      assert.equal(after.auth.refreshFailures, 0)
      assert.equal(after.auth.lastError, null)
      assert.equal(after.auth.checkedAt, h.clock.now())
      assert.equal(after.version, 'test')

      // 刷页面不该顺手打一串外部请求：快照是启动流程留下的结论。
      const calls = h.fetch.requests.length
      await systemOf(h)
      assert.equal(h.fetch.requests.length, calls)
    } finally {
      await h.close()
    }
  })

  it('重启进程后登录态仍然有效，不需要重新扫码', async () => {
    const first = await createHarness({ fetch: biliWaitingForScan() })
    await first.server.bootstrap()
    assert.equal((await systemOf(first)).auth.state, 'logged-in')

    const second = await first.restart()
    try {
      const codesBefore = second.fetch.countOf('qrcode/generate')
      await second.server.bootstrap()

      // 关键一条：没有再出码。
      assert.equal(second.qrs.length, 0)
      assert.equal(second.fetch.countOf('qrcode/generate'), codesBefore)

      const sys = await systemOf(second)
      assert.equal(sys.auth.state, 'logged-in')
      assert.equal(sys.auth.uname, UNAME)
      assert.ok(sys.auth.remainingMs! > 0)

      // cookie 是从库里解出来的（新进程、新 jar），身份也还是同一份。
      assert.equal(second.deps.cookies.get('SESSDATA'), SESSDATA)
      assert.equal(second.core.secrets.get('bili-refresh-token'), 'rt-first')
      assert.equal(second.core.identity.userAgent, first.core.identity.userAgent)
      // 这一轮是真去核对过的：nav + cookie/info。
      assert.ok(second.fetch.countOf('web-interface/nav') > 0)
      assert.ok(second.fetch.countOf('cookie/info') > 0)
    } finally {
      await second.close()
    }
  })
})
