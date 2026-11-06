# wb-ops 设计文档

> 本文回答"为什么这样设计"。安装与使用见 [README](../README.md)，真机验证证据见 [VERIFICATION.md](VERIFICATION.md)，版本历史见 [CHANGELOG.md](../CHANGELOG.md)。

## 1. 为什么载体是 Mod，不是 MCP / Skill / shell hook

工具输出的"压缩"必须在结果进入模型上下文**之前**确定性发生。逐载体评估：

| 载体 | 判定 |
|---|---|
| shell hook (PostToolUse) | `tool_response` = `rawResponse`，Bash 只有 exitCode/截断标志，没有正文——**做不到** |
| PreToolUse `updatedInput` | 只在 `permissionDecision === "allow"` 时生效，等于自动放行命令——**不可接受** |
| MCP 工具 | 需要模型主动调用才压缩；自带 schema token；看不见内建工具输出——**不确定** |
| Skill | 提示词级约定，模型可忽略——**不确定** |
| **Mod `tool.call`** | 宿主强制执行、进程内、零 spawn、可改写任意工具结果——**确定性拦截** |

载体按职责选，不按主义选：压缩必须是 Mod；"报表"这类**只读查询**工具需要的是"被注册成一个工具"，所以走插件清单声明的 MCP 服务器（见 §7）。

## 2. 热路径性能：风险模式与规避

同类"输出治理"工具常见的实现路线是 shell hook + 每回合起子进程扫 transcript。这条路线有四个叠加的风险点，任何一层失守都会拖慢用户的每一次回车：

1. **同步子进程冷启动**——hook 每个回合同步起一个 shell 进程（冷启动以秒计），击穿宿主给 hook 的超时预算后整条交互被阻塞；
2. **全量 transcript 扫描**——会话文件只增不减，长会话可达 20MB+，每回合全量读扫的成本线性上涨；
3. **无界 IO**——诊断/记账无封顶追写，热路径 IO 随会话进行变贵；
4. **fail-closed 倾向**——出错时阻塞或重试，把工具故障放大成交互故障。

wb-ops 的对应规避：

| 风险点 | 本插件的设计 |
|---|---|
| 子进程 | **零子进程**：只注册 Mod，`hooks.json` 无任何 `command` hook；报表 CLI 是用户主动跑的旁路，不在热路径 |
| 全量扫描 | 水位守卫只在 `prompt.submit`（每轮一次，不在 tool.call 热路径）读 `$.session.usage()`（O(1)）；宿主 binding 归零时才追加一次**有界尾部采样**：只逆扫最后 ≤40 行 JSONL、命中路径缓存、连续 3 次读失败即放弃、可一键关；>8MB 的 transcript 整读后只解析尾部 ≤4M 字符（22MB 实测 ≈115ms） |
| 无界 IO | 记账整读整写但封顶（events ≤300 条，文件恒 ~30KB）；spill 原文 >4MB 不落盘；诊断通道只记结构不记正文、限频 |
| 故障放大 | **fail-open**：未知形状、任何异常、`isError`、非零退出码一律原样返回；压缩自带 100ms 软超时自弃；引擎侧还有每钩 10s 预算兜底——最坏结局只是"这一条不压" |

**热路径延迟实测**（本机，逐行 KEY 匹配 + 全量字节计量的压缩机）：

| 输入 | 冷启动+5 连跑最差 | 说明 |
|---|---|---|
| 150KB（3k 行） | 11.3ms | 典型大输出 |
| 1MB（20k 行） | 37.3ms | |
| 5MB（100k 行） | 52.7ms | |
| 10MB（200k 行） | 100.7ms | 100ms 软超时自弃生效 |

**后续拓展所有事件时的纪律**：任何新 handler 必须保持——零子进程、只读 O(1) 宿主状态、扫描必须带 deadline、写必须带 size cap、保持 fail-open。

## 3. 压缩形态（shell 类输出为例）

超过预算（默认 4500 字节，可调）且退出码为 0 的输出被压成：

