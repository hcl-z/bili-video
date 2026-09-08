# bili-video

监听指定 B 站 UP 主的动态与视频投稿，推到微信（WxPusher）与安卓（ntfy），并对视频做 AI 全文总结。
单用户、本地常驻，工作台只听 `127.0.0.1`。

设计文档是唯一权威：[`docs/spec/v1-bili-monitor-summary.md`](docs/spec/v1-bili-monitor-summary.md)。

## 跑起来

需要 **Node 24+**（用到内置的 `node:sqlite` 与 `node:test`，以及直接执行 `.ts`）。

```bash
nvm use            # 读 .nvmrc
pnpm install
cp .env.example .env
pnpm dev           # 后端 127.0.0.1:8788 + Vite 127.0.0.1:5173（/api 与 /events 代理到后端）
```

打开 <http://127.0.0.1:5173>。生产模式是 `pnpm build && pnpm start`，此时前端由后端自己伺服，同源，只有 8788 一个口。

```bash
pnpm typecheck     # 三份 tsconfig 一起
pnpm test          # node:test
pnpm build         # tsc -b（只出声明） + vite build → dist/web
```

## 没有小号、没有 LLM key 也能试：`pnpm demo`

```bash
pnpm build         # demo 由后端伺服前端，所以要先出一份 dist/web
pnpm demo          # 127.0.0.1:8789，数据在 .demo-data/
```

真库、真队列、真页面、真 Markdown，只有 `fetch` 是假的：三个假视频从抓动态一路走到落盘，
不会有任何请求打到 B 站。三条分支分别是人工字幕、只有 AI 字幕、以及**没有字幕**（会明确失败，
用来试「重跑」按钮）。总结落在 `.demo-data/summaries/*.md`。

| 参数 | 作用 |
| --- | --- |
| `--fresh` | 先删 `.demo-data/`，从空库重来 |
| `--fast` | 不减速（默认每步慢 1.5 秒，方便看队列阶段跳动） |
| `--llm` | 只放 `/chat/completions` 出网，用配置里的真模型；B 站那边照旧是假的 |

端口用 `DEMO_PORT` 换，数据目录用 `DEMO_DATA_DIR` 换。要造别的分支就改 `scripts/demo-data.ts`
里的 `VIDEOS`。

## 两件必须先知道的事

**1. `data/master.key` 丢了，所有加密内容一次性不可恢复。**

SESSDATA、cookies、AI apiKey 都用它派生的密钥加密落库（AES-256-GCM + scrypt，随机 salt）。
它在 `.gitignore` 里，也**不在**任何自动备份里 —— 请自己抄一份到密码管理器。

丢了之后不会静默降级：启动时发现「库里有密文但 key 是新生成的」会直接报错并告诉你怎么办
（从备份恢复，或者清空 `secrets` / `cookies` 两张表，重新扫码登录 + 重填 apiKey）。

容器里可以改用 `MASTER_KEY` 环境变量（至少 16 位），这样不落 key 文件。

**2. `config.example.yaml` 只在首次启动 seed，之后改它不生效。**

配置的唯一真相是数据库的 `app_config` 表。首次启动（表为空）时从 YAML 导入一次，之后
一律在工作台页面上改，改完立刻生效、不用重启。三个月后你改了 YAML 发现没反应，不是 bug。

## 目录

```
src/shared/contract/   前后端共享的 zod schema 与类型
src/server/
  ports/               端口（接口）：Clock / Logger / EventBus / 9 个仓储 / B站 / ASR / LLM / Notifier …
  domain/              纯逻辑，零 IO：B站错误码分类、登录态决策、uid 识别、锚点推进、过滤判定
  app/                 编排：登录生命周期（扫码 → 续期 → 失效）、订阅与自动关注、轮询、过滤规则
  infra/               适配器：SQLite、secret-box、事件总线、真时钟、带超时的正则、B站（签名/登录/续期/关注/聚合流）
  config/              YAML seed → DB，DB 为真相 + 热重载
  http/                Hono 装配与路由，含 SSE（/api/events）
  build-server.ts      ★ 组装根：buildServer(ports)，唯一 new 具体实现的地方
  main.ts              薄入口：构造真实 infra，交给 buildServer
src/web/               Vite + React + Tailwind v4 + shadcn/ui
test/
  fakes/               可控时钟、记录型 logger、记录型通知器、假 fetch（出网的唯一假件）
  support/harness.ts   主测试缝：真 SQLite + 真加密 + 假外部 I/O
```

依赖方向单向：`infra → app → domain`，`domain` 里不许出现 `node:*`、SQL、`fetch`。
只有组装根 `new` 具体实现，没有模块级单例。

三份 tsconfig 把类型隔开：`server` 拿不到 DOM 类型，`web` 拿不到 node 类型，`shared` 两者都拿不到。
写错了 `pnpm typecheck` 会直接报 `Cannot find name 'HTMLElement'` / `Cannot find name 'process'`。

## B 站的三个常量要自己填

扫码登录、读接口不需要额外配置，但下面两件事需要 —— 它们依赖 B 站 web 端 JS 里的几个公开常量，
本仓库不内置：

