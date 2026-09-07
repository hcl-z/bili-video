# Spec: B 站动态/视频监听 + 推送 + AI 总结（v1）

状态：`ready-for-agent`
产出日期：2026-09-07
前置：本 spec 归档了设计阶段（Q0–Q35 逐条决策）与原型阶段（工作台三变体选定 B）的全部结论。代码库当前只有 `package.json` 与一个丢弃用的 HTML 原型，属全新起步。

## 问题陈述

我关注的 UP 主更新分散在 B 站 App 里，只有主动打开才知道。两件事分别浪费我的时间：

1. **我不知道更新了**。要么错过，要么隔几小时刷一次空间。
2. **我知道更新了，但不知道值不值得看**。一个小时的视频，标题和封面给不了判断依据，看完才发现不需要看的成本很高。

现有工具只解决第一件。参考实现 `bilibili-notify` 的监听层很成熟，但它的 AI 只做「动态锐评」和「直播总结」，**没有视频内容提取**——也就是我最想要的那一半完全没有。

另外，这套系统天生容易静默出错：转写来源有四级降级、过滤规则会误伤、ASR 是分钟级重活会堵住。日志和 YAML 都回答不了「我收到的这条总结是哪一级产出的」「那条动态为什么没推给我」「三小时的录播是不是卡住了」。

## 解决方案

一个跑在本地 Mac（可搬 Docker）的常驻单用户服务：

- **监听**：用一个 B 站小号登录，自动关注目标 UP，走 `feed/all` 聚合流单请求轮询（2 分钟一轮、秒位错峰），覆盖投稿/图文/纯文字/转发/专栏五类动态。锚点落 SQLite，重启与睡眠只延迟不丢。
- **推送**：两段式。发现新更新立刻推第一条「XX 发了《标题》」；总结完成后推第二条完整正文。渠道 WxPusher（微信）+ ntfy（Android 即时）。推送自带完整总结，手机不需要访问这个服务。
- **AI 总结**：官方字幕优先，拿不到就 yt-dlp 下音频 + 本地 `mlx-whisper` 转写；按 token 阈值决定整篇总结还是分段 map-reduce。产出 TL;DR + 3–5 要点 + 带时间戳的章节目录（点击直跳 B 站 `?t=`）+ Markdown 全文。四级降级，任何一级失败都推、都标注走了哪条路，绝不静默丢弃。
- **工作台**：只听 `127.0.0.1`、无登录系统的完整管理后台，10 个页面。核心不是改配置，是可观测性：每条更新为什么推/没推、每个总结走了哪级降级、花了多少 token、队列堵在哪一步。布局用原型选定的**分栏阅读**：左侧索引 + 右侧把总结当文章读。

## 用户故事

### 监听与去重

1. 作为订阅者，我希望指定若干 UP 主后系统自动关注并持续监听他们，以便我不用逐个打开空间检查。
2. 作为订阅者，我希望视频投稿、图文、纯文字、转发、专栏五类动态都被捕获，以便任何形式的更新都不漏。
3. 作为订阅者，我希望发现延迟在 2 分钟量级，以便「我立刻知道了」这半份价值成立。
4. 作为订阅者，我希望重启或唤醒后不重复推送已推过的内容，以便通知栏不被刷屏。
5. 作为订阅者，我希望 Mac 合盖睡眠期间的更新在唤醒后补推（24 小时窗口内），以便过夜不丢内容。
6. 作为订阅者，我希望停机超过 24 小时的积压只收到一条汇总通知、条目仍能在工作台翻到，以便出差一周回来不被两百条轰炸。
7. 作为订阅者，我希望某条更新投递失败时锚点不越过它，以便它下一轮还能重试而不是永久消失。
8. 作为订阅者，我希望聚合流里混进来的非目标 UP 内容被 uid 白名单挡掉，以便小号关注列表的杂音不进通知。
9. 作为运维者，我希望轮询的秒位错开整分（`30 */2 * * * *`），以便避开全网客户端堆在 `:00` 的流量尖峰、降低风控概率。
10. 作为运维者，我希望一轮没跑完时下一次 cron tick 直接跳过，以便不会并发拉取把自己打成限流。

### 过滤

11. 作为订阅者，我希望每个 UP 有「动态 / 视频 / AI 总结」三个独立开关，以便某个 UP 我只要视频不要碎动态。
12. 作为订阅者，我希望过滤规则是「全局默认 + per-UP 覆盖」，以便不用给每个 UP 重抄一遍同样的黑名单。
13. 作为订阅者，我希望能配关键词黑白名单，以便挡掉恰饭、抽奖这类固定噪音。
14. 作为订阅者，我希望能配正则规则，以便表达关键词表达不了的模式。
15. 作为运维者，我希望正则在启动时预编译校验、执行时有 100ms 超时，以便我写错一个 `(a+)+` 不会把整个轮询卡死。
16. 作为订阅者，我希望黑名单优先于白名单、且白名单非空时只推命中白名单的内容，以便优先级是确定的而不是要猜。
17. 作为订阅者，我希望有免扰时段，以便深夜不被叫醒。
18. 作为订阅者，我希望被过滤掉的条目仍然入库、并在工作台标明命中了哪条规则，以便「为什么这条没推给我」有地方回答。
19. 作为订阅者，我希望过滤只作用于动态正文、视频标题、视频简介，以便不会为了过滤先花钱生成总结。

### 推送

20. 作为订阅者，我希望发现新视频时立刻收到一条轻量通知，而不是等几十分钟等总结跑完，以便时效性不被重活拖没。
21. 作为订阅者，我希望总结完成后收到第二条完整正文，并与第一条折叠进同一通知分组，以便两条消息不占两个位置。
22. 作为订阅者，我希望微信里能收到（WxPusher），以便我在最常用的 App 里看到更新。
23. 作为订阅者，我希望手机上有即时提醒（ntfy，Android），以便重要更新不被微信消息流淹没。
24. 作为订阅者，我希望推送正文里就有完整总结，以便我不需要访问 Mac 上那个服务。
25. 作为订阅者，我希望章节时间戳是 `bilibili.com/video/BVxxx?t=123` 链接，以便点一下直接跳进 B 站 App 的那一秒。
26. 作为订阅者，我希望同一条更新在同一渠道同一类型下只投一次，以便重试逻辑不会给我发重复消息。
27. 作为运维者，我希望每次投递的结果（成功/失败/重试次数/错误）都落库，以便「我到底收到了没有」可查。
28. 作为运维者，我希望渠道是一个接口的多个实现，以便以后加 Bark、Telegram、企业微信不用改编排逻辑。

