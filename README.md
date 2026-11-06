# wb-ops

WorkBuddy 的**上下文治理 Mod**（Mod-first）：进程内 `tool.call` 中间件，在工具结果进入模型上下文之前做确定性压缩，原文落盘可回查。错误输出**永不压缩**。目标只有一个：**降本增效——让进入上下文的每一份 token 都携带高价值信息**。

当前版本 v0.16.0 覆盖 **8 个高频出口 + 通配兜底**：Bash / PowerShell / TaskOutput（shell 类）、Grep / Glob（宿主原生字符串数组 + JSON 数组文本两种形态）、Read（按文件类型分档）、WebFetch / WebSearch（文档骨架）；shell 失败现场附一行 nextAction 提示（dsh-ops「遏制报错重试循环」原则的落点）；省量报表（会话内 `mcp__wb_ops__report` 工具 + 沙箱外 `node hooks/report.mjs` + **v0.15 起 `node scripts/dashboard.mjs --open` 浏览器看板**，按工具类型细分 分类 行；**v0.13 起默认开**，每次压缩的标记行还内联 `≈N tok → ≈M tok（省 P%）`；**v0.14 起该工具由插件清单声明 MCP 服务器提供，不再走 mod 注册**——原因见「v0.14 变更」）；上下文水位守卫（prompt.submit ≥85% 一行提醒）与压缩保留指示（session.compact instructions，Mod 版 PreCompact）；POLICY 之外的所有工具名（MCP、宿主新增）由谓词 matcher 兜底走通用压缩。压缩核心与事件无关，后续按事件逐个拓展到全生命周期出口。命名不叫 `wb-bash-ops` 正是因为这个路线图。

| 工具 | 策略 |
|---|---|
| Bash / PowerShell / TaskOutput | `Exit Code` 非零**完整透传**并附一行 `[wb-ops 提示]`（9 类可识别错误→可执行下一步，模式只扫头尾 4KB；提示门在预算门之前，小失败也管）；超预算压成 头+关键行+尾，尾段保底含退出码行 |
| Grep / Glob | 两种输入形态都接：**① 宿主原生 `content: string[]`**（v0.11 实测真机形态，裁条目+追加单行说明，**保持数组形态**与宿主序列化同构）；**② JSON 数组文本**（前 K 条 + 计数）。整串原文落盘 `.json` |
| Read | 按扩展名分档门槛：数据类（.log/.csv/.jsonl/…）>200 行才裁；.json/.md >800 行（≥40KB 的少行 dump 走硬阀）；**源码 <1500 行一律不裁**（读完多半要接着改，中段不能丢）。空洞 ≥20 行给 `回看: Read offset=N limit=M` 指路。宿主自己落的 `<persisted-output>` 不碰 |
| WebFetch / WebSearch | 标题/链接/加粗行当骨架捞回，正文段省略 |
| 其余全部工具（③ 兜底） | 谓词 matcher 接住 POLICY 之外的任何工具名（MCP `mcp__*`、宿主新增）：通用压缩，`Exit Code` 非零同样整场透传；预算内零影响；`WB_OPS_FALLBACK=0` 单独关 |

所有档位共用：**预算按 UTF-8 字节计**（按字符会放过中文越线输出——sana 从 v0.2.2 起吃过同样的亏，单测钉死）；原文 >8MB 或异常形状 → 透传。

与 [sana35421/wb-ops](https://github.com/sana35421/wb-ops)（shell-hook 路线）的关系：**互补且可共存**。它覆盖不了 Bash（宿主只给 Hook 元数据、拿不到正文），这条路只有 Mods 能走；双压防护使用它的真实标记前缀（`[wb-ops 省略` / `[wb-ops 以下为原文末尾`），互不误伤。长期看本插件的 Mod 路线会覆盖它的全部场景。

设计原则继承 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)（有界输出、可回查的 spill、遏制报错循环），代码为 WorkBuddy 专用壳 + 零依赖纯 TS 核心，不复用其 DSH 专有宿主层。

## 为什么载体是 Mod，不是 MCP / Skill / shell hook

| 载体 | 判定 |
|---|---|
| shell hook (PostToolUse) | `tool_response` = `rawResponse`，Bash 只有 exitCode/截断标志，没有正文——**做不到** |
| PreToolUse `updatedInput` | 只在 `permissionDecision === "allow"` 时生效，等于自动放行命令——**不可接受** |
| MCP 工具 | 需要模型主动调用才压缩；自带 schema token；看不见内建工具输出——**不确定** |
| Skill | 提示词级约定，模型可忽略——**不确定** |
| **Mod `tool.call`** | 宿主强制执行、进程内、零 spawn、可改写任意工具结果——**确定性拦截** |

注意这张表说的是**压缩**为什么必须是 Mod。v0.14 起「报表」这一个**只读查询**工具改用 MCP：它需要的是「被注册成一个工具」，而不是「拦截别人的输出」——而 mod 的会话级 core 恰好不提供注册能力（见「v0.14 变更」）。载体按职责选，不按主义选。

## 它如何规避 sana35421/wb-ops 的 5 秒超时事故

实测根因：其 UserPromptSubmit 每个回合同步起 Git Bash（本机实测 2.1–2.6s）+ node 冷启动 + 扫最大 16MB transcript，并发时必击穿 5s 预算。本项目对策：

1. **零子进程**——只注册 Mod，`hooks.json` 里没有任何 `command` hook（只有一个 `modules` 数组）。
2. **不做全量 transcript 扫描**——水位守卫只在 `prompt.submit`（每轮用户提交一次，不在 tool.call 热路径）读 `$.session.usage()`（O(1)）；宿主 binding 短暂归零时 v0.12 才追加一次**有界尾部采样**：只逆扫最后 ≤40 行 JSONL、命中路径缓存、连续 3 次读失败即放弃，且可用 `WB_OPS_GUARD_FS=0` 一键关掉。与事故里「每回合扫 16MB + 起进程」不是一个量级。
   - **v0.12.1 超大文件降级**：宿主 transcript 只增不减（实测长会话可达 20MB+），且 `usage` 恰好在 `pre-message-auto` compact 后约 8 秒内归零——这两个条件会同时撞上。旧实现对 >8MB 直接判 `transcript too big` → 该窗口内 fallback 永久失守。现改为：仍整读（实测 22MB ≈115ms，内存代价可控），但**只解析尾部 ≤4M 字符**、并用 `fs.stat` 预判体积、在 debug 里标 `truncated`——**不再因为体积而整条链路失守**。
