# 变更记录

所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本倒序。

> 真机验证证据与复现命令见 [docs/VERIFICATION.md](docs/VERIFICATION.md)；设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

## [未发布]

- **路线图**：新增 [docs/ROADMAP.md](docs/ROADMAP.md)——公开待办清单，按 P0/P1/P2 分级，每条写明「问题是什么 / 改完是什么样 / 怎么验收」
- **算法文档**：`docs/ALGORITHMS.md`——各出口的省量算法、阈值与 token 估算口径首次成文
- **保真度 benchmark**：`test/benchmark.mjs`（`node test/benchmark.mjs`）——9 个预埋锚点夹具实测压缩后上下文失真度：零捏造、critical 锚点 100%、对比朴素截断基线；兼作回归门禁（退出码门槛）。方法论与结果解读见 `docs/BENCHMARK.md`
- **P0 收口：宿主 `e.input` 字段名核对**——确认真机事件里工具入参对象恒在 `e.input` 上且是**普通对象**
  （非 JSON 字符串）。三条证据闭合：宿主 bundle 反查（folded envelope 只抽走
  `tool/tool_use_id/agentId/consent`，`input` 不在其中）+ 真机 Read 档标记（11 处 `回看: Read offset=`）
  + 全量 transcript 反查（**判不出路径 = 0 条**）。详见 [docs/VERIFICATION.md §8](docs/VERIFICATION.md)
  - 新增 `test/audit-tiers.mjs`（`node test/audit-tiers.mjs`，`--json` 供 CI）——逐工具核对 input 键名、
    统计分档命中率、并把「超预算却没被压缩」逐条归因。退出码 0 = 无缺口，1 = 有「判不出路径」样本
  - `toolPathOf` 导出并补 3 项单测（钉死 `e.input` 是对象这件事），单测 112 → **115** 全绿
  - 附带澄清：`toolPathOf` **只在 read 档被调用**，Write/Edit 走兜底是策略有意为之，不是判据失效
  - 新增 P0 待办：**补 `compress-skipped` 诊断出口**——本次定位耗时最长的不是判据，
    而是"超预算却没被压缩"缺少归因出口（现有诊断只覆盖"结果形状判不出"）

## [0.17.0] · 2026-11-06 —— 锚点扩行：错误行的上下文不再丢失

**一句话**：benchmark 抓出的第一个真实局限——`FATAL: unhandled rejection` 这类行能命中关键词被保留，
但紧随其后的堆栈帧（`    at Worker.run (/srv/worker.js:120:22)`）不含关键词、全落进落盘文件。
上下文里留了"哪里炸了"却丢了"怎么炸的"，排查失败时模型必须多读一次落盘。v0.17 把严重错误行之后的
连续上下文一并保留，并配三处加固防止引入新问题。

| 改动 | 说明 |
|---|---|
| 锚点扩行（hooks/register.ts） | 命中「严重错误」（`FATAL/ERROR/Exception/Traceback/panic/segmentation/core dumped/abort/assertion/错误/异常/崩溃/致命`）的行，在预算内顺带保留其后 **4 个连续行**（堆栈帧/调用链）；总量护栏 ≤60 行 |
| 抽样改按连续块 | 原「逐行均匀撒点」会把连续堆栈帧打散成孤立单行（每帧单独一行就失去意义）。改为按连续块抽样：块整块保留、块内再均匀采样 |
| 关键行字节配额 | 关键行合计 ≤ 预算×42%。防止关键行独占预算把尾部挤出预算、触发尾部硬截断丢掉 `Exit Code` 行（模型就不知道成没成）。超额时锚点块优先保留、其余整块丢弃 |
| 测试 | 单测 109 → **112** 全绿（扩行生效 / 满屏错误护栏 / 不挤掉 Exit Code）；benchmark `stack-trace` 夹具期望信息保留率 **2/6 → 6/6** |

代价如实说：总省量 86.0% → **85.6%**（多留了 4 行堆栈帧）。这是有意付的代价——
压缩率让位于"模型能不能真的排查失败"。

## [0.16.0] · 2026-11-06 —— 模型维度 + 逐压缩事件流

**一句话**：回答两个真实问题——「每个会话每次压缩省了多少（时间轴）」「每个模型总共省了多少」。答案是数据此前根本没记：老账本只有会话级累计值。v0.16 把这两样补进记账，看板随之可视化；**旧账本无法回填**，看板对缺失数据如实显示空态。