### AI 总结

29. 作为订阅者，我希望有官方字幕（含 AI 字幕）时直接用字幕，以便省掉 ASR 的时间和算力。
30. 作为订阅者，我希望没有字幕时自动下音频并本地转写，以便覆盖率是 100% 而不是「看运气」。
31. 作为订阅者，我希望短视频一次性整篇总结、长视频先分段出要点再汇总，以便一小时视频的中段信息不被稀释。
32. 作为订阅者，我希望分段切点落在字幕的自然停顿而不是硬切字符，以便段落不会在句子中间断掉。
33. 作为订阅者，我希望总结包含一句话 TL;DR、3–5 条核心要点、带时间戳的章节目录、Markdown 全文，以便我能判断「值不值得看、看哪一段」。
34. 作为订阅者，我希望 ASR 也失败时退化成基于简介和分 P 标题的低置信度总结、并明确标注「未获取语音内容，基于简介推测」，以便我不会把猜测当结论。
35. 作为订阅者，我希望全部失败时仍然收到标题、封面、链接和失败原因，以便系统绝不静默丢弃任何一条。
36. 作为运维者，我希望每个视频都能看到它走的是哪一级降级路径，以便我知道手上这份总结的可信度。
37. 作为订阅者，我希望有一个 AI 总开关，关掉后只推送不总结，以便我能随时把 AI 成本降到零。
38. 作为运维者，我希望每次 LLM 调用的模型、输入输出 token、耗时都记账（只记录不拦截），以便我知道这东西一个月花了多少钱。
39. 作为运维者，我希望 ASR 是可切换的 provider（本地 `mlx-whisper` / OpenAI 兼容云端），以便搬进 Docker 时改一行配置而不是改架构。
40. 作为运维者，我希望 LLM 只要一组 `baseURL + apiKey + model` 就能换供应商，以便不被任何一家 SDK 绑住。
41. 作为运维者，我希望 ASR 队列并发 1、LLM 队列并发 2，以便一个转写任务不会把 16GB 内存吃满、也不会阻塞轮询。
42. 作为运维者，我希望重启时把 `running` 的任务重置为 `pending` 续跑，以便崩在中途的任务不会永久卡住。
43. 作为运维者，我希望音频临时文件跑完即删、失败保留、超过 24 小时的孤儿文件启动时清理，以便磁盘不被慢慢填满。

### 工作台

44. 作为运维者，我希望工作台是「左索引 + 右长文」的分栏阅读布局，以便主场景（读某条总结到底讲了什么）是一等公民。
45. 作为运维者，我希望左侧索引每行有封面、两行标题、状态标记，以便扫一眼就知道哪条已完成、哪条在跑、哪条被拦下。
46. 作为运维者，我希望右侧把总结排版成文章（封面、标题、byline、TL;DR、编号要点、章节列表、底部元信息），以便长文本可读而不是塞在卡片里。
47. 作为运维者，我希望点开一条被过滤的条目时，右侧显示的是「被哪条规则拦下」而不是空白，以便过滤决策是可解释的。
48. 作为运维者，我希望概览页显示轮询健康、cookie 剩余有效期、队列积压、今日/本月 token 用量、最近推送时间轴，以便一屏看出系统是否正常。
49. 作为运维者，我希望更新流页列出所有抓到的动态与视频（含被过滤的，灰显 + 命中规则），以便回答「为什么没推给我」。
50. 作为运维者，我希望任务队列页显示阶段（下载 → ASR → 分段 → 汇总）并支持重跑，以便三小时录播卡住时我有抓手。
51. 作为运维者，我希望能在页面上增删 UP 主、改 per-UP 开关、看关注状态，以便订阅管理不用手改文件。
52. 作为运维者，我希望规则页带一个样本测试框（贴一段文本看命中哪条规则），以便正则不用盲写。
53. 作为运维者，我希望推送目标页能发测试消息，以便配完就能确认通得了。
54. 作为运维者，我希望 AI 配置页能做连通性测试，以便 baseURL 或 key 配错时当场知道，而不是等第一个视频失败。
55. 作为运维者，我希望日志页有实时流和级别筛选，以便排查时不用去 tail 文件。
56. 作为运维者，我希望系统页能扫码登录、手动续期 cookie、看数据库体积、导出备份，以便账号和数据的运维入口集中在一处。
57. 作为运维者，我希望队列进度、任务阶段、新动态、日志行通过 SSE 实时推到页面，以便我不用手动刷新盯进度。
58. 作为运维者，我希望页面跟随系统亮暗主题，以便夜里看不刺眼。
59. 作为运维者，我希望当前选中的条目体现在 URL 上，以便刷新和分享链接不丢上下文。
60. 作为运维者，我希望工作台在窄屏能退化成单列，以便偶尔用手机开也不算废。

### 账号与安全

61. 作为运维者，我希望用扫码登录，以便不用在任何地方填 B 站密码。
62. 作为运维者，我希望 cookie 自动续期、失效时收到一次告警并能重新扫码，以便登录态掉了我马上知道。
63. 作为运维者，我希望自动关注前先批量查关系、只对缺失的补写，以便把风控最严的写接口调用压到最少。
64. 作为运维者，我希望 SESSDATA 和 AI apiKey 加密落库、页面上只显示掩码且字段只写不读，以便页面泄露不等于交出账号。
65. 作为运维者，我希望服务只监听 `127.0.0.1` 且不做登录系统，以便暴露面归零、靠文件系统权限而不是自写鉴权。
66. 作为运维者，我希望整套系统只用小号、主号零参与，以便最坏情况的损失可控。
67. 作为运维者，我希望 `master.key` 在 `.gitignore` 和备份清单里、README 写明丢失后果，以便我不会在某次清理后失去所有加密值。
68. 作为运维者，我希望浏览器身份（UA 与 `sec-ch-ua` 版本咬合）每实例生成一次并保持稳定，以便同一 cookie 会话里的 UA 不跳变（逐请求随机反而是机器人特征）。

### 运维

69. 作为运维者，我希望轮询失败、鉴权失效、ASR 连续失败各推一条告警且只推一次、恢复后再推一条，以便告警有用而不是刷屏。
70. 作为运维者，我希望 30 分钟一次健康检查，以便故障不必等我发现。
71. 作为运维者，我希望日志按天轮转保留 7 天，以便磁盘可控且回溯窗口够用。
72. 作为运维者，我希望配置以数据库为唯一真相、`config.yaml` 只在首次启动 seed、页面上写明「YAML 已不再生效」，以便我三个月后改了 YAML 不会以为没生效是 bug。
73. 作为运维者，我希望配置改动热生效不用重启，以便调阈值的循环够快。
74. 作为运维者，我希望能用 Docker 多阶段构建整包搬走，以便以后迁到国内 VPS 时不改代码。
75. 作为运维者，我希望容器内启动时校验 `asr.provider` 不是 `mlx-whisper`（拿不到 Metal），以便配错在启动时就报错而不是等第一个视频。