3. **软超时自弃**——压缩自带 100ms 预算（可调），超时放弃、透传原文。
4. **fail-open**——未知结果形状、任何异常、`isError`、非零退出码：一律原样返回。插件坏掉的最坏情况 = 当它不存在。
5. **无共享可变状态文件**——spill 路径 `spill/<session前8位>/<序号>-<callId>.txt`，并发不互踩（50 路并发有单测）。
6. **触发频率天然低**——事故源在每个回合同步跑；我们只在「Bash 且超预算且退出码 0」时才做 IO，低于预算的调用一个 `indexOf` 就返回。

### 热路径延迟实测（本机，v0.3 压缩机：逐行 KEY 匹配 + 全量字节计量）

| 输入 | 冷启动+5 连跑最差 | 说明 |
|---|---|---|
| 150KB（3k 行） | 11.3ms | 典型大输出 |
| 1MB（20k 行） | 37.3ms | |
| 5MB（100k 行） | 52.7ms | |
| 10MB（200k 行） | 100.7ms | 100ms 软超时自弃生效；包装层字符预检更是直接跳过 |

唯一的同步 IO 是落盘 `$.fs.write`，已封顶：**原文 >4MB 不落盘**（仍压缩，标记如实写「未落盘（原文过大或写入失败，可重跑命令）」）。引擎侧还有最后一道兜底：Mod 每钩 10s 预算且失败隔离上报——即便我们全部失算，结局也只是「这一条不压」，不会像 shell hook 那样把用户按回车整条阻塞掉。

**后续拓展所有事件时的纪律**（写在这里就是为了下次不破坏它）：任何新 handler 必须保持——零子进程、只读 O(1) 宿主状态、扫描必须带 deadline、写必须带 size cap、保持 fail-open。

## 行为（shell 类输出的压缩形态）

超过 8000 字节（可调）且退出码为 0 的 Bash 输出被压成：

- 自适应头部（按平均行长定行数，8–400 行，预算利用率不足自动放大；含 `Command:` 行——模型得知道当时跑了什么）
- 中部关键行（error/fatal/traceback/错误/失败/警告/异常/… 中英并集，至多 40 条，超出均匀撒点；连续一段等于没省）
- 自适应尾部（保底含 `Exit Code:` 行）
- 少行巨字节特例：整串行数 ≤20（minified、单行 JSON dump）走字节级首 60%+尾 28% 截断，不会一裁就没
- 一行标记：`[wb-ops] 已省略 N 行 · 原文 12.4KB≈4.1k tok → ≈1.2k tok（省 71%） · 落盘 ~/.workbuddy/wb-ops/spill/<sid8>/<seq>-<callId>.txt`

模型需要细节时用 Read/Grep 读 spill 路径（Read 档还给 offset/limit 指路）。已带 `[wb-ops]` 或 sana 标记前缀的文本不再二次压缩。

## 安装

### 方式一：跟 AI 说一句话（推荐）

把下面这句直接发给 WorkBuddy 对话里的 AI，剩下的它来做（克隆 → 安装 → 校验 → 告知生效方式）：

> 帮我安装 wb-ops 插件：克隆 https://github.com/njuptlzf/wb-ops 到 ~/work/wb-ops，然后运行 `node scripts/install-gui.mjs` 完成安装，再用 `plugin list` 确认 `wb-ops@wb-ops-local` 显示 enabled，最后告诉我怎么让它生效。

AI 会执行三步：`git clone` → `node scripts/install-gui.mjs`（写齐宿主加载必需的三处：市场清单 + installed_plugins + `enabledPlugins`，缺一不可）→ `plugin list` 自检。装完**新开一个对话**即生效（mod 在运行时启动时引导，`/reload-plugins` 不会重新引导）。

已装好想升级？同一句话换成：

> wb-ops 出新版了：在 ~/work/wb-ops 里 `git pull` 后重新运行 `node scripts/install-gui.mjs`，确认 plugin list 版本号已更新。

不想要了：

> 卸载 wb-ops 插件：运行 `node scripts/install-gui.mjs --uninstall`（只摘它自己，不动其他插件）。

### 方式二：命令行（手动）

**CLI**（已验证加载）：

```bash
node "<WorkBuddy>/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs" --plugin-dir <wb-ops 目录>
```

加载成功时输出 `mods: loaded mod "wb-ops" from .codebuddy-plugin (tier user, hooks: tool.call)`。

**GUI**：跑一次 `node scripts/install-gui.mjs`——写三处，缺一不可（宿主运行时投影 = `enabledPlugins` + `installed_plugins.json` + `cache/<mkt>/<plugin>/<version>`，见官方《插件市场》文档）：

| 落点 | 内容 | 缺了会怎样 |
|---|---|---|
| `plugins/marketplaces/wb-ops-local/.codebuddy-plugin/marketplace.json` | 市场清单（`plugins[0].source="./wb-ops"`） | 宿主列不出该市场，`/plugin` 的「市场」页里没有它 |
| `plugins/installed_plugins.json` → `wb-ops@wb-ops-local` | 安装记录（指向 cache 快照） | 不在「已安装」列表里 |
| `settings.json` → `enabledPlugins["wb-ops@wb-ops-local"]=true` | 期望启用态 | `status=disabled`，mod 永不加载（这一条最容易被漏） |

同时复制 payload 到 `marketplaces/` 与 `cache/wb-ops-local/wb-ops/<version>/`；合并不覆盖既有市场与别人的 `enabledPlugins` 声明，卸载 `node scripts/install-gui.mjs --uninstall` 只摘自己（离线单测在临时 HOME 钉死这些形状）。

**生效方式**：mod 的中间件在**运行时启动时**引导（`bootstrapFunctionHookMods`），`/reload-plugins` 不会重新引导——所以**新开一个对话/新起一个会话**即可生效；想要本会话立刻生效就重启 WorkBuddy。命令行侧等价操作：`/plugin`（发现/已安装/市场/错误四页）、`/plugin marketplace add`、`/plugin install wb-ops@wb-ops-local`、`/plugin enable`。

**自检**（宿主自带校验器）：

```bash
node "<WorkBuddy>/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs" plugin validate C:/Users/kingdee/work/wb-ops
node "<WorkBuddy>/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs" plugin list   # 应见 wb-ops@wb-ops-local  Status: enabled
```

注意：与 sana 的 `wb-ops` 插件名相同，若两者都要装，用不同 marketplace 名或只走 `--plugin-dir`，避免插件缓存键冲突。

## 验证：跟 AI 说一句话

装完**新开一个对话**，把这句发给 AI（分层检查：加载态 → 压缩实测 → 诊断落盘）：