- **自适应头部**：按平均行长定行数（8–400 行，预算利用率不足自动放大；含 `Command:` 行——模型得知道当时跑了什么）
- **中部关键行**：error/fatal/traceback/错误/失败/警告/异常/… 中英并集，至多 40 条，超出均匀撒点
- **自适应尾部**：保底含 `Exit Code:` 行
- **少行巨字节特例**：整串行数 ≤20（minified、单行 JSON dump）走字节级首 60%+尾 28% 截断
- **一行标记**：

  ```text
  [wb-ops] 已省略 N 行 · 原文 12.4KB≈4.1k tok → ≈1.2k tok（省 71%） · 落盘 ~/.workbuddy/wb-ops/spill/<sid8>/<seq>-<callId>.txt
  ```

模型需要细节时用 Read/Grep 读 spill 路径（Read 档还给 offset/limit 指路）。已带 `[wb-ops]` 标记的文本不再二次压缩。

### 各出口策略

| 工具 | 策略 |
|---|---|
| Bash / PowerShell / TaskOutput | `Exit Code` 非零**完整透传**并附一行 `[wb-ops 提示]`（9 类可识别错误→可执行下一步，模式只扫头尾 4KB；提示门在预算门之前，小失败也管）；超预算压成 头+关键行+尾 |
| Grep / Glob | 两种输入形态都接：宿主原生 `content: string[]`（裁条目+追加单行说明，**保持数组形态**与宿主序列化同构）；JSON 数组文本（前 K 条 + 计数）。整串原文落盘 `.json` |
| Read | 按扩展名分档门槛：数据类（.log/.csv/.jsonl/…）>200 行才裁；.json/.md >800 行；**源码 <1500 行一律不裁**（读完多半要接着改，中段不能丢）。空洞 ≥20 行给 `回看: Read offset=N limit=M` 指路。宿主自己落的 `<persisted-output>` 不碰 |
| WebFetch / WebSearch | 标题/链接/加粗行当骨架捞回，正文段省略 |
| 其余全部工具（兜底） | 谓词 matcher 接住策略表之外的任何工具名（MCP、宿主新增）：通用压缩，失败同样整场透传；`WB_OPS_FALLBACK=0` 单独关 |

所有档位共用：**预算按 UTF-8 字节计**（按字符会放过中文越线输出，单测钉死）；原文 >8MB 或异常形状 → 透传。

## 4. 记账设计：为什么是 (session, model, timestamp) 三元组

省量报表要回答的问题从「总共省了多少」变成「**谁**在**什么时候**省的、按**哪个模型**值多少」。三元组是这三个追问各自的最小锚点：

| 维度 | 为什么必须是它 | 设计取舍 |
|---|---|---|
| **session** | 账本天然以会话为文件（`stats/<sid8>.json`）：会话是责任边界（一次任务压得值不值），也是 spill/ 目录、会话名（workbuddy.db）唯一能对齐的键。跨会话合并只在展示层做，存储层不混 | 文件粒度=会话粒度，读一个文件得一个会话全账，看板零 join |
| **model** | token 省钱最终按模型单价折算，省量不归到模型就没有财务意义；且**模型可以在会话中途切换**，所以模型必须是**每次压缩的属性**，不能是会话的属性——记在会话上会记错账 | 每次压缩取一次 `$.session.model()`（进程内调用）；拿不到/deny 记 `unknown` 而不是跳过——宁可归因不明，不可漏记总量 |
| **timestamp** | 累计值只能回答「多少」，时间戳才能回答「走势」：时间轴的 x 轴唯一候选，也用来把异常（比如某次 90% 省量）钉回具体操作时刻 | `Date.now()` 每条 13 字节，成本可忽略 |

**双层记账法**（核心决定）：同一文件里并存两种粒度——`models`/`kinds`/总量是**全史累计**（对账用，永远完整，不受封顶影响），`events` 是**窗口明细**（看趋势用，只留最近 300 条）。两层各司其职，封顶永远只裁"明细"，不裁"账"。

**为什么 events 封顶 300**：宿主 mod 的 `$.fs` 没有 append，记账是整读整写——无界事件流会让热路径 IO 与 JSON 解析随会话线性变贵。封顶后文件恒 ~30KB、成本 O(1)；300 同时约等于时间轴 760px 图的视觉上限。升级路径（append-only JSONL + 尾读）写在 `hooks/register.ts` 注释里，当前 ROI 不值。

**为什么 events 塞进同一个 stats 文件**：不为看板新增任何存储面——账本仍是每会话一个小 JSON，看板仍是只读、零缓存。代价（整读整写变大）已由封顶钉死为常数。

## 5. 会话名称的来源（看板）

