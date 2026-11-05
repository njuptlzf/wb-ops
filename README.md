# wb-ops

WorkBuddy 的**上下文治理 Mod**（Mod-first）：进程内 `tool.call` 中间件，在工具结果进入模型上下文之前做确定性压缩，原文落盘可回查。错误输出**永不压缩**。目标只有一个：**降本增效——让进入上下文的每一份 token 都携带高价值信息**。

当前版本 v0.8 覆盖 **8 个高频出口 + 通配兜底**：Bash / PowerShell / TaskOutput（shell 类）、Grep / Glob（JSON 数组识别）、Read（按文件类型分档）、WebFetch / WebSearch（文档骨架）；shell 失败现场附一行 nextAction 提示（dsh-ops「遏制报错重试循环」原则的落点）；开启记账后提供省量报表（会话内 `mcp__wb_ops__report` 工具 + 沙箱外 `node hooks/report.mjs`）；上下文水位守卫（prompt.submit ≥85% 一行提醒）与压缩保留指示（session.compact instructions，Mod 版 PreCompact）；POLICY 之外的所有工具名（MCP、宿主新增）由谓词 matcher 兜底走通用压缩。压缩核心与事件无关，后续按事件逐个拓展到全生命周期出口。命名不叫 `wb-bash-ops` 正是因为这个路线图。

| 工具 | 策略 |
|---|---|
| Bash / PowerShell / TaskOutput | `Exit Code` 非零**完整透传**并附一行 `[wb-ops 提示]`（9 类可识别错误→可执行下一步，模式只扫头尾 4KB；提示门在预算门之前，小失败也管）；超预算压成 头+关键行+尾，尾段保底含退出码行 |
| Grep / Glob | 识别 WorkBuddy 的 JSON 字符串数组输出（实测 72 次调用全是这形状）：前 K 条 + 计数，整串原文落盘 `.json` |
| Read | 按扩展名分档门槛：数据类（.log/.csv/.jsonl/…）>200 行才裁；.json/.md >800 行（≥40KB 的少行 dump 走硬阀）；**源码 <1500 行一律不裁**（读完多半要接着改，中段不能丢）。空洞 ≥20 行给 `回看: Read offset=N limit=M` 指路。宿主自己落的 `<persisted-output>` 不碰 |
| WebFetch / WebSearch | 标题/链接/加粗行当骨架捞回，正文段省略 |
| 其余全部工具（③ 兜底） | 谓词 matcher 接住 POLICY 之外的任何工具名（MCP `mcp__*`、宿主新增）：通用压缩，`Exit Code` 非零同样整场透传；预算内零影响，自家报表工具显式排除；`WB_OPS_FALLBACK=0` 单独关 |

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

## 它如何规避 sana35421/wb-ops 的 5 秒超时事故

实测根因：其 UserPromptSubmit 每个回合同步起 Git Bash（本机实测 2.1–2.6s）+ node 冷启动 + 扫最大 16MB transcript，并发时必击穿 5s 预算。本项目对策：

1. **零子进程**——只注册 Mod，`hooks.json` 里没有任何 `command` hook（只有一个 `modules` 数组）。
2. **零 transcript 扫描**——v1 不做上下文水位守卫；将来要做也只走 `prompt.submit` + `$.session.usage()`（O(1)）。
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
- 一行标记：`[wb-ops] 已省略 N 行 · 原文 Xb → 落盘 ~/.workbuddy/wb-ops/spill/<sid8>/<seq>-<callId>.txt`

模型需要细节时用 Read/Grep 读 spill 路径（Read 档还给 offset/limit 指路）。已带 `[wb-ops]` 或 sana 标记前缀的文本不再二次压缩。

## 安装

**CLI**（已验证加载）：

```bash
node "<WorkBuddy>/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs" --plugin-dir C:/Users/dev/work/wb-ops
```

加载成功时输出 `mods: loaded mod "wb-ops" from .codebuddy-plugin (tier user, hooks: tool.call)`。

**GUI**：登记为本地 marketplace（`~/.workbuddy/plugins/known_marketplaces.json` 加 `{ "type": "directory", "path": ... }`）后安装——按 CodeBuddy 插件规范写的，GUI 装载**尚未在本机验证**。注意：与 sana 的 `wb-ops` 插件名相同，若两者都要装，用不同 marketplace 名或只走 `--plugin-dir`，避免插件缓存键冲突。

