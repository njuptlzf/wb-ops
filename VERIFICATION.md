# wb-ops 验证报告

本文档落盘 wb-ops 全部真机验证的**流程、原始数据与结论**，可复现。验证环境：Windows 11 + WorkBuddy-cn（CLI 运行时 `codebuddy-lite-wb.mjs`）+ Node v22.22.2。

| 版本 | 日期 | 结论 | 提交 |
|---|---|---|---|
| v0.12.0 | 2026-11-05 | ✅ 三项全过（沙箱读权限 / 水位提醒 / auto-compact 合并） | `cce1dd1` |
| v0.12.1 | 2026-11-05 | ✅ 大文件降级（22MB transcript 不再失守） | `802458a` |
| v0.13 | 2026-11-05 | ✅ token 指标真机生效（标记行内联省量 + 记账 tok 字段 + 报表同口径） | `9554320` |
| v0.13.1 | 2026-11-05 | ❌ **修法无效**（GUI 换入口换不到可用 core；新会话复核未通过，见 3.6 警告与 3.7） | `429e616` |
| v0.14 | 2026-11-05 | ✅ 报表工具改走插件声明的 MCP 服务器（安装态握手通过；GUI 新会话待最终确认） | `9b360cf` |
| v0.15 | 2026-11-05 | ✅ Web 看板 `scripts/dashboard.mjs`（离线单测 6 项 + 本机真实账本渲染通过；GUI 侧无新运行面） | `df8a267` |
| v0.15.1 | 2026-11-06 | ✅ 看板显示会话名称（真机 4 个 sid8 全部命中名称；坏库/缺表退化为纯 hash 有单测钉死；node:sqlite 只读） | `93f6c58` |
| v0.16 | 2026-11-06 | ✅ 记账模型维度+事件流、看板时间轴详情+按模型汇总（离线 97+12 全绿；真机旧账本走空态提示；GUI 新会话产生事件流待最终确认） | 待提交 |

离线单测：**109/109 全绿**（`node --test test/register.test.ts`（97）+ `node --test test/dashboard.test.mjs`（12））。宿主校验器：`plugin validate` ✔、`plugin list` → `enabled`。安装态探针：`node test/probe-installed-mcp.mjs` ✔。

---

## 1. 验证方法：两条宿主通道

真机验证的难点是**确定性**——不能靠"把会话聊到水位 85%"这种不可控方式。反查宿主 bundle（21MB `shared.cjs`）后找到两条可复用通道：

### 通道 A：settings.json 的 `env` 键 = 运行期环境变量注入（无需重启）

宿主 `EnvInterceptor`（AgentRun 拦截器）每轮执行 `settings.json → env 键 → 写入 eg(69525).environment`，而**这正是 mods 沙箱 `$.env.get` 读的同一个 Proxy**（模块内 Map 优先于 process.env）。因此：

```jsonc
// ~/.workbuddy/settings.json 临时加一段（验证完必须还原）
{ "env": { "WB_OPS_GUARD_PCT": "10" } }
```

- 同一模块还提供全部 `CODEBUDDY_*` 常量 → `CODEBUDDY_PRE_MESSAGE_COMPACT_PCT` 等 auto-compact 开关同样可注入
- ⚠️ 时序：EnvInterceptor 在 AgentRun 阶段、mod 的 `prompt.submit` 更早 → 注入后**下一轮**才被守卫读到
- ⚠️ 验证完必须还原 settings.json（每次都做了备份→还原→核对 `env=undefined`）

### 通道 B：CLI「固定 sid + 预置 transcript」（绕过模型鉴权，完全确定性）

反查发现**鉴权门在 `AgentService.run()` 之前，而 mod 的 `prompt.submit` 已执行**。于是：