卡片头行以**会话名为主、sid8 弱化保留**。名字从宿主 `~/.workbuddy/workbuddy.db` 的 `sessions` 表只读解析（`custom_title` 优先于 `title`），stats 文件名只存前 8 位、按前缀匹配。用 node 内置 `node:sqlite`，零新依赖；db 缺失、表结构变更、node 版本不够——任何一环不对就**静默退化为纯 hash 展示**，看板不报错。serve 模式每次刷新重查，改名刷新即见。

## 6. 诊断通道

宿主工具结果的形状**逐工具不同**，还会随宿主升级变化。为避免每次都去宿主 bundle 里捞，落了**只记结构、不记正文**的诊断通道：

| 文件 | 记什么 | 什么时候写 |
|---|---|---|
| `~/.workbuddy/wb-ops/debug/shape-<sid8>.json` | 工具名 + result 的键名/类型/长度（**无正文**） | 判不出文本形状**且**内容超预算时，每会话最多 20 条 |
| `~/.workbuddy/wb-ops/debug/usage-<sid8>.json` | `$.session.usage()` 的返回形状（键名/类型/数值）+ deny 文案 | 形状**变化**时（形状不变不重复写） |
| `~/.workbuddy/wb-ops/debug/fsprobe-<sid8>.json` | transcript 沙箱读权限探测：`ok/err/path/bytes/truncated`（无正文） | 结论**变化**时（首次 fallback、读权限变化、体积跨过 8MB 门槛） |
| `~/.workbuddy/wb-ops/debug/compact-<sid8>.json` | `session.compact` 事件：`trigger/hadBase/baseLen/mergedLen/hasRetention`（不记正文） | 每次 compact 事件 |

隐私纪律：字符串一律只记长度，正文永不落盘。宿主升级后若某通道突然不生效，先看这几个文件。

## 7. 报表工具为什么走 MCP 而不是 mod 注册

宿主有两条能力不同的 mod core：CLI 路径的应用级 core 允许 mod 注册工具；**GUI 会话的会话级 core 把 `registerTool` 硬绑成 throw**。且同一 `ModsRuntime` 的所有钩子（`session.start` / `prompt.submit` / `tool.call`）共用同一个会话级 core——换钩子时机不可能换到可用的绑定。

结论：**能力问题换通道，不换时机**。报表工具由插件清单声明 MCP 服务器（`mcpServers.wb_ops`），由宿主 MCP 管理器起进程注册，与 mod core 完全解耦。这条路径的宿主支持有三处证据：内置插件同法（`workbuddy-sheetagent` 等）、`McpConfigManager.readMcpServersFromPlugins()` 会合并插件 `mcpServers`、`enrichWithPluginEnvironment()` 会替换 `${CODEBUDDY_PLUGIN_ROOT}`。

## 8. 宿主工具结果形状实测

从真实会话 transcript（`~/.workbuddy/projects/<cwd>/<sid>.jsonl`，顶层 `function_call_result` 记录）反查 `providerData.toolResult`：

| 工具 | `toolResult.content` 类型 | extractText 命中 | 实测 |
|---|---|---|---|
| Bash / PowerShell | string | ✅ | 压缩生效 |
| Read / TaskOutput | string（宿主落盘后为 `<persisted-output>` 摘要） | ✅ | 压缩生效 |
| WebFetch / Edit / TaskCreate / ToolSearch | string | ✅ | 多在预算内透传 |
| **Grep** | **string[]**（原生数组，非 JSON 文本） | ✅ | 原生数组分支：裁条目+单行说明，保持数组形态 |
| Glob | string[] / string | 部分 | 大结果已被宿主先落盘 |
| MCP | string | ✅ | 走兜底，压缩生效 |

**宿主 `persisted-output` 落盘阈值 ≈8KB**——超过它宿主先落盘，mod 看不到原文。默认预算 4500 字节正是为了把 (预算, 8KB) 这段"宿主不管"的区间吃满。

`$.session.usage()` 宿主契约：返回 `{context:{tokens,window,percent},rateLimits:[]}`；`window` 真算可信，`tokens` 在 GUI 会话的 mods 绑定层恒 0（数据本身健康，transcript 里 `providerData.usage.inputTokens` 单调递增）——断点在宿主绑定层，wb-ops 对 `tokens=0` 静默并走 transcript 尾部采样兜底，宿主修复后自动点亮。