> 验证 wb-ops 插件是否正常工作：① 运行 `plugin list` 确认 wb-ops@wb-ops-local 是 enabled；② 执行 `seq -f "row-%04g" 1 1200`（约 11KB 输出，落在 4500B~宿主阈值的压缩区间），检查输出是否出现 `[wb-ops]` 压缩标记和 `落盘` 回查路径；③ 列出 `~/.workbuddy/wb-ops/debug/` 和 `~/.workbuddy/wb-ops/watermark/` 下的文件，报告 fsprobe 的 ok/err 与水位数据源；④ 把结论汇总给我。

预期结果：② 输出被压缩成 头+关键行+尾 并附 `原文 NNKB → 落盘 …/spill/<sid8>/N-*.txt`；③ `fsprobe-<sid8>.json` 为 ok（或 ENOENT——文件不存在不是权限问题），`watermark/<sid8>.num` 存在且首行是剩余 token 数。

只想快速看压缩是否生效，一句话就够：

> 运行 `seq -f "row-%04g" 1 1200`，告诉我输出里有没有 `[wb-ops]` 标记和落盘路径。

想知道**为什么信得过这个插件**（验证流程、原始数据、复现命令），见 [VERIFICATION.md](VERIFICATION.md)——v0.12.0 三项验收与 v0.12.1 大文件降级的全部真机证据都在里面，包括两条可复用的宿主验证通道（settings.json env 注入、CLI 固定 sid + 预置 transcript）。

## 怎样看到省了多少（v0.13）

token 数是**估算**，公式与宿主 `TokenUtils.estimateTokensRough` 逐字相同：`ceil(中文/1.8) + ceil(其余字符/4)`（`estTokens`，与 wb 自己的计数同源）。压缩决策仍按字节——字节是保守上界，token 只用于展示。

| 想看的 | 怎么做 | 在哪显示 |
|---|---|---|
| 单次压缩省了多少 | 不用做：每次压缩的 `[wb-ops]` 标记行自带 `原文 …≈N tok → ≈M tok（省 P%）` | 就在 wb 对话的工具结果里 |
| 本机累计（按工具类型细分） | 在新会话说「调 `mcp__wb_ops__report`」，或沙箱外 `node hooks/report.mjs` | wb 聊天 / 终端 |
| 每个会话省了多少（v0.15） | `node scripts/dashboard.mjs --open`（生成 `~/.workbuddy/wb-ops/dashboard.html` 并用浏览器打开）；或 `--serve [端口]` 挂本地服务，刷新即重读账本 | 浏览器看板：**会话名称**（v0.15.1，hash 弱化保留）+ 省量条 + kinds 明细 |
| 每个模型省了多少 / 单会话时间轴（v0.16） | 同上，看板自动带：首页「按模型累计」表；会话卡片内「时间轴详情」展开 | 首页模型表（次数/原文/压缩后/省%）；详情 SVG 双折线（x=时刻，悬停圆点看该次工具+模型） |
| 原始记账数据 | `~/.workbuddy/wb-ops/stats/<sid8>.json`：`{calls,before,after,tokBefore,tokAfter,kinds,models,events}`（后两个 v0.16 起） | 文件 |

报表长这样：

```
[wb-ops 报表] 压缩 7 次 · 省 ≈8.4k tok / 33.0KB (78.6%) · 原文 42.0KB≈10.8k tok → 压缩后 8.0KB≈2.4k tok · 记账会话 2 个
  分类：shell 5次 ≈7.2k→1.1k tok · jsonlist 2次 ≈3.6k→1.3k tok
```

记账 **v0.13 起默认开**（`WB_OPS_STATS=0/off/false/no` 关）：每次压缩多一对小 JSON 读写（约 1KB）；会话启动多起一个报表 MCP 进程（v0.14 起，`node mcp/server.mjs`，闲置时只占管道不占 CPU），工具 schema 约百余 token。嫌贵就设 `WB_OPS_STATS=0`——标记行里的内联 token 数字不受影响，仍随时可见；MCP 进程与工具是否随该变量消失未做联动（工具在、数据为空时会如实回「还没有记账数据」）。

### Web 看板：怎么启动、数据怎么更新（v0.15）

两条启动路，都在**仓库根目录**跑，零依赖（只要 node）：

| 模式 | 命令 | 行为 |
|---|---|---|
| 快照 | `node scripts/dashboard.mjs` | 生成 `~/.workbuddy/wb-ops/dashboard.html` 并打印路径（`--out <路径>` 换位置；`--open` 顺带用默认浏览器打开）。数据是**生成一刻**的账本，想看最新就重跑 |
| 常驻服务 | `node scripts/dashboard.mjs --serve [端口]` | 默认 8765，浏览器开 `http://127.0.0.1:8765`。**每次刷新重读账本**，wb 会话里刚压完，刷新页面就涨上去；`Ctrl+C` 停 |

数据更新机制：看板**不连任何服务、不写数据库**，只读 `~/.workbuddy/wb-ops/stats/<sid8>.json`。记账开着时（v0.13 起默认开），wb 进程内的 mod 在**每次成功压缩后**整读整写那个小文件——读现值，累加本次 `before/after/tokBefore/tokAfter` 和按工具类型的 `kinds`，写回。所以账本是"边压边写"的，看板与账本之间没有任何缓存：快照模式生成时读一次，serve 模式每个请求读一次。`WB_OPS_STATS=0` 关掉后账本停止更新，看板显示的就是停更前的数据（历史会话的条目照常在）。

会话名称（v0.15.1）：卡片头行以**会话名为主、hash 弱化保留**（名字旁边就是 sid8，与 `stats/`、`spill/` 目录一一对得上）。名字从宿主 `~/.workbuddy/workbuddy.db` 的 `sessions` 表只读解析（`custom_title` 优先于 `title`，即你在 wb 里改过名就用改名），stats 文件名只存前 8 位，按 `sid8` 前缀匹配。用 node 内置 `node:sqlite`（Node ≥22.5），零新依赖；db 缺失、表结构变更、node 版本不够——任何一环不对就**静默退化为纯 hash 展示**，看板不报错。serve 模式每次刷新重查，会话改名后刷新即见。

时间轴详情与按模型（v0.16）：记账文件每条多两个维度——`models`（按模型累计，全史）与 `events`（每次压缩一条 `{t,k,m,tb,ta}`，封顶最近 300 次，更早只进累计）。看板首页因此出现「**按模型累计**」表（跨会话合并：次数/原文/压缩后/省%）；每张会话卡片有「**时间轴详情**」折叠区：纯 SVG 双折线（x=压缩时刻，虚线=原文 tok、实线=压缩后 tok，悬停圆点显示该次工具+模型+数值）+ 该会话按模型小表。模型名取自 `$.session.model()`，宿主拿不到/deny 时记 `unknown`，绝不反噬主流程。**诚实的边界**：v0.16 之前的旧账本没有这两个字段——看板如实显示空态提示，历史无法回填；只有升级后新发生的压缩进事件流。