| 改动 | 说明 |
|---|---|
| `recordStats`（hooks/register.ts） | 每次压缩多取一次 `$.session.model()`（deny/缺失/异常 → 记 `unknown`，fail-open）；stats JSON 新增 `models`（按模型累计，全史）与 `events`（每次一条 `{t,k,m,tb,ta}`，**封顶最近 300**——保热路径整读整写 ~30KB 量级） |
| 看板首页 | 新增「按模型累计」表：跨会话合并 `models`，按原文 tok 降序；无数据时如实提示旧账本没有该维度 |
| 会话卡片 | 新增「时间轴详情」折叠区：纯 SVG 双折线（虚线=原文、实线=压缩后，x=事件时刻，悬停圆点看工具+模型+数值）+ 该会话按模型小表；events<2 或旧账本 → 空态说明 |
| 测试 | 单测 97+12=**109** 全绿（模型维度+事件流、unknown 回落、封顶 300；buildModel 事件过滤聚合、timelineChart 边界转义、首页块+空态） |

热路径成本如实说：每次压缩的记账从 ~1KB 涨到 ~30KB 整读整写（封顶后不再涨）+ 一次进程内 `model()` 调用，仍远低于压缩本身；`WB_OPS_STATS=0` 全部归零。模型维度只统计 **wb-ops 改写过的工具输出**，不是模型的全部用量。

## [0.15.1] · 2026-11-06 —— 看板显示会话名称

**一句话**：看板卡片头行从纯 hash 改为**会话名主导 + sid8 弱化保留**，名字来自宿主 `workbuddy.db` 的 `sessions` 表（`custom_title` 优先），只读解析、任何失败静默退化为纯 hash。

| 改动 | 说明 |
|---|---|
| `scripts/dashboard.mjs` `sessionNames()`（新导出） | `node:sqlite` 只读打开宿主 db，`select id,title,custom_title from sessions` → `{sid8: 名字}`；try/catch 全包，坏库/缺表/旧 node → `{}` |
| `buildModel(rows, names)` | 第二参可选，命中给 `name`——渲染层据此走 sid 分支，老调用零改动 |
| 卡片头行 | 有名：`名字 + sid8(dim)`；无名：原样纯 hash。名字走 `esc`（单测钉死：恶意会话名注不进脚本） |
| 测试 | +3 项（names 命中/未命中、渲染分支与转义、真 sqlite 临时库 + 坏路径退化）。总单测 94+9=**103** |

限制如实说：`node:sqlite` 在 Node 22 是 experimental（stderr 有一行 ExperimentalWarning，不影响输出）；GUI 改过会话标题后，serve 模式刷新即见，快照模式要重跑生成。

## [0.15.0] · 2026-11-05 —— Web 看板

**一句话**：`node scripts/dashboard.mjs` 读同一份 `stats/` 账本，生成自包含 HTML（零新依赖、纯静态）；`--open` 直接弹浏览器，`--serve [端口]` 起本地服务、刷新即重读。

| 改动 | 说明 |
|---|---|
| `scripts/dashboard.mjs`（新） | `buildModel`（聚合+排序：省量降序，token 优先、老账本回落字节）与 `renderHtml`（卡片式看板）都是纯函数、可单测；CLI 入口 `import.meta.url` 守卫 |
| 口径同源 | 聚合走 `lib/report-core.mjs`，与 `mcp__wb_ops__report`、`hooks/report.mjs` 三方同一数字；页脚写明 token 是估算、只计 Mod 改写的输出 |
| 转义 | sid / tool / kind 全部 HTML 转义（单测钉死） |
| 测试 | `test/dashboard.test.mjs`（新）6 项。总单测 94+6=**100** |

## [0.14.0] · 2026-11-05 —— 报表工具改走 MCP

**一句话**：v0.13.1 的「换钩子时机重试」修法被证伪——GUI 会话里每个钩子拿到的是**同一个**不能注册工具的会话级 core，换时机永远换不到能用的那套。改用插件清单声明 MCP 服务器后，工具由宿主 MCP 管理器注册，与 mod core 无关。

| 改动 | 说明 |
|---|---|
| `.codebuddy-plugin/plugin.json` | 新增 `mcpServers.wb_ops`；工具名 `mcp__wb_ops__report` |
| `mcp/server.mjs`（新） | 零依赖 MCP stdio 服务器：`initialize` / `tools/list` / `tools/call` / `ping`；stdout 只走 JSON-RPC，日志一律 stderr |
| `lib/report-core.mjs`（新） | 聚合 + 渲染的**唯一**实现，MCP 工具与 `hooks/report.mjs` CLI 共用，口径不可能漂 |
| `hooks/register.ts` | 删掉 mod 侧工具注册与 `session.start` 钩子；只留压缩 / 水位 / 压缩保留指示 |
| `scripts/install-gui.mjs` | payload 目录扩到 `+['lib','mcp']`——漏拷任何一个，工具在宿主侧都起不来 |