```bash
# 1. 预置一份带真实 usage 行的 transcript（sid 必须是合法 UUID，否则被静默忽略）
mkdir -p ~/.workbuddy/projects/c-Users-dev-work-wb-ops
node -e "
const fs=require('fs');
const sid='11111111-2222-4333-8444-555555555555';
const lines=[];
for(let i=0;i<6;i++) lines.push(JSON.stringify({id:'seed-'+i,type:'message',
  role:i%2?'assistant':'user',content:[{type:'input_text',text:'seed '+i}],
  providerData:{usage:{inputTokens:295000+i*1000}}}));   // 尾部=300000 → 水位 100%
fs.writeFileSync('C:/Users/dev/.workbuddy/projects/c-Users-dev-work-wb-ops/'+sid+'.jsonl', lines.join('\n')+'\n');
"
# 2. 跑 CLI（封装在 test/run-acceptance.sh）
bash test/run-acceptance.sh 11111111-2222-4333-8444-555555555555 "验收" WB_OPS_GUARD_PCT=10
```

CLI 跑不了模型回合（LLM 摘要到不了），但宿主会走**工程压缩**（`Engineering compact sufficient, skipping LLM summary`），压缩照样完成——足够验证全链路。

---

## 2. v0.12.0 三项验收（2026-11-05）

### ① 沙箱读权限（fsprobe）——✅ 通过

**问题**：mod 沙箱的 `$.fs` 能否读 `<HOME>/.workbuddy/projects/`（宿主 `absolutize` 只判绝对/相对路径，无白名单，但需真机证实）。

| 证据（`debug/fsprobe-<sid8>.json`） | source | 结果 | 说明 |
|---|---|---|---|
| `fsprobe-32360b9f.json` | transcript | **ok**：`used=186721, bytes=2371900` | 真实 GUI 会话（非构造），读通且提取成功 |
| `fsprobe-33de5a5b.json` | transcript | ok：`bytes=376` | 会话刚起时 transcript 极小，`used` 缺失符合预期 |
| `fsprobe-01a1aaf7.json`（CLI） | transcript | err：`ENOENT <sid>.jsonl` | **文件不存在 ≠ 权限拒绝** → 再次佐证无路径白名单 |
| `fsprobe-f87c445e.json` | transcript | err：`transcript too big`（9998223B） | 读成功了、被 8MB 上限拦下 → 引出 v0.12.1 |

### ② 水位提醒 + watermark「来源 transcript」——✅ 通过

构造会话（预置 transcript inputTokens=300000，window=300000 → 100%）+ `WB_OPS_GUARD_PCT=10`：

```
# debug/fsprobe-wbo0guar.json —— 4 条全部 ok
{"source":"transcript","used":300000,"bytes":2301,"path":"…/wbo0guard01-….jsonl"}

# watermark/wbo0guar.num —— 首行余量，次行标注数据源
0
已用 300000/300000 tok（100.0%）· 2026-11-05T09:27:16.367Z · 来源 transcript

# CLI 会话 transcript —— [wb-ops 水位] 真实注入（宿主包成 <system-reminder>），命中 5 次
[wb-ops 水位] 上下文约 100%（300000/300000 tok）。接近上限时宿主将有损压缩；建议本轮起：
大输出命令自带 head/过滤、探索合并成批、避免整读大文件。wb-ops 已把每次越线输出压回预算内。
 余量速查：Read C:/Users/dev/.workbuddy/wb-ops/watermark/wbo0guar.num
```

真实 GUI 会话同时验证了另一条数据源：`watermark/32360b9f.num` = `已用 127134/300000 tok（42.4%）`（无"来源"标注 = usage 直出）。**两条路径都通**。

### ③ 真 auto-compact 的 instructions 合并 ——✅ 通过

注入 `CODEBUDDY_PRE_MESSAGE_COMPACT_PCT=1`（阈值压到 1%）触发真实压缩：

```jsonc
// 会话 transcript 落盘的压缩标记（确凿的真 auto-compact，非手动 /compact）
{"id":"cmp_e0bd9676-…","providerData":{"compactType":"pre-message-auto",
 "compactionTrigger":"pre_message_threshold","compactionKind":"auto","isCompacted":true}}

// 宿主日志：压缩真实完成
[Compact:PreMessage] Engineering compact done: 6 items → 549 estimated tokens
[Compact:PreMessage] session.history trimmed in-place: 15 -> 1

// debug/compact-<sid8>.json（v0.12.0 新增诊断）—— mod 的保留指示确实合并进 instructions
{"trigger":"auto","hadBase":false,"baseLen":0,"mergedLen":73,"hasRetention":true}
```