## 配置（环境变量，经 `$.env.get` 读取）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WB_OPS` | 开 | `0/off/false/no` 全局关闭 |
| `WB_OPS_BUDGET` | 4500 | 压缩后文本字节上限（>512 才生效）；与 sana 同名同义，共存时一个值管两边。**v0.11 由 8000 下调**：宿主 `persisted-output` 落盘阈值实测 ≈8KB，预算贴死阈值会让 mod 的可压缩区间被宿主抢走，4500 留 ~45% 余量 |
| `WB_OPS_DEADLINE_MS` | 100 | 压缩自设软超时；`0` 等效禁用压缩 |
| `WB_OPS_STATS` | 开 | **v0.13 默认开**。`0/off/false/no` 关闭省量记账：每次成功压缩更新 `~/.workbuddy/wb-ops/stats/<sid8>.json`（整读整写小计数器，含按工具类型细分的 `kinds` 与 token 口径 `tokBefore/tokAfter`，非无界追写；挂了不影响压缩，有单测钉死）。开启后会话启动时注册 `mcp__wb_ops__report` 报表工具；沙箱外可跑 `node hooks/report.mjs`。关掉只少了累计报表，标记行的内联 token 数字照旧 |
| `WB_OPS_HINTS` | 开 | `0/off/false/no` 关闭 shell 失败现场的 nextAction 提示（提示只加一行，不占压缩预算） |
| `WB_OPS_GUARD` | 开 | `0/off/false/no` 同时关闭 #4 水位守卫（prompt.submit 提醒）与 #5 压缩保留指示（session.compact instructions）。守卫进程内读取，**无子进程**（v0.12 起 usage 恒 0 时有界尾部采样，见下） |
| `WB_OPS_FALLBACK` | 开 | `0/off/false/no` 关闭 ③ 通配兜底（只保留 8 个白名单出口） |
| `WB_OPS_GUARD_PCT` | 85 | 水位提醒阈值（上下文占用百分比）；形状判不出则静默，绝不误报。guard 开启时每轮把余量写入 `~/.workbuddy/wb-ops/watermark/<sid8>.num`（首行=剩余 tok，模型可 Read 主动查；写失败静默；数据源非 usage 时第二行标注 `来源 transcript`） |
| `WB_OPS_GUARD_FS` | 开 | **v0.12** `0/off/false/no` 单独关闭 transcript fallback（只认 `$.session.usage()` 直出的数值）。宿主修复 binding 后可用它验证 mod 是否还依赖 fallback |
| `WB_OPS_PROJECTS` | 空 | **v0.12** 覆盖 transcript 目录（默认 `<HOME>/.workbuddy/projects`）。CLI 用自定义 `CODEBUDDY_CONFIG_DIR` 导致 HOME 推导错时手动指定 |

## 诊断通道（v0.11–v0.12）

宿主工具结果的形状**逐工具不同**，还会随宿主升级变化。v0.11 起落**只记结构、不记正文**的诊断通道，省得每次都去 180MB bundle 里捞：

| 文件 | 记什么 | 什么时候写 |
|---|---|---|
| `~/.workbuddy/wb-ops/debug/shape-<sid8>.json` | 工具名 + result 的键名/类型/长度（**无正文**） | 判不出文本形状**且**内容超预算时，每会话最多 20 条 |
| `~/.workbuddy/wb-ops/debug/usage-<sid8>.json` | `$.session.usage()` 的返回形状（键名/类型/数值）+ deny 文案 | 形状**变化**时（形状不变不重复写，避免每轮落盘） |
| `~/.workbuddy/wb-ops/debug/fsprobe-<sid8>.json` | **v0.12** transcript 沙箱读权限探测：`ok/err/path/bytes/truncated`（路径是目录名，无正文） | 结论**变化**时（首次 fallback、读权限变化、transcript 出现、体积跨过 8MB 门槛） |
| `~/.workbuddy/wb-ops/debug/compact-<sid8>.json` | **v0.12** `session.compact` 事件：`trigger/hadBase/baseLen/mergedLen/hasRetention`（**不记正文**） | 每次 compact 事件（用于验证压缩保留指示真的合并进 instructions） |

隐私纪律：字符串一律只记长度，正文永不落盘。宿主升级后若某通道突然不生效，先看这三个文件。

## 开发 / 测试

```bash
node --test test/register.test.ts   # 91 项，全绿（需 Node ≥22.6 的 --experimental-strip-types，或 Node 23+ 直接跑）
bash test/run-acceptance.sh <合法UUID> "验收" WB_OPS_GUARD_PCT=10   # 真机验收触发器（无需登录，见脚本头注释）
```

验收的完整流程、原始数据与结论见 [VERIFICATION.md](VERIFICATION.md)。

沙箱纪律：mods 内禁止 `node:require/process/global`（引擎会当场拒绝整个 mod），`register.ts` 唯一的 import 是 `codebuddy-code` 的**纯类型**导入，运行时被擦除。所有宿主能力走 `$`：`$.env` / `$.fs.write` / `$.session.id()`。

## 宿主工具结果形状实测（2026-11-05 真机，v0.10 观测 / v0.11 适配）

从本会话 transcript（`~/.workbuddy/projects/<cwd>/<sid>.jsonl`，顶层 `function_call_result` 记录）反查 `providerData.toolResult`：

| 工具 | `toolResult.content` 类型 | extractText 命中 | 实测 |
|---|---|---|---|
| Bash / PowerShell | string | ✅ | 压缩生效 |
| Read / TaskOutput | string（宿主落盘后为 `<persisted-output>` 摘要） | ✅ | 压缩生效 |
| WebFetch / Edit / TaskCreate / ToolSearch | string | ✅ | 多在预算内透传 |
| **Grep** | **string[]**（如 37 条路径） | v0.10 ❌ → **v0.11 ✅** | 原生数组分支已适配（裁条目+单行说明，保持数组形态） |
| Glob | string[] / string | 部分 | 大结果已被宿主先落盘 |
| MCP（DeferExecuteTool 等） | string | ✅ | 走 ③ 兜底，压缩生效 |

宿主 `persisted-output` 落盘阈值 ≈ **8KB**（"Output too large (8.3KB)"）——v0.10 的 8000B 预算几乎与阈值重合：**超过宿主阈值的输出宿主先落盘，mod 实际只在 [预算, 阈值) 的窄带里有机会**。v0.11 默认预算下调到 4500，把这段「宿主不管」的区间真正留给 mod（见 `WB_OPS_BUDGET`）。