## 配置（环境变量，经 `$.env.get` 读取）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WB_OPS` | 开 | `0/off/false/no` 全局关闭 |
| `WB_OPS_BUDGET` | 8000 | 压缩后文本字节上限（>512 才生效）；与 sana 同名同义，共存时一个值管两边 |
| `WB_OPS_DEADLINE_MS` | 100 | 压缩自设软超时；`0` 等效禁用压缩 |
| `WB_OPS_STATS` | 关 | `1/on/true` 开启省量记账：每次成功压缩更新 `~/.workbuddy/wb-ops/stats/<sid8>.json`（整读整写小计数器，非无界追写；挂了不影响压缩，有单测钉死）。开启后会话启动时注册 `mcp__wb_ops__report` 报表工具（不开不注册，不占 schema token）；沙箱外可跑 `node hooks/report.mjs` |
| `WB_OPS_HINTS` | 开 | `0/off/false/no` 关闭 shell 失败现场的 nextAction 提示（提示只加一行，不占压缩预算） |
| `WB_OPS_GUARD` | 开 | `0/off/false/no` 同时关闭 #4 水位守卫（prompt.submit 提醒）与 #5 压缩保留指示（session.compact instructions）。守卫每轮仅一次 `$.session.usage()` 进程内读取，**无子进程、无 transcript 扫描**——sana 5s 事故的三个根因全不沾 |
| `WB_OPS_FALLBACK` | 开 | `0/off/false/no` 关闭 ③ 通配兜底（只保留 8 个白名单出口） |
| `WB_OPS_GUARD_PCT` | 85 | 水位提醒阈值（上下文占用百分比）；usage 形状判不出则静默，绝不误报。guard 开启时每轮把余量写入 `~/.workbuddy/wb-ops/watermark/<sid8>.num`（首行=剩余 tok，模型可 Read 主动查；写失败静默） |

## 开发 / 测试

```bash
node --test test/register.test.ts   # 61 项，全绿（需 Node ≥22.6 的 --experimental-strip-types，或 Node 23+ 直接跑）
```

沙箱纪律：mods 内禁止 `node:require/process/global`（引擎会当场拒绝整个 mod），`register.ts` 唯一的 import 是 `codebuddy-code` 的**纯类型**导入，运行时被擦除。所有宿主能力走 `$`：`$.env` / `$.fs.write` / `$.session.id()`。

## 已验证 / 未验证

- ⚠️ **③ 通配兜底的谓词 matcher**：文档「深匹配」节声明支持函数谓词、每次事件重评；离线单测钉死互斥逻辑，宿主实际路由需 /login 后用一个 MCP 工具大输出看是否带标记。
- ✅ mods 加载（CLI 启动日志 `hooks: tool.call session.start prompt.submit session.compact` 四通道全注册）、沙箱合规、压缩策略、透传条件、spill、并发去重、字节预算、分工具策略、错误 nextAction 提示（模式表命中/扫描窗封顶/可关/防重复）、报表聚合与渲染（谓词 matcher、坏文件跳过、list 抛错兜底、CLI 真目录聚合）、水位守卫与压缩保留指示（形状候选/阈值边界/关闭零触碰/fail-open）、③ 通配兜底（预算内零影响/非零透传/可关/谓词互斥）、② 水位数值文件（每轮小写/越线附带 Read 路径/写失败静默；离线 mock API 单测 61 项）
- ✅ Grep/Glob 输出形状：从 86 条真实 transcript 确认 = JSON 字符串数组
- ⚠️ **报表工具注册两处宿主未文档化点**：`$.tool.register` 返回值取 `.tool` 全名（bundle 源码如此，若返形状不符则报表工具不出现，主链路无损）；`$.fs.list` 条目形状未文档化（string/{name} 双兼容 + 抛错即空账本）。`/login` 后开 `WB_OPS_STATS=1` 看工具列表里有无 `mcp__wb_ops__report`。
- ⚠️ **`$.session.usage()` 真实返回形状**（bundle 中存在 `{used,size}` 与 `{inputTokens,contextWindow}` 两种构造，代码收 4+3 字段候选，判不出静默）与 `prompt.submit` 返回 `{text,context}` 的宿主合并行为——`/login` 后把上下文灌到 >85% 看是否出现 `[wb-ops 水位]` 行；`session.compact` instructions 合并同理需一次真实 auto-compact 验证。
- ⚠️ **`tool.call` 事件里 `e.input` 的确切字段名**（代码候选 `input/tool_input/arguments` + `file_path/path/filePath`，判不出即透传，不会误伤）与 **`result` 的确切运行时形状**（四种已知形状自适配，未知即透传）——`/login` 后跑一次大输出闭环：
  ```bash
  # Bash 用例
  node -e "for(let i=0;i<5000;i++)console.log('line '+i+' WARN sometimes')"
  # Grep 用例：搜出 >8KB 的 files_with_matches 结果
  # Read 用例：读一个 >200 行的 .log（应见指路 offset=）和一个 800 行内的 .ts（应原样）
  ```
  结果里出现 `[wb-ops]` 标记即闭环；Read/源码用例输出**必须**无标记。
- ⚠️ GUI marketplace 目录格式装载。