注意：`instructions` 最终进 `hookContexts.preCompactInstructions`，只影响 **LLM 摘要 prompt**；宿主走工程压缩时 instructions 不出现在摘要正文（预期行为）。

---

## 3. v0.12.1：8MB 上限修复（2026-11-05）

### 问题定性（真机数据，非推断）

| 事实 | 数据 |
|---|---|
| 宿主 transcript **只增不减**（compact 压的是内存 history，不是文件） | 真实会话 21.5MB(d9c8345e) / 13.4MB(f87c445e) / 10.1MB(0383a8f1) |
| **usage 归零的精确时刻 = pre-message-auto compact 之后** | f87c445e：compact 摘要落盘 → **8.2 秒后** usage 才恢复；序列 `[0, 98564, 0, 0]` |
| 长会话里两个条件**必然同时撞上** | usage 归零窗口（compact 后 ~8s）× transcript 已 >8MB |

旧实现 >8MB 判 `transcript too big` → 该窗口内 fallback 永久失守 → **水位提醒彻底静默**（fail-open，表现为"没提醒"而非报错——最容易被漏掉的一类故障）。

**结论修正**：usage 路径才是**主力**（实测 tokens 涨到 306324/410003），transcript fallback 只在 compact 后那 8 秒窗口接力——而这正是旧上限失守的窗口。

### 修复方案

- `probeTranscript`：>8MB **不再整体拒绝** → 整读后只解析尾部 ≤4M 字符；`fs.stat` 预判体积；debug 标 `truncated`
- `lastInputTokens(txt, from)`：支持分段起点（尾部首行可能是半行，丢弃不影响结论）
- 代价实测：22MB 全量 `readFile+toString+split` = **115ms / 常驻内存 134MB**，只在 `prompt.submit` 每轮一次（不在 tool.call 热路径）——可接受
- 技术约束：沙箱 `fs.read` **无 offset**（底层 `node:fs/promises.readFile`），无法只读尾部，故采用"整读 + 只解析尾部"

### 真机验收（真实 21.5MB 会话文件）

```jsonc
// debug/fsprobe-d9c8345e.json —— 修复后（与全文解析结果完全一致）
{"source":"transcript","used":410003,"bytes":22666447,"truncated":true}

// watermark/d9c8345e.num
-110003
已用 410003/300000 tok（136.7%）· 2026-11-05T09:53:11.409Z · 来源 transcript
```

旧错误 `transcript too big` **归零**（grep 计数 0）。单元测试：9MB 噪音 + 尾部 usage 行的合成样本提取 410003 ✅、正常体积 `truncated=false` ✅、分段起点语义 ✅。

---

## 3.5 v0.13：token 指标真机验收（2026-11-05）

**结论：✅ 通过**。本会话（sid `fa2b121e`）即真机现场，证据来自真实工具输出与落盘文件。

### ① 标记行内联省量（`≈N tok → ≈M tok（省 P%）`）

真实 Bash 输出被压缩后，模型侧收到：

```
[wb-ops] 已省略 28 行 · 原文 8.0KB≈2.0k tok → ≈981 tok（省 52%） · 落盘 …/spill/fa2b121e/9-1793880100493.txt
```

与 v0.13 前对比（只有字节口径）：`已省略 28 行 · 原文 8.0KB → 落盘 …`。

### ② 记账含 token 字段

`~/.workbuddy/wb-ops/stats/fa2b121e.json`（真实会话）：

```jsonc
{ "calls": 3, "before": 23157, "after": 11573,
  "kinds": { "shell": { "calls": 3, "before": 23157, "after": 11573, "tokBefore": 5048, "tokAfter": 2581 } },
  "tokBefore": 5048, "tokAfter": 2581, "tool": "shell", "ts": "2026-11-05T11:42:09.500Z" }
```

`tokBefore/tokAfter` 存在 ✅（v0.13 新增字段），`kinds` 每类也带 ✅。

### ③ 报表同口径（沙箱外 `node hooks/report.mjs`）