## 实现决策

### 已定决策全表（Q0–Q35）

设计阶段逐条问过并确认的结论，作为实现时的既定前提，不再重开：

| # | 决策点 | 结论 |
|---|---|---|
| Q0 | 实现路径 | 自建精简版，逐点照搬 `bilibili-notify` 已验证的监听层决策；不做它的插件 |
| Q1 | 形态 | 个人自用单用户，无用户体系 |
| Q2 | 部署 | 本地 Mac 优先，代码无 Mac 专属依赖，可搬 Docker |
| Q3/Q11 | 运行时 | Node 24 LTS + 内置 `node:sqlite`（放弃 bun；放弃 `better-sqlite3`，零原生编译） |
| Q4 | 数据源 | `feed/all` 聚合流单请求 + `feed/all/update` 心跳；放弃 per-UP `feed/space` 轮询 |
| Q5 | 账号 | **小号**扫码登录，自动关注目标 UP（先批量 `GET_RELATIONS` 再补写） |
| Q6 | 事件 | `AV/DRAW/WORD/FORWARD/ARTICLE` 五类，仅 `AV` 走总结管线 |
| Q7 | 节奏 | `30 */2 * * * *`，2 分钟一轮、秒位错峰到 `:30`，单轮加锁 |
| Q8/Q10 | 推送 | WxPusher（微信）+ ntfy（Android）；**放弃 B 站私信**（唯一写风险且体验更差） |
| Q12 | 转写来源 | 官方字幕 → 本地 ASR 兜底；**不用** `conclusion/get`（官方总结是短摘要，不是要的东西） |
| Q13 | ASR | provider 抽象：`mlx-whisper`（本地）/ OpenAI 兼容 `/v1/audio/transcriptions`（容器） |
| Q14/Q22 | 分段 | 按最终文本 token：>12000 分段，8000/段，重叠 400，切点落字幕自然停顿，末尾汇总 |
| Q15 | 产出 | 两层：推送短版（TL;DR + 3 要点 + 链接）+ 完整版（含时间戳章节） |
| Q16 | 承载 | SQLite + HTTP 服务 + Markdown 落盘（原「URL token」方案被 Q31 作废） |
| Q17 | 过滤 | per-UP 开关、免扰时段、关键词黑白名单、正则（100ms 超时）、AI 处理开关 |
| Q18 | AI | OpenAI 兼容 `baseURL + apiKey + model`，直接 `fetch`，**不引 AI SDK** |
| Q19 | 全局屏蔽 | 只做「全局默认规则 + per-UP 覆盖」，**不做**一键静音总开关 |
| Q20 | 过滤范围 | 动态正文 + 视频标题 + 简介（不含总结正文）；黑名单优先于白名单 |
| Q21 | 推送时机 | 两段推送：发现即推 + 总结完成再推 |
| Q23 | 成本 | **不设限**，全量处理；只记账不拦截；`ai.enabled` 关闭则只推不总结 |
| Q24 | 补推 | 锚点落 SQLite；重启补推 24h 内，溢出只入库 + 一条汇总 |
| Q25 | 队列 | ASR 并发 1 / LLM 并发 2；SQLite 任务表；启动把 `running` 重置续跑 |
| Q26 | 告警 | 故障推一次不刷屏 + 恢复通知；30 分钟健康检查；pino 按天轮转留 7 天 |
| Q27 | 降级 | 字幕 → ASR → 简介低置信度 → 仅标题链接；绝不静默丢弃 |
| Q28 | 工作台定位 | **(c) 完整管理后台**（配置可在页面改） |
| Q29 | 主设备 | **(b) Mac 为主**，手机只看推送短版 |
| Q30 | 前端构建 | **(a) 接受** Vite + React + Tailwind + Radix/shadcn 风格 |
| Q31 | 监听与鉴权 | **(a) 只听 `127.0.0.1`、无登录系统**；推送自带完整正文 + 直跳 B 站时间戳链接 |
| Q32 | 配置真相 | **(a) DB 为唯一真相**，YAML 只 seed + **(e) secrets 加密入库、页面只读掩码** |
| Q33 | 实时通道 | **(a) SSE**；`/api/events` 主流 + `/api/logs/stream` 独立流 |
| Q34 | 页面清单 | 10 页（见下）；砍掉 Chat/Cards/skins/Stats/guide/About |
| Q35 | API 层 | **(b) Hono** + `@hono/node-server`，zod schema 前后端共享 |

Q29 选 Mac 为主恰好把 Q28 选完整后台带来的安全问题解掉了：服务不必对局域网开放，于是登录系统、URL token、局域网暴露面三件事一起消失。

### 分层与依赖方向

单包 + TypeScript project references，**不用** pnpm workspace（只有一个交付物；拆包的主要收益是前后端类型隔离，三份 tsconfig 就够：后端拿不到 DOM 类型，前端拿不到 node 类型）。

```
        shared/contract  ←──────────────┐
              ↑                          │
    web/  ────┘                     server/http
                                         ↓
                                    server/app  ──→  server/domain
                                         ↓                  ↑
                                    server/ports  ←─────────┘
                                         ↑
                                    server/infra
                                         ↑
                                    server/main.ts（唯一组装点）
```

- `domain/` 不依赖任何东西，不许出现 `node:*`、SQL、`fetch`。
- `app/` 只依赖 `ports` + `domain`。
- `infra/` 只依赖 `ports` + `shared`。
- 只有组装根 `new` 具体实现：没有模块级单例，没有 `import db from "./db"`。
- 箭头没有一条反向。

配套的几条原则（都对应到具体决策，不是贴标签）：