| 要做的事 | 需要的配置 |
| --- | --- |
| WBI 签名（大部分读接口） | `bili.wbiMixinTable`（64 项的重排下标） |
| 风控后重取 `bili_ticket` | `bili.ticket.keyId` / `bili.ticket.hmacKey` |
| cookie 自动续期 | `bili.correspondPublicKeyPem`（`correspond/1` 的 RSA 公钥） |

算法都实现好并有单测，缺的只是常量。留空不会静默出错：需要它们的调用会带着「缺哪一项」直接失败，
而不是发一个签错的请求换回 `-352`（那会被当成风控白等一轮退避）。续期留空就是「到期得重新扫码」。

这些常量按版本会变，抄的时候记一下来源。原先的社区文档仓库（`bilibili-API-collect`）
已于 2026-01-28 被 B 站要求下架，现在只能从浏览器里自己抠。

## 轮询、锚点、过滤

轮询走关注列表的聚合流（`web-dynamic/v1/feed/all`），每 2 分钟一轮，秒位错到 `:30`。
单轮加锁：上一轮没跑完，这次 tick 直接跳过而不排队 —— 排队只会在慢的时候雪崩。
每轮先用 `feed/all/update` 问一句「比 baseline 新的有几条」，是 0 就不拉全量。

请求必须带 `features=itemOpusStyle`：不带的话图文动态的正文既不在 `desc` 也不在 `major` 里，
抓回来是一条没内容的空动态。payload 还有两个坑 —— 用不上的 `major` 分支是**显式 null**
（不是缺字段），`pub_ts` 是**字符串**。这两条都会让 zod 把整条判为解析失败。
所以有条目没解析出来时**不推进 baseline**：心跳一旦越过它们，它们就再也不会被拉回来。

**去重靠 per-UP 时间戳锚点**，不靠「见过的 id 列表」。锚点只单调推进，
而且只推进到「早于本 UP 最早失败项」的最大成功时间戳 —— 于是中间某条处理失败时，
它和它之后的条目下一轮会重来，不会被跳过。这条规则是纯函数（`domain/anchor.ts`），
单测覆盖成功/失败交错的多种排列。锚点落库，所以重启不会重复处理。

失败分五类（`auth-lost` / `risk-control` / `rate-limit` / `transient` / `fatal`），
以返回值传递，不抛异常。撞风控按 `retryAfterMs × 2^(连续失败次数-1)` 退避，上限 30 分钟，
成功一次立刻清零；鉴权失效则摘掉 cron 并在页面上提示重新登录，扫码成功后自动接着跑。

过滤是纯函数（`domain/filter.ts`）：黑名单优先于白名单，白名单非空时只有命中白名单的才通过；
per-UP 规则**整套覆盖**全局规则，不是叠加。匹配范围只有动态正文、视频标题、视频简介 ——
总结正文不参与，否则为了过滤得先花钱生成总结。免扰时段内的条目是挂起，不是丢弃。
被拦下的条目照样入库并在更新流里灰显，点开能看到是哪条规则拦的。

用户手写的正则在 `node:vm` 里跑，超过 `filter.regexTimeoutMs`（默认 100ms）就中断，
该规则记一次超时、当作没命中，不阻塞整轮轮询。编译不过的正则启动时就报错并指名是哪一条。

## 自动关注为什么这么小心

新增订阅时会自动关注 UP —— 这是整个服务唯一的写接口，也是唯一有封号风险的地方。**用小号。**

三条约束：

- **先批量查关系再写**：`relation/relations` 一次查 50 个，已关注的（含悄悄关注）一个写请求都不发。
- **写请求不自动重放**：读接口撞风控会清签名 key 重试一次，写接口不会 —— 重试一次就是关注两次，审计也对不上账。
- **独立限流 + 审计**：`bili.write.minIntervalMs` / `maxPerHour` 只管写接口，写请求还排成一条队
  （限流读的是审计表，并发调用不串起来就会各自读到「额度没用过」）。额度从 `bili_write_calls`
  表数出来（不是内存计数器），所以重启不会白送一轮额度，每次调用的成败也留痕。

小号一旦在 `relation/modify` 上开始吃 -352，把 `bili.write.autoFollow` 改成 false ——
订阅照样能加，只是不再自动关注。这是唯一一个「先止血再排查」的开关。

关注失败不会回滚订阅：订阅照样在，列表里多一个「重试关注」。写接口撞风控是常态，不是异常。

## 为什么没有登录系统

服务只绑 `127.0.0.1`，手机永远碰不到它（手机只收推送）。安全边界是文件系统权限，
不是自写的登录。把 host 改成 `0.0.0.0` 等于放弃这个前提 —— 那之前得先加鉴权。

## 前端组件

基础件由 shadcn/ui 的 CLI 生成进 `src/web/components/ui/`，**不手改结构**。
设计 token（单一强调色、三档圆角、亮暗双主题跟随系统）在 `src/web/styles/globals.css` 里
**覆盖 shadcn 的 CSS 变量**，不另起一套 —— 另起一套的话每次 `shadcn add` 都会把手改覆盖回去。

加组件：`pnpm dlx shadcn@latest add <name>`。生成后检查一下 `cn` 的 import 是否指向
`@/lib/utils`（CLI 有时会写成裸 `cn` 包）。