```
[wb-ops 报表] 压缩 5 次 · 省 ≈5.7k tok / 23.7KB (60.7%) · 原文 39.1KB≈9.3k tok → 压缩后 15.3KB≈3.6k tok · 记账会话 2 个
  分类：shell 5次 ≈9.3k→3.6k tok
  fa2b121e  3 次  22.6KB→11.3KB  最后: shell 2026-11-05
  32360b9f  2 次  16.4KB→4.0KB  最后: shell 2026-11-05
  口径：token 为估算（与宿主同公式 ceil(中文/1.8)+ceil(其余/4)）；只计本 Mod 实际改写的输出，被裁原文在 ~/.workbuddy/wb-ops/spill/ 可回查。
```

首行同时给「省 ≈X tok」与「YKB (P%)」，分类行与明细行口径一致 ✅。

---

## 3.6 v0.13.1：报表工具在 GUI 会话注册不上（2026-11-05）

**现象**：v0.13 发布后，会话内 `mcp__wb_ops__report` 工具**始终不出现在工具清单**里（`ToolSearch` 查无此工具；transcript 里搜不到工具 schema）。而 `hooks/report.mjs` 一切正常 → 说明是**注册环节**失败，不是渲染或口径问题。

### 根因（宿主 bundle 反查 + 探针实测）

宿主有**两条能力不同的 core**，`$.tool.register` 最终落到 core 的 `case"tool.register"` 分支：

```js
// shared.cjs —— 宿主 bundle
case"tool.register": return core_handler_value(
  ea.registerTool ? await ea.registerTool(eS, eE.plugin)
                   : { tool: `mcp__${eE.plugin.replace(/[^a-zA-Z0-9]/g,"_")}__${eS.name}` });
```

| core | 来源 | `registerTool` 绑定 | 运行时 |
|---|---|---|---|
| 应用级 | `hostBindings` → `createModsCommandToolBindings` | **真实现** → `toolManager.register(ModProxyTool)` | CLI / `--plugin-dir` |
| 会话级 | `createFunctionalHookBindings` | `registerTool:()=>{throw Error("Session tool registration is not bound")}` | **GUI 会话** |

GUI 会话走会话级 core → 注册**必抛错** → 被 mod 自己的 `catch {}` 吞掉 → 工具整个会话都不存在。

### 探针实测（决定性证据）

写一个临时 mod，`session.start` 里调 `$.tool.register` 并把结果落盘，用 `--plugin-dir` 加载（走应用级 core）：

```jsonc
// ~/.workbuddy/wb-ops/probe2-session-start.json
{ "stage": "session.start",
  "hasToolNs": true,
  "toolKeys": ["list","register","unregister","call","check","describe"],
  "registerResult": { "tool": "mcp__wbopsprobe__probereport" } }   // 返回值形状 = {tool:string}
```

**这条同时排除了两个误判**：① 返回值形状不是问题（就是 `{tool:string}`，与代码解析一致）；② `$.tool` 命名空间存在且 `register` 是函数。唯一变量是**宿主给哪条 core**。

### 修复

| 改动 | 说明 |
|---|---|
| 双入口幂等重试 | 注册挂在 `session.start` **与** `prompt.submit`；任一拿到可用 core 即成功，已注册则 O(1) 跳过 |
| 状态收敛到闭包 | `reportToolName` 从模块级移进 `register()` 闭包——模块级会让「上个会话已注册」短路掉新会话（宿主每会话重新引导 mod） |
| fail-open 不变 | 注册失败仍吞异常；主链路（压缩 / 落盘 / 水位守卫）零依赖 |

### 验收

- 单测 **97/97 全绿**（新增 3 条：注册失败不炸主链路且 prompt.submit 重试、注册幂等、stats 关闭零注册）。
- 宿主校验器 `plugin validate` ✔。
- 探针复跑：`session.start` 与 `prompt.submit` **两个入口都注册成功**（CLI 路径）；GUI 路径待**新开会话**确认（mod 在运行时启动时引导，老会话仍是旧代码）。