- **端口与适配器只在真有多实现处立接口**：ASR（本地/云）、LLM、Notifier（WxPusher/ntfy）、AudioDownloader。其余不立。
- **接口隔离**：B 站 API 拆成 `BiliReader` / `BiliRelationWriter` / `BiliAuth` / `SubtitleFetcher` 四个窄接口。写接口风控严得多，拆开才能给它单独限流和审计，也让轮询这条路径**在类型上就拿不到写能力**。
- **仓储是 8 个窄接口，不是一个 `Store` 门面**。门面会让 `poll-once` 在类型上拿到它不该碰的 `SummaryRepo`；窄接口的成本只是多几行类型声明。
- **时间是依赖**：`Clock { now / sleep / schedule }` 注入。否则退避、cron、免扰时段、24h 补推窗口全都只能靠真等来测。
- **Parse, don't validate**：zod 只在三处边界跑（HTTP 入参、B 站响应、配置加载）；穿过边界后是确定类型，内部不再到处 `if (x?.y)`。
- **失败显式分类**：B 站错误码映射成 `auth-lost | risk-control | rate-limit | transient | fatal` 联合类型，调用方必须穷举；禁止裸 `catch {}`。
- **幂等与单调**：锚点只单调推进；ASR/总结任务可重跑无副作用；投递按 `(update_id, channel, kind)` 唯一约束去重。

**刻意不做**：DI 容器、Repository 泛型基类、CQRS/事件溯源、给每张表配一个 domain entity class、pnpm workspace 拆包。这些在 10 张表 / 1 个交付物的规模下只有成本。

### 端口清单（抽象端，只有接口和类型）

| 端口 | 契约要点 |
|---|---|
| `BiliReader` | 拉聚合流与心跳，返回已解析的原始动态 payload；无任何写能力 |
| `BiliRelationWriter` | 批量查关系 + 补关注；单独限流与审计 |
| `BiliAuth` | 扫码登录、cookie 续期、登录态查询 |
| `SubtitleFetcher` | 取官方/AI 字幕，返回 `Cue[]` 或「无字幕」 |
| `Asr` | `transcribe(audioPath): Promise<Cue[]>` |
| `Llm` | `complete(msgs, opts): Promise<{ text, usage }>` |
| `Notifier` | `channel` + `send(msg): Promise<DeliveryResult>` |
| `AudioDownloader` | 按 bvid 下音频到临时目录（带 cookie） |
| `SecretStore` | `get/set(key)`；读取对外永远返回掩码 |
| `Clock` | `now / sleep / schedule` |
| `EventBus` | `emit / on`；SSE 是它的一个订阅者 |
| 8 个窄 Repo | 订阅 / 规则 / 锚点 / 更新 / 任务 / 总结 / 投递 / LLM 记账 |

### domain 层的五处纯逻辑

放进 `domain/` 的都是这套系统最容易写错、且天生零 IO 的地方。它们是正确性核心，先钉死再写搬运代码：

| 模块 | 职责 |
|---|---|
| `anchor` | `advanceAnchor(ok[], fail[])` → 只推进到早于本 UP 最早失败项的最大成功 `pub_ts` |
| `filter` | `evaluate(update, rules, quietHours)` → `Pass` \| `Blocked{reason}`；黑名单优先，白名单非空则白名单必须命中 |
| `chunker` | 按 token 阈值 + 字幕自然停顿（字幕条边界、间隔 >1.5s）切分，段间重叠 400 |
| `degrade` | 降级路径状态机：`subtitle → asr → meta-only → link-only` |
| `bili-error` | 错误码 → `auth-lost`(-101) / `risk-control`(-352,-403) / `rate-limit`(-509) / `transient` / `fatal` |

外加两个同样纯的：`catchup`（24h 窗口判定 + 溢出汇总）、`summary-format`（结构化总结 → 推送短版 / Markdown 全文）、`token`（`gpt-tokenizer` 薄封装，domain 里唯一的外部依赖）。

### 应用层用例

| 用例 | 编排 |
|---|---|
| `poll-once` | 拉 `feed/all` → 解析五类 → 过滤 → 入库 → 推进锚点 → 发事件 → 视频入队 |
| `summarize-video` | 降级链：字幕/音频/ASR → 分段 → 汇总 → 落库 + 写 Markdown |
| `deliver` | 多渠道并行投递 + 重试 + 按唯一约束去重 |
| `auth-lifecycle` | 扫码登录、cookie 续期、`auth-lost` / `restored` 事件 |
| `sync-relations` | 批量查关系 → 只对缺失的补关注 |
| `health` | 30 分钟健康检查 + 故障只报一次 + 恢复通知 |
| `queue-runner` | 两级队列（ASR 1 / LLM 2），启动重置 `running` |

### SQLite 表（12 张）

| 表 | 说明 |
|---|---|
| `migrations` | 版本号 + 应用时间 |
| `app_config` | `key` PK, `value_json` — **DB 为配置真相**，YAML 只 seed |
| `secrets` | `key` PK, `blob_json`（GCM `{iv,tag,data}`）— SESSDATA、apiKey；读取永远返回掩码 |
| `subscriptions` | `uid` PK, name, face, enable_dynamic, enable_video, enable_ai, followed_at |
| `filter_rules` | id, `scope`(`global` \| uid), `kind`(keyword/regex × allow/deny), pattern, enabled |
| `anchors` | `uid` PK, last_pub_ts, updated_at — **参考实现缺的持久化** |
| `updates` | `dyn_id` PK, uid, type, pub_ts, title, text, cover, bvid, url, raw_json, filtered, filter_reason |
| `summary_jobs` | id, bvid, update_id, status, stage, attempts, error |
| `summaries` | `bvid` PK, tldr, points_json, chapters_json, full_md, transcript, transcript_source, confidence, degrade_path |
| `llm_calls` | id, bvid, stage, model, in_tokens, out_tokens, ms — 分段会多次调用，记账放这里才准 |
| `deliveries` | id, update_id, channel, kind(`discover` \| `summary`), status, attempts, err；唯一索引 `(update_id, channel, kind)` |
| `cookies` | name PK, blob_json（加密）, expires |

两处刻意的设计（其中一条是参考实现踩过的坑）：

- **锚点表覆盖每一个订阅，哪怕推送开关关着也照常推进**；「要推送的订阅」是另一张口径。这样关掉开关再打开不会炸出一堆积压旧动态。
- `filter_rules` 用 `scope` 区分全局与 per-UP，实现 inherit-or-override，而不是把规则塞进 `subscriptions` 的 JSON 列。

### HTTP 与实时通道