验收要点：`plugin validate` ✔；安装态探针 `test/probe-installed-mcp.mjs` 真子进程握手 ✔（`initialize` → `tools/list` → `tools/call` 返回真实报表）；单测 94 全绿。完整过程见 VERIFICATION.md §3.7。

## [0.13.1] · 2026-11-05 —— 修报表工具在 GUI 会话注册不上

**根因**（宿主 bundle 反查 + 探针实测）：宿主有两条能力不同的 core——应用级（CLI）允许 mod 注册工具，会话级（GUI）把 `registerTool` 硬绑成 throw；旧实现只在 `session.start` 注册一次，GUI 会话必抛 → 被 fail-open 吞掉 → 工具整个会话不存在。

修复：双入口幂等重试（`session.start` + `prompt.submit`）、注册状态收敛到 `register()` 闭包（宿主每会话重新引导 mod）、主链路零依赖。单测 97 全绿。

> ⚠️ 此修法后被 v0.14 复核证伪（换时机 ≠ 换 core），最终由 MCP 通道根治。保留记录以存教训：**拿到证据时先问它来自哪条路径**。

## [0.13.0] · 2026-11-05 —— token 指标

**一句话**：把"省了多少"从字节换算成人人认得的 token，并让它出现在对话里。

| 改动 | 说明 |
|---|---|
| `estTokens` | 与宿主 `TokenUtils.estimateTokensRough` 逐字同公式：`ceil(中文/1.8)+ceil(其余/4)`；只用于展示，压缩决策仍按字节 |
| 标记行内联省量 | `[wb-ops] 已省略 N 行 · 原文 …≈4.1k tok → ≈1.2k tok（省 71%） · 落盘 …`，四条压缩路径统一 |
| 记账带 token | `stats/<sid8>.json` 增 `tokBefore/tokAfter`（`kinds` 每类也有）；老账本缺字段时报表自动回落字节口径 |
| 默认开 | `WB_OPS_STATS` 默认开，`0` 关；关掉后标记行 token 照旧 |

## [0.12.1] · 2026-11-05 —— 大文件降级 + compact 诊断

**目标**：修掉长会话里水位守卫「双源同失」的窗口。

| 改动 | 说明 |
|---|---|
| 超大 transcript 不再整体拒绝 | 宿主 transcript 只增不减（实测真实会话 21.5MB）。旧实现对 >8MB 判 `transcript too big` → fallback 永久失守。现改为整读后**只解析尾部 ≤4M 字符**，`fs.stat` 预判体积并标 `truncated` |
| `lastInputTokens(txt, from)` | 支持分段起点（尾部首行可能是半行，丢弃不影响结论） |
| `session.compact` 诊断 | 每次 compact 事件写 `debug/compact-<sid8>.json`（不记正文） |

为什么必须修：`usage` 归零的精确时刻 = **pre-message-auto compact 之后**（实测 compact 后 ~8.2 秒才恢复），而 transcript 涨到 8MB 需要长时间积累——两个条件在长会话里必然同时撞上，水位提醒彻底静默。实测代价：22MB 全量读 ≈115ms / 内存 134MB，只在 `prompt.submit` 每轮一次。

## [0.12.0] · 2026-11-05 —— 水位守卫数据源适配

**目标**：让水位守卫在宿主 `$.session.usage().context.tokens` 恒 0 时仍能拿到真实上下文占用。

| 改动 | 说明 |
|---|---|
| `pickWatermark` 嵌套候选 | 认 `context.tokens` / `context.window`（宿主真实形状）；`used<=0` 视为无数据，绝不拿 0 假报水位 |
| `probeTranscript` | 只逆扫 transcript 最后 ≤40 行取最后一条 `providerData.usage.inputTokens`（已含 cache_read）；命中路径缓存、连续 3 次失败即放弃 |
| 沙箱读权限探测 | 结论写 `debug/fsprobe-<sid8>.json`（无正文）；签名不变不重复落盘 |
| 数据源标注 | `watermark/<sid8>.num` 第二行标 `来源 transcript`；宿主修好 binding 后自动回到 usage 直出 |
| 新开关 | `WB_OPS_GUARD_FS=0` 关闭 fallback；`WB_OPS_PROJECTS=<dir>` 覆盖 transcript 目录 |