> **⚠️ 本节修法已被证伪（2026-11-05 新开会话复核）**：`mcp__wb_ops__report` 仍未出现在工具清单。
> 原因见 3.7：GUI 会话里 `session.start` 与 `prompt.submit` 拿到的是**同一个**会话级 core，
> 换时机不可能换到可用绑定；而当时的探针走的是 CLI 应用级 core——**验证路径与故障路径不是同一条**。
> 保留本节是为了记住这个教训：拿到「证据」时要先问它来自哪条路径。

---

## 3.7 v0.14：报表工具改走 MCP（2026-11-05）

### 复核结果：v0.13.1 无效

新开会话（session `1e4ddce9`，mod 已加载——`debug/usage-1e4ddce9.json` 与 `stats/1e4ddce9.json` 都在写）后：

- `ToolSearch` 精确查 `mcp__wb_ops__report` → **No matching tools found**；
- 本会话可用工具清单里没有任何 `mcp__wb_ops__*`。

即：mod 的压缩/水位/记账全在跑，**只有工具注册没成**——与 v0.13.1 的诊断一致，但修法没生效。

### 根因（补完 v0.13.1 缺的那半句）

`createFunctionalHooks` 里 core 只造**一次**，然后交给整个 `ModsRuntime`：

```js
makeCore = (getSession, signal, roots) => Mods.createCoreHandler({
  bindings: {
    ...createFunctionalHookBindings({ getSession, cwd, report, pluginRoots }),
    sessionId,
    registerTool:   () => { throw Error("Session tool registration is not bound") },
    registerCommand:() => { throw Error("Session command registration is not bound") },
    registerAgent:  () => { throw Error("Session agent registration is not bound") },
  }, signal,
});
```

`session.start`、`prompt.submit`、`tool.call` 全部经由这一个 core 派发。所以**「多入口重试」在 GUI 下是自欺**：两次调用打在同一堵墙上。v0.13.1 表格里「运行时/GUI 会话走这条」的结论本身没错，错在**以为换入口等于换 core**。

### 修法：换通道，不换时机

插件清单直接声明 MCP 服务器，由宿主 MCP 管理器起进程并注册工具，完全绕开 mod core：

```jsonc
// .codebuddy-plugin/plugin.json
"mcpServers": {
  "wb_ops": { "command": "node", "args": ["${CODEBUDDY_PLUGIN_ROOT}/mcp/server.mjs"] }
}
```

工具名 = `mcp__<serverKey>__<toolName>` = `mcp__wb_ops__report`（`serverKey` 取 `wb_ops` 才与旧名一致）。

**这条路的宿主支持是三处证据坐实的**（不是照抄配置）：

1. 内置插件同法：`builtin-calendar`（http）、`workbuddy-sheetagent`（stdio，`${CODEBUDDY_PLUGIN_ROOT}/mcp/start.mjs`）。
2. `McpConfigManager.readMcpServersFromPlugins()` 遍历 `pluginManager.getActivePlugins()`，把各插件 `components.mcpServers` 合并进 MCP 配置。
3. `enrichWithPluginEnvironment()` 对 stdio 声明做替换后交给 MCP 管理器：
   ```js
   out[name] = { ...srv,
     command: substitute(srv.command),
     args: srv.args?.map(substitute),
     ...(srv.cwd && { cwd: substitute(srv.cwd) }),
     env: { ...srv.env, ...await buildPluginSubprocessEnvironment(pluginCtx) } };
   ```
   `substitute` = `substitutePluginVariables(..., {mode:"config", expandEnvironment:true})`，负责 `${CODEBUDDY_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}`。

### 验收（本机）

| 项 | 命令 | 结果 |
|---|---|---|
| 清单合法 | `plugin validate .` | ✔ Validation passed |
| 安装树齐备 | `ls cache/wb-ops-local/wb-ops/0.14.0` | `.codebuddy-plugin hooks lib mcp`（新增 `lib` `mcp`） |
| 安装态服务器可跑 | `node test/probe-installed-mcp.mjs` | `serverInfo{name:"wb-ops-report",version:"0.14.0"}` · `tools/list: report` · `tools/call isError=false` · stdout 脏行 0 |
| 真实报表内容 | 同上 | `[wb-ops 报表] 压缩 28 次 · 省 ≈65.5k tok / 258.1KB (72.9%) · 原文 354.3KB≈89.3k tok → 压缩后 96.1KB≈23.7k tok · 记账会话 3 个` |
| 协议兼容 | 单测（真子进程） | `initialize` 回显 `2025-06-18`、未知工具 -32602、未知方法 -32601 |
| mod 钩子收敛 | CLI 启动日志 | `mods: loaded mod "wb-ops" ... hooks: tool.call prompt.submit session.compact`（`session.start` 已消失） |
| 离线单测 | `node --test test/register.test.ts` | **94/94 全绿** |