- Hono + `@hono/node-server`，只监听 `127.0.0.1:8788`，**无鉴权、无登录系统**（Q31a）。
- 路由分组：`overview / updates / summaries / jobs / subs / rules / targets / ai / logs / system`。
- 每个端点的 req/res schema 定义在 `shared/contract/api.ts`，前端从 `z.infer` 拿类型；zod 通过一个中间件挂到 Hono 上。
- SSE 两条流：`/api/events`（队列变化、任务阶段推进、新动态，前端按 `event:` 类型分发到 TanStack Query 缓存）与 `/api/logs/stream`（独立，避免刷日志把主流量挤爆）。事件联合类型定义在 `shared/contract/events.ts`，是前后端唯一真相。
- 静态托管 `dist/web`；dev 期 Vite 把 `/api` 与 `/events` 代理到 8788。

### 配置与密钥

- `config.example.yaml` 是**首次启动的种子**；启动时若 `app_config` 为空则导入，之后 DB 为真相，页面上明确写「配置已由 Web 管理，`config.yaml` 不再生效」。
- 配置改动经 `config/store.ts` 热重载，不重启。
- secrets 走 AES-256-GCM + `scryptSync`（16 字节随机 salt），master key 存独立文件（`tmp` + `rename` 原子写）或从 env passphrase 派生。SESSDATA、cookie、AI apiKey 全部加密入库。
- API 返回的 secret 字段永远是掩码，表单是 write-only：提交空值表示不修改。
- `master.key` 进 `.gitignore` 与备份清单，README 写明**丢失后所有已加密的 cookie 与 apiKey 一次性不可恢复**。
- `.env` 只放 `MASTER_KEY_PATH / PORT / DATA_DIR`。

### 工作台：布局定为「分栏阅读」

HTML 原型做了三个**结构不同**（不是配色不同）的变体：A 时间线单列流、B 分栏阅读、C 高密度运行台。选定 **B**，因为主场景是「读某条视频到底讲了什么」，长文阅读优先于信息密度。

外壳骨架（这段来自原型，它比文字更精确地固定了布局决策）：

```css
.shell { height: 100dvh; display: grid; grid-template-rows: auto 1fr }  /* 不用 h-screen */
.bar   { height: 60px }                    /* logo + 页签 + 实时状态 + 立即检测 */
.split { display: grid; grid-template-columns: 364px 1fr }  /* 左右各自独立滚动 */
@media (max-width: 900px) { .split { grid-template-columns: 1fr } }
```

- **左索引**：每行 `grid-template-columns: 96px 1fr` — 16:9 封面 + 两行 clamp 标题 + 状态 chip；选中行是 2px 强调色左边框 + 强调色淡底；被过滤行降饱和。
- **右文档**：`max-width: 720px` 阅读栏宽 — 16:9 封面、27px/730 标题、头像 byline、强调色淡底的一句话 TL;DR、`01` 式 mono 编号要点走细分割线、章节列表（56px mono 时间戳 + 标题 + 描述，hover 出跳转图标，链接指向 `?t=`）、底部 4 格 1px 间隙元信息网格（处理路径 / tokens / 耗时 / 推送）。
- **被过滤条目**在右侧渲染空状态，说明命中了哪条规则，而不是显示总结。
- 索引与文档在真实实现里是两个路由级组件，**选中项是 URL 上的 id**，刷新不丢。

视觉系统（第一版原型被判「太丑」就是因为违反了这几条，属硬约束）：

| 约束 | 内容 |
|---|---|
| 单一强调色 | B 站粉，亮色 `#FB7299` / 暗色 `#FF89A9`；只用于主操作、当前选中、实时状态 |
| 语义色 | `ok / warn / bad / idle` 只表状态，不当装饰色，不参与配色 |
| 圆角一套 | 面板 14px、控件与缩略图 10px、chip 7px、`999px` 只给头像和实时点 |
| 主题 | 一套 CSS 变量撑亮暗双主题（`:root` + `:root[data-theme=dark]`），跟随系统，不做分区反色 |
| 组件 | **shadcn/ui**：基础件一律由 shadcn CLI 生成进 `components/ui`，不手写 Radix 封装、不引第二套组件库 |
| 图标 | `lucide-react`（shadcn/ui 默认，与 monorepo 一致），不用 emoji，不手写 SVG path |
| 图片 | 视频封面用真实图片，不用渐变色块假装缩略图 |
| 数字 | mono + `tabular-nums` |
| 动效 | 只保留 hover/active 过渡、实时点脉冲、总结中转圈，全部包在 `prefers-reduced-motion: no-preference` 里 |
| 排版 | 不用 `·` 当通用分隔符（改发丝分割线），不摆一排等宽 KPI 卡片 |

### 10 个页面

概览、更新流（含被过滤条目与命中规则）、总结（列表 + 详情，即 B 方案主视图）、任务队列（阶段 + 重跑）、订阅、规则（带样本测试框）、推送目标（带发送测试）、AI 配置（带连通性测试）、日志（实时流 + 级别筛选）、系统（扫码登录 / cookie 续期 / cron / DB 体积 / 备份导出）。

前端栈：Vite + React + react-router + TanStack Query + Tailwind + **shadcn/ui**（Radix + lucide-react），与 monorepo 的房子风格一致。所有基础件走 shadcn CLI 装进 `components/ui`，业务组件在其上组合；不手写 Radix 封装，不引第二套组件库。设计 token 层（单一强调色、圆角、亮暗）覆盖 shadcn 的默认 CSS 变量，而不是绕过它另起一套。前端依赖全在 `devDependencies`，Docker `--prod` 安装时自动剔除。

### Docker

```
web-build   : node:24-alpine → pnpm install → vite build → dist/web
server-build: node:24-alpine → pnpm install → tsc → dist/server
runtime     : node:24-alpine + apk add ffmpeg yt-dlp
              → pnpm install --prod（前端依赖自动不在）
              → COPY 两个 dist
```

容器内 `mlx-whisper` 拿不到 Metal，`asr.provider` 必须配成 `openai-compat`。这条写进 README，并在**启动时的配置校验**里断言——配错了启动就报，不等到第一个视频才失败。

### 依赖清单

- **生产**：`hono` `@hono/node-server` `croner` `zod` `yaml` `pino` `pino-roll` `gpt-tokenizer` `qrcode-terminal`
- **开发**：`typescript` `tsx` `vite` `@vitejs/plugin-react` `react` `react-dom` `react-router-dom` `@tanstack/react-query` `tailwindcss` `@tailwindcss/vite` `lucide-react` + Radix 按需、`@types/node` `@types/react`
- **外部二进制**：`yt-dlp`（已装）、`ffmpeg`（已装）、`mlx-whisper`（待 `uv tool install`）
- **明确不用**：`better-sqlite3`、任何 AI SDK、puppeteer、任何 B 站封装库

### 实施顺序

每步都有独立可验证的产出，不允许「写完一大片再一起调」：