`$.session.usage()` 宿主契约（bundle 实测）：`case "session.usage": return i.usage ? core_handler_value(await i.usage(h)) : deny("$.session.usage", "the host did not wire this capability")`；`core_handler_value(t) => {value:t}`、`deny(t,i) => {deny:"..."}`。宿主自身 session 对象上有 `usage?.outputTokens`（**未发现"上下文占用 / 窗口大小"语义**）。v0.11 起真实形状会落到 `debug/usage-<sid8>.json`（只记结构），语义确认前守卫保持静默。

## 已验证 / 未验证

- ✅ **③ 通配兜底的谓词 matcher（2026-11-05 真机闭环）**：`domain_search` 输出 52.1KB → 兜底压缩生效（头部 + `命中关键行` + 尾部，`[+NNNNB]` 单行截断正常）。函数谓词每次事件重评、路由真实生效。
- ✅ mods 加载（CLI 启动日志 `hooks: tool.call prompt.submit session.compact` 三通道全注册；v0.14 起 `session.start` 已删——它只为已废弃的 mod 侧工具注册而存在）、沙箱合规、压缩策略、透传条件、spill、并发去重、字节预算、分工具策略、错误 nextAction 提示（模式表命中/扫描窗封顶/可关/防重复）、水位守卫与压缩保留指示（形状候选/阈值边界/关闭零触碰/fail-open）、③ 通配兜底（预算内零影响/非零透传/可关/谓词互斥）、① by-kind 分类账本（kinds 写入/聚合/渲染、无 kinds 老账本兼容）、② 水位数值文件（每轮小写/越线附带 Read 路径/写失败静默/stats-off 仍跟 guard）、④ GUI 安装助手（临时 HOME 装+卸、known/installed 形状、既有市场保留、cache payload 落地）、v0.11 形状诊断通道（只记结构/只记长度/限频/小输出不打扰）、v0.12 水位数据源（嵌套 context 候选/tokens=0 静默/transcript 尾部逆扫/权限探测/目录兜底/可关）、v0.13 token 口径（估算公式/标记行内联省比/记账 tok 字段/默认开/关掉零 IO）、v0.14 报表 MCP（渲染口径/坏文件跳过/真实子进程 JSON-RPC 握手/清单守卫）、v0.15 Web 看板（排序/字节回落/空账本/头行/转义）、v0.15.1 看板会话名（sqlite 解析/custom_title 优先/坏库退化）、v0.16 模型维度与事件流（models 累计/events 封顶 300/unknown 回落/时间轴 SVG/首页按模型块）——离线 mock API 单测 **109 项全绿**（`node --test test/register.test.ts test/dashboard.test.mjs`）
- ✅ Grep/Glob 输出形状：从 86 条真实 transcript 确认 = JSON 字符串数组；**2026-11-05 真机再测发现宿主原生形态是 `content: string[]`**（不是 JSON 文本）→ v0.11 已适配（单测钉死：裁条目+单行说明、保持数组形态、预算内零影响、混合类型仍 fail-open）
- ✅ **真机压缩闭环（2026-11-05 GUI 会话，pid 72880）**：Bash 13.2KB / PowerShell 14.9KB / TaskOutput 30.4KB / Read .log 24.5KB（含 `回看: Read offset=34 limit=180` 空洞指路）/ MCP 兜底 52.1KB / 错误现场 Exit Code 2 完整透传 + `[wb-ops 提示]` 一行 / 预算内零影响 / Read .ts 682 行原样不裁——5 次 spill 落盘 135KB
- ✅ **报表工具（v0.14 已根治）**：`mcp__wb_ops__report` 现由插件清单 `mcpServers.wb_ops` 声明、宿主 MCP 管理器起进程注册，与 mod core 的能力差异完全解耦。已验：清单 `plugin validate` ✔、安装树入口真实跑通（`initialize` → `tools/list` → `tools/call`，见 `test/probe-installed-mcp.mjs`）、面板版本读的是 plugin.json（打印 0.14.0）。**唯一未验**：GUI 新会话里工具是否出现在清单——需要 `/reload-plugins` 或新开会话，见「v0.14 变更」。
- ✅ **`${CODEBUDDY_PLUGIN_ROOT}` 在 plugin mcpServers 里会被替换（bundle 反查实锤）**：`enrichWithPluginEnvironment` 对 stdio 声明做 `command`/`args`/`cwd` 三项替换并注入插件环境变量，故 `args: ["${CODEBUDDY_PLUGIN_ROOT}/mcp/server.mjs"]` 是官方支持的写法（内置插件 builtin-calendar / workbuddy-sheetagent 同法）。
- ✅ **v0.12 水位数据源根因已实锤（2026-11-05 bundle 反查）**：`$.session.usage()` 的真实实现是宿主 `createModsUsageBinding`，返回 `{context:{tokens,window,percent},rateLimits:[]}`（**没有 ` {value:…}` 包装层，之前的猜测作废**）。`window` 由 `resolveSessionContextBudget` 真算（本会话 300000，可信）；`tokens = getCurrentContextUsage(session)?.totalInputTokens ?? 0`，而 mods 持有的 session 上 `getLatestUsageSnapshot` 缺失 ⇒ **恒 0**。数据本身健康：transcript JSONL 每条模型响应都带 `providerData.usage.inputTokens`（实测单调 31737→71198，已含 cache_read），宿主 ACP 的 `usage_update` 也用 `getLatestUsage()?.inputTokens`。**断点在宿主 mods 绑定层，不在数据源**——可向宿主报 issue。
  v0.12 对策：`pickWatermark` 认嵌套 `context.tokens/window`（宿主修好后自动点亮，`tokens=0` 仍静默）；否则走 transcript 尾部采样取 used、window 仍用 `usage().context.window`；读权限探测落 `debug/fsprobe-<sid8>.json`。**待真机确认**：mod 沙箱 `$.fs` 能否读 `<HOME>/.workbuddy/projects/`（若被拒，看 fsprobe 的 err，守卫继续保持静默）。