### 仍未验（诚实标注）

- GUI **新会话**里工具是否真的出现在清单——取决于宿主是否为新运行时重新装配插件 MCP。`/reload-plugins` 对 mod 的 `bootstrapFunctionHookMods` 无效（记忆化），对 MCP 组件是否有效未验；**新开对话是确定路径**。
- `WB_OPS_STATS=0` 时是否仍会起 MCP 进程：当前不联动（工具在、数据为空时返回「还没有记账数据」）。若嫌多一个进程，可后续给 `mcpServers` 加条件式声明（宿主不支持条件，需要拆分插件）。

---

## 4. 验证过程踩坑（复现时必读）

| 坑 | 现象 | 规避 |
|---|---|---|
| `--session-id` 非法 UUID | 被宿主**静默忽略**、另起随机 sid → 看到的落盘是别的会话的 | 用标准 UUID（8-4-4-4-12） |
| `--plugin-dir` + 已安装版本**同时加载两份 mod** | 工作区新版 + cache 旧版各跑一遍，两套 fsprobe 写同一文件 → "新旧错误并存"是假象 | 隔离验证前先 `node scripts/install-gui.mjs --uninstall` |
| 中文路径 + Bash 引号 | 命令内联转义失败 | 固化到 `test/run-acceptance.sh`，不写内联长命令 |
| `install-gui.mjs --uninstall` 首次 ENOENT | 竞态，重跑即成功 | 无需处理 |
| `txt.length` 是字符数 | 中文场景 bytes/char ≈ 1.1–1.2，字节判断要用 `fs.stat` 的 size | v0.12.1 已改用 stat |
| **模块级状态跨会话泄漏** | `reportToolName` 放模块级 → 单测里「上个 harness 已注册」短路掉新 harness 的注册；真实运行时同理短路掉新会话 | mod 的**每会话状态**放 `register()` 闭包（宿主每会话重新引导 mod） |
| **换入口 ≠ 换 core（v0.13.1 的教训）** | 同一个 `ModsRuntime` 的所有钩子共用**一个** core；`session.start` 注册失败换 `prompt.submit` 重试，打的是同一堵墙，`catch{}` 还会把证据吞掉 | 先确认**能力差异在哪个维度**（时机？路径？core？），再选修法；能力问题换通道，别换时机——v0.14 直接放弃 mod 注册、改走 MCP |
| **只在一个时机注册** | 宿主不同路径给的 core 能力不同（应用级能注册工具 / 会话级不能）→ 单一入口必挂 | ~~关键能力挂多个入口幂等重试~~（此条已被上一条取代：入口重试只对「同一能力、不同时机」有效；**不同路径的能力差异要换通道**） |
| CLI 能注册 ≠ GUI 能注册 | 探针在 `--plugin-dir`（应用级 core）下成功，易误判"代码没问题" | 探针要分别覆盖两条路径；或直接反查 bundle 的绑定表 |

## 5. 环境还原清单（每次验证后执行）

```bash
# 1. 还原 settings.json（备份→覆盖→删除备份→核对 env=undefined）
node -e "const fs=require('fs');const p='settings.json 路径';
fs.writeFileSync(p, fs.readFileSync(p+'.wbops-bak')); fs.unlinkSync(p+'.wbops-bak');"
# 2. 删除预置 transcript、测试 debug/watermark 文件（只留真实会话产物）
# 3. 重装插件：node scripts/install-gui.mjs
# 4. 核对：plugin list → enabled；settings.json 顶层键与原始一致
```

全部历史验收过程与结论同时记录于 `.workbuddy/memory/2026-11-05.md`（仓库内）。