| 步 | 内容 | 验证点 |
|---|---|---|
| 1 | 骨架、tsconfig references、SQLite + migrations、config seed、secret-box、log、**参数化组装根 + 测试假件目录** | `pnpm test` 过，DB 建表 |
| 2 | `domain/` 五个纯逻辑模块 + 全量单测 | 无需任何 IO 就能测过最容易错的部分 |
| 3 | `infra/bili` + 扫码登录 + cookie 续期 | 终端扫码登录，重启后 cookie 仍在 |
| 4 | `poll-once` + 锚点持久化 + 错误码分级 + 自动关注 | 终端打出新动态，重启不重推 |
| 5 | Hono + SSE + 概览/更新流/系统 三页（含登录入口） | 浏览器看到实时状态，能扫码 |
| 6 | Notifier + 两段推送第一段 | 手机收到「发现新视频」 |
| 7 | 字幕 + LLM + 队列 + 总结/任务 两页 | 有字幕的视频出完整总结，页面看得到阶段 |
| 8 | yt-dlp + mlx-whisper + 降级链 | 无字幕视频也能出总结，页面显示走了哪级 |
| 9 | 订阅/规则/推送目标/AI 配置 四页 + 正则测试框 + 连通性测试 | 全部配置可在页面改 |
| 10 | 日志页 + 健康告警 + Dockerfile | 拔网线能收到故障通知 |

第 2 步先行是有意的：那几个纯函数是整套系统的正确性核心，先钉死，后面所有 IO 代码都只是搬运。第 1 步里那句「参数化组装根 + 假件目录」是本 spec 相对早期方案的唯一新增，理由见下节。

## 测试决策

### 什么算一个好测试

- 只断言**外部可见的行为**：HTTP 响应体、DB 里落了什么、Notifier 收到了什么、SSE 发了什么事件、返回值。
- 不断言实现细节：不检查某个函数被调了几次、不 mock 内部模块、不测私有函数、不快照内部数据结构。
- 一个测试一条行为，测试名描述行为不描述实现（「投递失败时锚点不越过失败项」而不是「advanceAnchor 返回正确值」）。
- 重构（换 SQL 写法、拆文件、改内部函数签名）不应该让任何测试变红。这条是判断缝选得对不对的唯一标准。

### 测试缝（越少越好，理想是一条）

**主缝 — 装配好的服务，只有外部 I/O 是假的。** 组装根拆成 `buildServer(ports): { app, start, stop }` + 一个只负责构造真实 infra 的薄 `main.ts`。测试调 `buildServer` 传入假件，得到 Hono 实例，用 `app.request()` 驱动（进程内，不起网络），用 `FakeClock` 推进时间来驱动 cron、退避、免扰时段、24h 补推窗口。这条缝里**真实**的部分包括：SQLite（临时文件或 `:memory:`，跑真 migrations）、`domain/`、`app/`、`http/`、`config/`、`secret-box`。假的只有进程边界外的东西。

这条缝能覆盖绝大多数用户故事，包括最容易静默出错的那些：

| 假件 | 用途 |
|---|---|
| `FakeBili` | 注入 canned `feed/all` payload 序列；可编排错误码序列（`-352` 后恢复、`-101`、`-509`）来测分级与退避 |
| `FakeSubtitleFetcher` | 有字幕 / 无字幕 / 抛错，三种分支驱动降级链 |
| `FakeAsr` | 返回固定 `Cue[]` 或失败，不跑真模型 |
| `FakeAudioDownloader` | 不下真音频 |
| `FakeLlm` | 返回固定结构 + 可控 `usage`，用来断言分段次数与记账 |
| `RecordingNotifier` | 记录每次 `send`，断言两段推送、去重、免扰、告警只发一次 |
| `FakeClock` | `now / sleep / schedule` 可控 |
| 真 `SecretStore` | 用临时目录的 master key，加密路径是真的 |

**第二缝 — `domain/` 纯函数直测**，只用在组合爆炸的地方：chunker 的边界数学与重叠、bili-error 码表全覆盖、filter 的黑白名单优先级矩阵、anchor 推进的成功/失败交错、catchup 窗口边界、degrade 状态机的每条转移。零 mock、零 IO，跑得快，用表驱动。

**不建缝的部分**（有意的取舍，写在这里免得以后被当成遗漏）：

- `infra/` 里对真外部的适配器（B 站 HTTP、`yt-dlp`、`mlx-whisper`、WxPusher、ntfy）不写自动化测试。它们的正确性靠一次性连通性脚本 + 页面上的「发送测试 / 连通性测试」按钮验证；给它们写 mock 测试只会测到 mock 自己。
- 前端不做组件测试。10 个页面手测更快，这是明确的取舍。契约风险由前后端共享的 zod schema 在类型层面兜住。

### 工具与既有惯例

项目里目前**没有任何测试，也没有测试框架**。用 Node 24 内置的 `node:test` + `node:assert`，不引 vitest/jest（与「零原生依赖、镜像干净」的取向一致）。因此第一批测试本身就是后续的参照，第 1 步就必须把 `buildServer(ports)` 的形状和假件目录立起来——不然到第 4 步再回头改组装根的成本会高得多。

覆盖目标按价值排，不追百分比：`domain/` 全覆盖，`app/` 每个用例的正常路径 + 每条失败/降级分支，`http/` 每个端点的契约（happy path + 一个校验失败），其余不强求。

## 不在范围内

| 项 | 理由 |
|---|---|
| 直播开播监听与直播总结 | 另一套 WebSocket 长连 + 1 分钟级时效要求，参考实现为它写了约 4000 行；放 v2 |
| B 站官方 AI 总结（`conclusion/get`） | 几百字短摘要，不是「完整总结」；且引入额外登录依赖（Q12） |
| B 站私信推送 | 全设计里唯一有实际封号风险的写操作，体验还不如微信通知（Q8） |
| 多用户、注册、登录鉴权 | 单用户 + 只听 `127.0.0.1`，文件权限比自写鉴权可靠（Q1/Q31） |
| 局域网或公网访问工作台 | 手机改为直接读推送正文 + 跳 B 站；想要远程随时加 Tailscale，不改代码 |
| UP 主数据统计（涨粉曲线、雷达图） | 要额外起粉丝数轮询，多一个风控面换几张图表（Q34） |
| AI 对话页、卡片图片渲染、皮肤、引导页 | 参考实现为 QQ 群场景做的，与本需求无关 |
| 成本熔断（单视频/每日 token 上限） | 明确「先不做限制，全量处理」；只保留记账（Q23） |
| 一键静音总开关 | 明确不做；只保留全局默认规则 + per-UP 覆盖（Q19） |
| 追番更新、合集更新 | 不在五类动态里，需求未提 |
| 前端组件测试 | 见测试决策 |
| 原型代码进生产 | `prototype/` 是丢弃代码，只作视觉与布局参照 |