- ⚠️ **宿主 `persisted-output` 阈值 ≈8KB 是硬天花板**：超过它宿主先落盘，mod 看不到原文（README 明确"宿主落的 persisted-output 不碰"）。所以 mod 的实际收益上限 = (预算, 8KB) 区间 + 宿主未落盘的其余工具。v0.11 预算降到 4500 正是为了把这块区间吃满。
- ⚠️ **`tool.call` 事件里 `e.input` 的确切字段名**（代码候选 `input/tool_input/arguments` + `file_path/path/filePath`，判不出即透传，不会误伤）——Read 分档已真机验证（.log 走数据档、.ts 走源码档）；其余工具的 input 字段名仍未逐个核对。
- ⚠️ **`prompt.submit` 返回 `{text,context}` 的宿主合并行为**——✅ **v0.12.1 已真机验证**：`[wb-ops 水位] 上下文约 100%（300000/300000 tok）… 余量速查：Read …/watermark/wbo0guar.num` 真实注入（宿主包成 `<system-reminder>` 进 input），`session.compact` instructions 合并也已真机验证（`debug/compact-<sid8>.json` 记 `trigger:"auto"` / `mergedLen:73` / `hasRetention:true`，真 auto-compact 的 `compactType=pre-message-auto` / `compactionTrigger=pre_message_threshold`）。
- ✅ **v0.12.1 大文件降级已真机验证**：用真实 21.5MB 会话文件跑 mod → `fsprobe` 得 `{"used":410003,"bytes":22666447,"truncated":true}`、`watermark` 标「来源 transcript」，与全文解析**完全一致**；旧错误 `transcript too big` 归零。实测 22MB 全量读 ≈115ms、内存 134MB，只在 `prompt.submit` 每轮一次。
- ⚠️ GUI 注册表写入格式对照本机宿主自写文件（sana `local@` 记录）复刻，install-gui.mjs 有离线装/卸单测，但 **GUI 重启后的插件列表识别与启用点击**未验证（真机已确认 mod 会加载，即注册表三件套有效）。

## 2026-11-05 真机安装闭环（官方《插件市场》文档校对）

宿主加载一个 mod 需要三处同时成立（`enabledPlugins` + `installed_plugins.json` + `cache` 快照），**只登记 installed 条目是不够的**——`getInstalledPluginsForWorkspaceState` 的候选集直接来自 `enabledPlugins` 映射，缺它则 `status=disabled`，插件连「已安装」列表都进不去，mod 永不加载。这条是原 `install-gui.mjs` 的漏项，已补：

| 落点 | 状态 |
|---|---|
| `marketplaces/wb-ops-local/.codebuddy-plugin/marketplace.json` | ✅ 已补（官方要求：市场根目录必须有） |
| `installed_plugins.json` → `wb-ops@wb-ops-local` | ✅ 原有 |
| `settings.json` → `enabledPlugins["wb-ops@wb-ops-local"]=true` | ✅ 已补（原漏项） |

本机真机验证（`CODEBUDDY_CONFIG_DIR` 指到 `~/.workbuddy`）：

- `plugin validate` 对插件清单与市场清单**双双 ✔ Validation passed**；
- `plugin list` → `wb-ops@wb-ops-local / 0.10.0 / user / Status: enabled`；
- 宿主打印 `mods: loaded mod "wb-ops" from .codebuddy-plugin (tier user, hooks: tool.call session.start prompt.submit session.compact)`——**走市场安装路径加载**（不带 `--plugin-dir`）；
- 会话日志 `~/.workbuddy/logs/<date>/<cwd>__<sid>.log` 里可见该行：mod 在**新起的运行时**（新 pid）里生效，老运行时（启用前启动的）不加载 → 启用后要**新开对话**才生效，`/reload-plugins` 不重新引导 mod（`bootstrapFunctionHookMods` 只在启动时调用且被记忆化）。

其余待验证项（①②③④）待新会话里跑：宿主 Bash 大输出会先被自家 `<persisted-output>` 落盘（121KB），mod 的 `tool.call` 中间件看到的是压缩前还是压缩后的结果，需实测确认。

## v0.16 变更（2026-11-06）—— 模型维度 + 逐压缩事件流：点进会话看时间轴，首页看每个模型

**一句话**：回答两个真实问题——「每个会话每次压缩省了多少（时间轴）」「每个模型总共省了多少」。答案是数据此前根本没记：老账本只有会话级累计值，无逐事件序列、无模型维度。v0.16 把这两样补进记账，看板随之可视化；**旧账本无法回填**，看板对缺失数据如实显示空态。

| 改动 | 说明 |
|---|---|
| `recordStats`（hooks/register.ts） | 每次压缩多取一次 `$.session.model()`（宿主 bundle 有 `session.model` 事件；deny/缺失/异常 → 记 `unknown`，fail-open）；stats JSON 新增 `models`（按模型累计，全史）与 `events`（每次一条 `{t,k,m,tb,ta}`，**封顶最近 300**——保热路径整读整写 ~30KB 量级，ponytail 注释标了升级路径） |
| 看板首页 | 新增「按模型累计」表：跨会话合并 `models`，按原文 tok 降序，次数/原文/压缩后/省%；无数据时如实提示旧账本没有该维度 |
| 会话卡片 | 新增「时间轴详情」折叠区：`timelineChart(events)` 纯 SVG 双折线（虚线=原文、实线=压缩后，x=事件时刻，悬停圆点 `<title>` 看工具+模型+数值）+ 该会话按模型小表；events<2 或旧账本 → 空态说明 |
| `test/register.test.ts` | +3 项（模型维度+事件流、unknown 回落×2 路径、封顶 300 且累计不受影响）。harness 默认 mock `session.model`，`modelNoApi/modelThrows` 模拟降级 |
| `test/dashboard.test.mjs` | +3 项（buildModel 事件过滤+模型聚合排序、timelineChart 边界+转义、renderHtml 首页块+空态）。总单测 97+12=**109** |

热路径成本如实说：每次压缩的记账从 ~1KB 涨到 ~30KB 整读整写（封顶后不再涨）+ 一次进程内 `model()` 调用，仍远低于压缩本身；`WB_OPS_STATS=0` 全部归零。口径不变：token 估算公式与宿主同源，模型维度只统计 **wb-ops 改写过的工具输出**，不是模型的全部用量。

## v0.15.1 变更（2026-11-06）—— 看板显示会话名称：hash 是谁不知道，名字一看就懂

**一句话**：看板卡片头行从纯 hash 改为**会话名主导 + sid8 弱化保留**，名字来自宿主 `workbuddy.db` 的 `sessions` 表（`custom_title` 优先），只读解析、任何失败静默退化为纯 hash。

| 改动 | 说明 |
|---|---|
| `scripts/dashboard.mjs` `sessionNames(statsDir)`（新导出） | `node:sqlite` 只读打开 `<home>/.workbuddy/workbuddy.db`（从 stats 目录 `../..` 推导，与 `WB_OPS_HOME` 覆盖天然一致），`select id,title,custom_title from sessions` → `{sid8: 名字}`；try/catch 全包，坏库/缺表/旧 node → `{}` |
| `buildModel(rows, names)` | 第二参可选，命中给 `name`，未命中 `''`——渲染层据此走 sid 分支，老调用零改动 |
| 卡片头行 | 有名：`<b class="sname">名字</b><span class="sid dim">sid8</span>`；无名：原样纯 hash。名字同样走 `esc`（单测钉死：恶意会话名注不进脚本） |
| `test/dashboard.test.mjs` | +3 项（names 命中/未命中、渲染分支与转义、真 sqlite 临时库 + 坏路径退化）。总单测 94+9=**103** |