## 其他说明

### 未验证项（如实标注，不打包票）

1. **登录后字幕的实际覆盖率** — 无 cookie 无法测。它直接决定 ASR 的触发频率，也就是实际耗时。覆盖率若很低，大部分视频都要走 ASR。
2. **`feed/all` 五类动态 payload 的精确形状** — 需登录实拉才能定 parser 细节，目前只能照参考实现的类型定义写。
3. **`mlx-whisper` 在这台 M2 上的实测速度** — 未安装。引用的 8–15x 实时是公开基准，不是本机测出来的。
4. **自动关注写接口的风控表现** — 未测，这是全设计里唯一的写操作。
5. **Docker 内 ASR 只能走云端** — `mlx-whisper` 拿不到 Metal，已在启动校验里兜住。

已用真实请求验证过的（可以当事实用）：`arc/search` 免登录可用但必须 WBI 签名（不签直接 `-352`）；`feed/space` 免登录可用但必须带 SPI 拿的 `buvid3/buvid4`（否则 412）；`player/v2` 字幕免登录返回空数组，必须 SESSDATA；`yt-dlp` 匿名 412，补 `buvid3`/`Referer`/UA 仍 412，必须登录 cookie；本机是 Apple M2 / 16GB / arm64；`node:sqlite` 在 22.16 免 flag 可用、24 上已稳定；默认 Node 是 20.11.1（已 EOL）。

### 环境与账号约束（硬要求）

- **必须用 B 站小号，绝不用主号。** 聚合流要求登录，且订阅 = 该账号的关注列表，自动关注是写接口。
- 手机是 Android，所以即时推送用 ntfy 而非 Bark。
- 手上可用的 key：AI Gateway、智谱、Gemini、OpenAI、OpenRouter、Anthropic（**没有 DeepSeek**）。智谱 `open.bigmodel.cn/api/paas/v4` 与 AI Gateway 都是 OpenAI 兼容的，可直接填。当前网络能直连 Gemini/OpenAI/OpenRouter（<1.3s），但这是网络属性不是机器属性，搬国内 VPS 后只有智谱不会断。
- 需要 `nvm install 24`。

### 还需要准备（前置条件，不是决策）

1. 一个 B 站小号（有现成的吗，没有就得先注册）
2. 3–5 个目标 UP 的 uid 或空间链接
3. WxPusher 扫码关注拿 UID；ntfy 装 App 定一个 topic
4. 一组 OpenAI 兼容的 `baseURL + apiKey + model`
5. `uv tool install mlx-whisper`

## 附录：归档的目录结构

以下是设计阶段确认过的目录结构，按要求原样归档。它是**动土时的计划**，不是活地图——真实布局以代码为准，这里只用来交代模块边界与命名意图。

```
bili-video/
├── package.json                   单包。前端依赖全在 devDependencies，Docker --prod 自动剔除
├── tsconfig.json                  只做 references，不含 files
├── tsconfig.shared.json           lib: ES2023，无 DOM、无 node
├── tsconfig.server.json           lib: ES2023 + @types/node
├── tsconfig.web.json              lib: ES2023 + DOM，jsx: react-jsx
├── vite.config.ts                 web 构建 + dev 期 /api 与 /events 代理到 8788
├── config.example.yaml            首次启动的种子文件（之后 DB 为真相）
├── .env.example                   MASTER_KEY_PATH / PORT / DATA_DIR
├── Dockerfile                     多阶段
├── docker-compose.yaml
├── data/                          .gitignore：app.db、master.key、audio/、summaries/、logs/
│
├── src/shared/                    ★ 前后端共享。零运行时依赖，不许 import node: 或 DOM
│   ├── contract/
│   │   ├── config.ts              AppConfigSchema（分段阈值、cron、免扰时段…）
│   │   ├── subscription.ts        SubscriptionSchema、FilterRuleSchema
│   │   ├── update.ts              UpdateSchema、DynamicType 联合
│   │   ├── summary.ts             SummarySchema、ChapterSchema、TranscriptSource
│   │   ├── job.ts                 JobSchema、JobStage 联合
│   │   ├── api.ts                 每个 /api 端点的 req/res schema
│   │   └── events.ts              SSE 事件联合类型（前后端唯一真相）
│   └── util/                      纯工具：时间格式化、bvid 校验、token 估算入口
│
├── src/server/
│   ├── main.ts                    ★ 组装根：读配置 → 建 infra → 注入 app → 启动 http/poller/queue
│   │
│   ├── ports/                     ★ 抽象端。只有接口和类型，无实现
│   │   ├── bili.ts                BiliReader / BiliRelationWriter / BiliAuth / SubtitleFetcher
│   │   ├── asr.ts                 Asr { transcribe(audioPath): Promise<Cue[]> }
│   │   ├── llm.ts                 Llm { complete(msgs, opts): Promise<{text, usage}> }
│   │   ├── notifier.ts            Notifier { channel; send(msg): Promise<DeliveryResult> }
│   │   ├── audio.ts               AudioDownloader
│   │   ├── repo.ts                8 个窄 Repo 接口
│   │   ├── secret-store.ts        SecretStore { get/set(key) }
│   │   ├── clock.ts               Clock { now/sleep/schedule }
│   │   └── event-bus.ts           EventBus { emit/on }
│   │
│   ├── domain/                    ★ 纯逻辑，零 IO，node:test 全覆盖
│   │   ├── anchor.ts              advanceAnchor(ok[], fail[]) → 只推进到早于最早失败项
│   │   ├── filter.ts              evaluate(update, rules, quietHours) → Pass | Blocked{reason}
│   │   ├── chunker.ts             按 token 阈值 + 字幕自然停顿切分，重叠 400
│   │   ├── degrade.ts             降级路径状态机：subtitle → asr → meta-only → link-only
│   │   ├── bili-error.ts          错误码 → auth-lost/risk-control/rate-limit/transient/fatal
│   │   ├── catchup.ts             24h 补推窗口判定 + 溢出汇总
│   │   ├── summary-format.ts      结构化总结 → 推送短版 / Markdown 全文
│   │   └── token.ts               token 计数（gpt-tokenizer 薄封装，唯一外部依赖）
│   │
│   ├── app/                       ★ 用例编排。只依赖 ports 和 domain
│   │   ├── poll-once.ts           拉 feed/all → 解析 → 过滤 → 入库 → 推进锚点 → 发事件 → 入队
│   │   ├── summarize-video.ts     降级链编排：字幕/音频/ASR/分段/汇总/落库
│   │   ├── deliver.ts             多渠道并行投递 + 重试 + 去重
│   │   ├── auth-lifecycle.ts      扫码登录、cookie 续期、auth-lost/restored 事件
│   │   ├── sync-relations.ts      批量查关系 → 只对缺失的补关注
│   │   ├── health.ts              30 分钟健康检查 + 故障只报一次
│   │   └── queue-runner.ts        两级队列：ASR 并发1 / LLM 并发2，启动重置 running
│   │
│   ├── infra/                     ★ 适配端。每个文件实现一个 port
│   │   ├── bili/                  http-client / browser-identity / cookie-jar / wbi / ticket
│   │   │                          / login / reader / relation-writer / subtitle / parser
│   │   ├── asr/                   mlx-whisper.ts、openai-compat.ts
│   │   ├── llm/                   openai-compat.ts（fetch /v1/chat/completions）
│   │   ├── notify/                wxpusher.ts、ntfy.ts
│   │   ├── audio/                 yt-dlp.ts（带 cookie，子进程）
│   │   ├── db/                    sqlite.ts、migrations/、repo-*.ts（8 个实现）
│   │   ├── secret/               secret-box.ts（AES-256-GCM+scrypt）、key-manager.ts
│   │   ├── clock/                 system-clock.ts、croner-scheduler.ts
│   │   ├── event-bus/             in-memory.ts
│   │   └── fs/                    markdown-writer.ts、temp-audio.ts
│   │
│   ├── http/
│   │   ├── app.ts                 Hono 实例装配
│   │   ├── routes/                overview / updates / summaries / jobs / subs / rules
│   │   │                          / targets / ai / logs / system
│   │   ├── sse.ts                 /api/events（订阅 EventBus）+ /api/logs/stream 独立流
│   │   ├── static.ts              托管 dist/web
│   │   └── validate.ts            zod → Hono 中间件
│   │
│   ├── config/                    load.ts（YAML seed → DB）、store.ts（DB 为真相 + 热重载）
│   └── log.ts                     pino + pino-roll（按天，留 7 天）
│
└── src/web/
    ├── main.tsx  app.tsx  router.tsx
    ├── api/                       fetch 封装 + TanStack Query hooks，类型来自 shared/contract
    ├── hooks/use-sse.ts           EventSource 订阅，按 event 类型分发到 query cache
    ├── components/ui/             shadcn/ui 基础件，由 CLI 生成，不手改结构
    ├── components/                业务组件：StatusCard / DegradeBadge / ChapterList /
    │                              RegexTester / TokenMeter / JobStageBar
    └── pages/                     Overview / Updates / Summaries / SummaryDetail /
                                   Jobs / Subs / Rules / Targets / Ai / Logs / System
```

对这份树的一处修订：`main.ts` 要拆成 `buildServer(ports)`（可注入）+ 一个只构造真实 infra 的薄入口，这样主测试缝才立得住。见测试决策。

## 附录：从参考实现照搬的决策

`https://github.com/Akokk0/bilibili-notify`，源码级确认（不是读 README）。它 60%+ 的体量（Puppeteer 卡片渲染、直播弹幕词云、数据统计、锐评人格库、Tauri 自更新）我们不要，但监听层的脏活一行不差地抄——那是它几百个 commit 换来的。

| 决策点 | 它的做法 | 采纳情况 |
|---|---|---|
| 动态获取 | `feed/all` 聚合流 + `feed/all/update` 心跳 + `portal` | 抄。请求数从 O(UP 数) 降到 O(1) |
| 视频投稿 | 不单独轮询，`DYNAMIC_TYPE_AV` 就在同一个流里 | 抄。视频监听白送，不需要独立链路 |
| 登录 | 扫码 → `cookie/info` → `correspond/1` → `cookie/refresh` → `confirm/refresh`，另有 `bili_ticket` 供 WBI | 抄 |
| 订阅 = 关注 | 用登录账号自动关注，启动时 `GET_RELATIONS` 批量查关系避免盲发写接口（源码注释原话：写接口的风控比读严得多） | 抄 |
| 轮询节奏 | `30 */2 * * * *`，秒位错到 `:30` 避开全网 `:00` 尖峰 | 抄，尤其错峰这个细节 |
| 风控分级 | `-101` 停 cron 等重登不盲重试；`-352/-403` 非终态、退避 5 分钟重启；`-509` 限流；`-352` 时先清空 WBI key 重取 ticket 重试一次 | 抄。这是最值钱的部分 |
| 去重 | per-UP 时间戳锚点单调推进，只推进到早于本 UP 最早失败项的最大成功 `pub_ts` | 抄这个细节 |
| 并发 | 单轮加锁，cron tick 撞上就跳过 | 抄 |
| 浏览器身份 | 按 Chrome 136–141 生成 UA + `sec-ch-ua` 且两者版本咬合，每实例一次并保持稳定 | 抄。逐请求随机反而招风控 |
| 两张口径不同的表 | 「已观测锚点」覆盖每一个订阅（开关关着也推进），「推送订阅表」只收开着的 | 抄。这决定了关掉开关再打开不会炸出积压 |
| 密钥落盘 | AES-256-GCM + `scryptSync`(16 字节随机 salt)，master key 独立文件原子写 | 抄 |
| **视频内容提取** | **完全没有**（它的 AI 只做动态锐评和直播总结） | **这是我们的全部增量** |
| 锚点持久化 | **纯内存 `Map<uid, ts>`，重启即丢**（grep 全仓无 save/load） | **这是它的缺陷，我们必须做得更好**——否则「睡眠只延迟不丢失」不成立 |

## 附录：原型

`prototype/workbench-prototype.html` — 一个文件、三个变体（`?variant=A|B|C`）、`?theme=light|dark` 锁主题、底部悬浮切换条 + 左右方向键。截图在 `prototype/.shots/`。

**丢弃代码，永远不进生产。** 数据全部写死在内存里，无后端、无持久化、无错误处理。留着只为两件事：确认 B 的布局比例（364px 索引 / 720px 阅读栏 / 96px 封面 / 60px 应用栏），以及作为视觉约束表的活样例。A（时间线单列）与 C（高密度运行台）留在文件里备查——如果以后概览页需要更高密度，C 是现成参照。