限制如实说：`node:sqlite` 在 Node 22 是 experimental，跑 CLI 时 stderr 会带一行 ExperimentalWarning（不影响输出）；GUI 里改过会话标题后，serve 模式刷新即见，快照模式要重跑生成。

## v0.15 变更（2026-11-05）—— Web 看板：每个会话省了多少，浏览器打开就看到

**一句话**：`node scripts/dashboard.mjs` 读同一份 `stats/` 账本，生成自包含 HTML（零新依赖、纯静态）；`--open` 直接弹浏览器，`--serve [端口]` 起本地服务、刷新即重读。

| 改动 | 说明 |
|---|---|
| `scripts/dashboard.mjs`（新） | `buildModel`（聚合+排序：省量降序，token 优先、老账本回落字节）与 `renderHtml`（卡片式看板）都是纯函数、可单测；CLI 入口 `import.meta.url` 守卫，被 import 不起服务 |
| 口径同源 | 聚合走 `lib/report-core.mjs` 的 `collectRows/summarize`，与 `mcp__wb_ops__report`、`hooks/report.mjs` 三方同一数字；页脚写明 token 是估算、只计 Mod 改写的输出 |
| 转义 | sid / tool / kind 全部 HTML 转义（有单测钉死：恶意记账文件名不会注入脚本） |
| `test/dashboard.test.mjs`（新） | 6 项：排序/回落/kinds 序/空账本/头行数字/转义。总单测 94+6=**100**（v0.15.1 后为 94+9=103） |

## v0.14 变更（2026-11-05）—— 报表工具改走 MCP：把「换时机」换成「换通道」

**一句话**：v0.13.1 说「GUI 会话拿不到能注册工具的 core，所以多试几个时机」——**这个结论不完整，修法因此无效**。真相是 GUI 会话里**每个钩子拿到的都是同一个不能注册的 core**，换时机永远换不到能用的那一套。改用插件清单声明 MCP 服务器后，工具由宿主 MCP 管理器注册，与 mod core 无关。

### 根因（宿主 bundle 逐段读出来的，不是猜的）

| core | 构造点 | `registerTool` |
|---|---|---|
| 应用级 | `bootstrapFunctionHookMods` → `hostBindings` → `createModsCommandToolBindings` | 真实现：`toolManager.register(ModProxyTool)`，探针实测返回 `{tool:"mcp__wbopsprobe__probereport"}` |
| 会话级 | `createFunctionalHooks` → `makeCore` → `createCoreHandler({...createFunctionalHookBindings(...), registerTool: () => { throw ... }})` | **硬绑 throw**：`Error("Session tool registration is not bound")` |

`createFunctionalHooks` 里那个 `ModsRuntime` 的 core 对 `session.start` / `prompt.submit` / `tool.call` **一视同仁**——所以 v0.13.1 的「双入口重试」在 GUI 下两次都落在同一个 throw 上，`catch {}` 一吞，报表工具整个会话都不存在。CLI 探针当时「两次都成功」是因为 CLI 走的是应用级 core，**验证的路径和出问题的路径不是同一条**。

### 修法

| 文件 | 改动 |
|---|---|
| `.codebuddy-plugin/plugin.json` | 新增 `mcpServers.wb_ops = {command:"node", args:["${CODEBUDDY_PLUGIN_ROOT}/mcp/server.mjs"]}`；工具名由 server key 决定 → `mcp__wb_ops__report` |
| `mcp/server.mjs`（新） | 零依赖 MCP stdio 服务器：`initialize` / `tools/list` / `tools/call` / `ping` / `resources,list` / `prompts,list`；stdout 只走 JSON-RPC，日志一律 stderr |
| `lib/report-core.mjs`（新） | 聚合 + 渲染的**唯一**实现，MCP 工具与 `hooks/report.mjs` CLI 共用，口径不可能漂 |
| `hooks/register.ts` | 删掉 `tryRegisterReportTool`、`session.start` 钩子、报表 `tool.call` 处理器、`readStatRows` / `summarizeStats` / `renderSummary`；只留压缩 / 水位 / 压缩保留指示 |
| `scripts/install-gui.mjs` | payload 目录从 `['.codebuddy-plugin','hooks']` 扩到 `+['lib','mcp']`——漏拷任何一个，工具在宿主侧都起不来 |

### 验收（本机，2026-11-05）

- `plugin validate .` → ✔ Validation passed（含 `mcpServers`）
- 安装树 `cache/wb-ops-local/wb-ops/0.14.0/{.codebuddy-plugin,hooks,lib,mcp}` 齐备，旧 `0.13.1` 已清
- `node test/probe-installed-mcp.mjs` → `serverInfo {name:"wb-ops-report", version:"0.14.0"}` / `tools/list: report` / `tools/call isError=false` 返回真实报表（`压缩 28 次 · 省 ≈65.5k tok / 258.1KB (72.9%)`）/ stdout 脏行 0
- 单测 94 项全绿，其中 MCP 全链路用例是**真子进程**握手（不是 mock）
- CLI 启动日志确认 mod 钩子已收敛为 `tool.call prompt.submit session.compact`

### 你要做的最后一步

**新开一个对话**（新运行时才会重新装配插件；`/reload-plugins` 对 mod 的 `bootstrapFunctionHookMods` 无效，MCP 是否随之重载未验）。新会话里 `mcp__wb_ops__report` 应出现在工具清单；问我「调一下 wb-ops 报表」即可验证。

## v0.12 变更（2026-11-05）

**目标**：让水位守卫在宿主 `$.session.usage().context.tokens` 恒 0 时仍能拿到真实上下文占用。

| 改动 | 说明 |
|---|---|
| `pickWatermark` 嵌套候选 | 认 `context.tokens` / `context.window`（宿主真实形状）；`used<=0` 视为无数据，绝不拿 0 假报水位 |
| `pickWindow` | 即使 tokens 缺失也能取真算的 `context.window` 作分母 |
| `probeTranscript` | 读 `<HOME>/.workbuddy/projects/<cwd-slug>/<sid>.jsonl`，只逆扫最后 ≤40 行取最后一条 `providerData.usage.inputTokens`（已含 cache_read，不重复叠加）；**v0.12.1：>8MB 不再整体拒绝**——整读后只解析尾部 ≤4M 字符（`fs.stat` 预判体积，debug 标 `truncated`）；命中路径缓存、slug 猜不中列目录兜底、连续 3 次失败即放弃 |
| 沙箱读权限探测 | 结论写 `debug/fsprobe-<sid8>.json`（只记 ok/err/path/bytes/truncated，**无正文**）；签名不变不重复落盘 |
| 数据源标注 | `watermark/<sid8>.num` 第二行标 `来源 transcript`；宿主修好 binding 后自动回到 `usage` 直出 |
| 新开关 | `WB_OPS_GUARD_FS=0` 关闭 fallback；`WB_OPS_PROJECTS=<dir>` 覆盖 transcript 目录 |

**性能边界**：只在 `prompt.submit`（每轮用户提交一次）触发，不在 `tool.call` 热路径；零子进程；任何异常 fail-open 静默。与 sana 事故（每回合起 Bash + 扫 16MB）不在一个量级。

**待真机验证**：mod 沙箱 `$.fs` 对 `projects/` 目录的读权限（看 `fsprobe` 的 `err`）、≥阈值时的 `[wb-ops 水位]` 行、以及 `session.compact` 的 instructions 合并。

---

## v0.12.1 变更（2026-11-05）—— 大文件降级 + compact 诊断

**目标**：修掉长会话里水位守卫「双源同失」的窗口，并让压缩保留指示可验证。

| 改动 | 说明 |
|---|---|
| **超大 transcript 不再整体拒绝** | 宿主 transcript 只增不减（实测真实会话 21.5MB）。旧实现对 >8MB 判 `transcript too big` → fallback 永久失守。现改为整读后**只解析尾部 ≤4M 字符**，`fs.stat` 预判体积并在 debug 标 `truncated` |
| `lastInputTokens(txt, from)` | 支持分段起点：只解析尾部窗口，尾部首行可能是半行（丢弃不影响结论） |
| `session.compact` 诊断 | 每次 compact 事件写 `debug/compact-<sid8>.json`：`trigger/hadBase/baseLen/mergedLen/hasRetention`（**不记正文**） |

**为什么必须修（真机证据）**：`usage` 归零的精确时刻 = **pre-message-auto compact 之后**（实测 compact 摘要落盘 → 8.2 秒后 usage 才恢复）。而 transcript 涨到 8MB 需要长时间积累——两个条件在长会话里会同时撞上，此时旧实现会出现「usage 归零 + transcript 超限」→ **水位提醒彻底静默**。

**实测代价可接受**：22MB 全量 `readFile` + `toString` + `split` 共 **115ms**、常驻内存 134MB，且只在 `prompt.submit` 每轮一次。

**真机验收**：用真实 21.5MB 会话文件跑 mod → `fsprobe` 得 `{"used":410003,"bytes":22666447,"truncated":true}`、`watermark` 标「来源 transcript」，与全文解析结果**完全一致**；旧错误 `transcript too big` 归零。

---

## v0.13.1 变更（2026-11-05）—— 修报表工具在 GUI 会话注册不上

**根因（宿主 bundle 反查 + 探针实测，非推断）**：宿主有**两条能力不同的 core**，只有一条允许 mod 注册工具。

| core | 来源 | `$.tool.register` 行为 | 走这条的运行时 |
|---|---|---|---|
| 应用级 | `hostBindings` → `createModsCommandToolBindings` | **有真实现** → `toolManager.register(ModProxyTool)`，真注册 | CLI / `--plugin-dir` |
| 会话级 | `createFunctionalHookBindings` | 被显式绑成 `throw Error("Session tool registration is not bound")` → **必抛错** | GUI 会话 |

旧实现只在 `session.start` 注册一次，而 GUI 会话拿到的正是**会话级 core** → 注册必抛 → 被 mod 自己的 `catch {}` 吞掉 → **`mcp__wb_ops__report` 整个会话都不存在**（fail-open 的典型表现：主链路无损，但功能静默缺失）。

探针实测（`--plugin-dir` 加载临时 mod，`session.start` 里调 `$.tool.register`）：

```jsonc
// 落盘 ~/.workbuddy/wb-ops/probe2-session-start.json（CLI 路径 = 应用级 core）
{ "hasToolNs": true, "toolKeys": ["list","register","unregister","call","check","describe"],
  "registerResult": { "tool": "mcp__wbopsprobe__probereport" } }   // 返回值形状 = {tool:string}，与代码解析一致
```

**修复**：

| 改动 | 说明 |
|---|---|
| 双入口幂等重试 | 注册改挂在 `session.start` **与** `prompt.submit` 两个入口；任一拿到可用 core 即注册成功，已注册则 O(1) 跳过 |
| 状态收敛到闭包 | `reportToolName` 从**模块级**移进 `register()` 闭包——模块级会让「上一个会话已注册」短路掉新会话的注册（宿主每会话重新引导 mod，工具名要每会话重取） |
| 不影响主链路 | 注册失败仍 fail-open（吞异常，主链路压缩/落盘/水位完全不依赖报表工具） |

单测 **97/97 全绿**（新增 3 条：注册失败不炸主链路 + prompt.submit 重试、注册幂等、stats 关闭时零注册调用）。

---

## v0.13 变更（2026-11-05）—— token 指标：省了多少，一眼可见

**目标**：把"省了多少"从字节换算成人人认得的 token，并让它出现在 wb 对话里，而不是要求用户先配环境变量再翻文件。

| 改动 | 说明 |
|---|---|
| `estTokens` | 与宿主 `TokenUtils.estimateTokensRough` 逐字同公式：`ceil(中文/1.8)+ceil(其余/4)`；只用于展示，压缩决策仍按字节 |
| 标记行内联省量 | `[wb-ops] 已省略 N 行 · 原文 12.4KB≈4.1k tok → ≈1.2k tok（省 71%） · 落盘 …`，shell / Read / 列表 / 兜底四条路径统一走 `markerNote` |
| 记账带 token | `stats/<sid8>.json` 增 `tokBefore/tokAfter`（`kinds` 每类也有）；老账本缺字段时报表自动回落字节口径 |
| 报表两处同源 | `renderSummary`（`mcp__wb_ops__report`）与 `hooks/report.mjs` 首行都给"省 ≈X tok / YKB (P%)"，分类行同口径 |
| 默认开 | `WB_OPS_STATS` 默认开，`0/off/false/no` 关；关掉后标记行 token 照旧，只少累计报表 |

**未做**：WorkBuddy GUI 没有插件可用的 statusline（`statusLine` 只在 CLI TUI 的 settings.json 生效），故不做常驻栏——标记行 + 报表工具已覆盖"看得到"。

**v0.13.1 补**：v0.13 发布时报表工具在 GUI 会话其实注册不上（根因见下节），v0.13.1 已修。
