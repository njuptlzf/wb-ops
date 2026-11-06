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

离线单测：**115/115 全绿**（`node --test test/register.test.ts`（103）+ `node --test test/dashboard.test.mjs`（12））。宿主校验器：`plugin validate` ✔、`plugin list` → `enabled`。安装态探针：`node test/probe-installed-mcp.mjs` ✔。

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

全部历史验收过程与结论由本地工作日志留存（不入库）。

---

## 6. 真机安装闭环（官方《插件市场》文档校对，2026-11-05）

宿主加载一个 mod 需要三处同时成立（`enabledPlugins` + `installed_plugins.json` + `cache` 快照），**只登记 installed 条目是不够的**——`getInstalledPluginsForWorkspaceState` 的候选集直接来自 `enabledPlugins` 映射，缺它则 `status=disabled`，插件连「已安装」列表都进不去，mod 永不加载。这条是原 `install-gui.mjs` 的漏项，已补：

| 落点 | 状态 |
|---|---|
| `marketplaces/wb-ops-local/.codebuddy-plugin/marketplace.json` | ✅ 已补（官方要求：市场根目录必须有） |
| `installed_plugins.json` → `wb-ops@wb-ops-local` | ✅ 原有 |
| `settings.json` → `enabledPlugins["wb-ops@wb-ops-local"]=true` | ✅ 已补（原漏项） |

本机真机验证（`CODEBUDDY_CONFIG_DIR` 指到 `~/.workbuddy`）：

- `plugin validate` 对插件清单与市场清单**双双 ✔ Validation passed**；
- `plugin list` → `wb-ops@wb-ops-local / user / Status: enabled`；
- 宿主打印 `mods: loaded mod "wb-ops" from .codebuddy-plugin (tier user, hooks: …)`——**走市场安装路径加载**（不带 `--plugin-dir`）；
- 会话日志 `~/.workbuddy/logs/<date>/<cwd>__<sid>.log` 里可见该行：mod 在**新起的运行时**（新 pid）里生效，老运行时（启用前启动的）不加载 → 启用后要**新开对话**才生效，`/reload-plugins` 不重新引导 mod（`bootstrapFunctionHookMods` 只在启动时调用且被记忆化）。

---

## 7. 已验证 / 未验证清单（截至 v0.17）

> 未验证项的整改进度与验收方式见 [ROADMAP.md](ROADMAP.md)——本节只陈述"验没验"，路线图陈述"什么时候验、怎么验"。

### ✅ 已验证

- **通配兜底的谓词 matcher（真机闭环）**：`domain_search` 输出 52.1KB → 兜底压缩生效（头部 + 命中关键行 + 尾部，`[+NNNNB]` 单行截断正常）。函数谓词每次事件重评、路由真实生效。
- **mods 加载**（CLI 启动日志 `hooks: tool.call prompt.submit session.compact` 三通道全注册）、沙箱合规、压缩策略、透传条件、spill、并发去重、字节预算、分工具策略、错误 nextAction 提示、水位守卫与压缩保留指示、通配兜底、分类账本、水位数值文件、GUI 安装助手、形状诊断通道、水位数据源、token 口径、报表 MCP、Web 看板、看板会话名、模型维度与事件流——离线 mock API 单测 **115 项全绿**（v0.17 锚点扩行新增 3 项 + `e.input` 形状核对新增 3 项）（`node --test test/register.test.ts test/dashboard.test.mjs`）
- **Grep/Glob 输出形状**：从 86 条真实 transcript 确认 = JSON 字符串数组；真机再测发现宿主原生形态是 `content: string[]`（不是 JSON 文本）→ 已适配（单测钉死：裁条目+单行说明、保持数组形态、预算内零影响、混合类型仍 fail-open）
- **真机压缩闭环（GUI 会话）**：Bash 13.2KB / PowerShell 14.9KB / TaskOutput 30.4KB / Read .log 24.5KB（含 `回看: Read offset=34 limit=180` 空洞指路）/ MCP 兜底 52.1KB / 错误现场 Exit Code 2 完整透传 + `[wb-ops 提示]` 一行 / 预算内零影响 / Read .ts 682 行原样不裁——5 次 spill 落盘 135KB
- **报表工具（v0.14 根治）**：`mcp__wb_ops__report` 由插件清单 `mcpServers.wb_ops` 声明、宿主 MCP 管理器起进程注册。已验：清单 `plugin validate` ✔、安装树入口真实跑通（`initialize` → `tools/list` → `tools/call`，见 `test/probe-installed-mcp.mjs`）
- **`${CODEBUDDY_PLUGIN_ROOT}` 在 plugin mcpServers 里会被替换（bundle 反查实锤）**：`enrichWithPluginEnvironment` 对 stdio 声明做 `command`/`args`/`cwd` 三项替换并注入插件环境变量（内置插件 builtin-calendar / workbuddy-sheetagent 同法）
- **水位数据源根因已实锤（bundle 反查）**：`$.session.usage()` 真实返回 `{context:{tokens,window,percent},rateLimits:[]}`；`window` 真算可信；`tokens` 在 mods 绑定层恒 0（数据源本身健康：transcript `providerData.usage.inputTokens` 单调递增）。断点在宿主 mods 绑定层——可向宿主报 issue
- **大文件降级已真机验证**：用真实 21.5MB 会话文件跑 mod → `fsprobe` 得 `{"used":410003,"bytes":22666447,"truncated":true}`，与全文解析完全一致；旧错误 `transcript too big` 归零。实测 22MB 全量读 ≈115ms、内存 134MB
- **`prompt.submit` 返回 `{text,context}` 的宿主合并行为已真机验证**：`[wb-ops 水位]` 真实注入（宿主包成 `<system-reminder>`），`session.compact` instructions 合并亦验证（`trigger:"auto"` / `mergedLen:73` / `hasRetention:true`）

### ⚠️ 未验证 / 已知边界

- **宿主 `persisted-output` 阈值 ≈8KB 是硬天花板**：超过它宿主先落盘，mod 看不到原文。mod 的实际收益上限 = (预算, 8KB) 区间 + 宿主未落盘的其余工具
- **报表工具在 GUI 新会话的最终确认**：需新开对话观察 `mcp__wb_ops__report` 是否出现在工具清单（`/reload-plugins` 对 mod 引导无效，对 MCP 组件是否有效未验）
- **GUI 重启后的插件列表识别与启用点击**未验证（真机已确认 mod 会加载，即注册表三件套有效；注册表写入格式对照本机宿主自写文件复刻，install-gui.mjs 有离线装/卸单测）
- **`WB_OPS_STATS=0` 时是否仍起 MCP 进程**：当前不联动（工具在、数据为空时如实返回「还没有记账数据」）

---

## 8. v0.17：宿主 `e.input` 字段名逐个核对（P0 收口，2026-11-06）

> 对应 [ROADMAP.md](ROADMAP.md) 的「P0 · 宿主 `e.input` 字段名逐个核对」。
> 验收脚本：`node test/audit-tiers.mjs`（`--json` 供 CI；退出码 0 = 无缺口，1 = 有「判不出路径」样本）。

### 8.1 结论：`e.input` 就是它，判据正确

**宿主 mod 的 `tool.call` 事件里，工具入参对象在 `e.input` 字段上，且它是普通对象（非 JSON 字符串）。**
`toolPathOf` 的判据 `e?.input ?? e?.tool_input ?? e?.arguments` + `typeof inp === 'object'` 与之相符，
Read 分档的路径提取在真机上**从未失效过**。

三条互相独立的证据链（任一条单独成立即足以定案，此处三条同时成立）：

**① 静态：宿主 bundle 反查。**
`codebuddy-lite-wb.mjs`（CLI 侧，与 GUI 同源）模块 `42804` 的 `dispatchModsToolCall`：

```js
let E = c && t.input != null && typeof t.input === 'object' && !Array.isArray(t.input),
    A = t.input != null && typeof t.input === 'object' && !Array.isArray(t.input),
    I = E ? {...structuredClone(t.input)} : {...R, input: structuredClone(t.input)},
    P = {};
if (E || A) for (let t of p) { /* p = ["tool","tool_use_id","agentId","consent"] */ }
await n.dispatch("tool.call", {...I, tool: t.name, tool_use_id: t.callId, agentId: t.agentId}, ...)
```

- 被抽走（folded envelope）的字段只有 `p = ["tool","tool_use_id","agentId","consent"]`——**`input` 不在其中**；
- `E` 为真时事件顶层就是 input 的展开（`{file_path: …}` 直接摊平），`E` 为假时是 `{...input, input: input}`；
- 两种形态下 **`e.input` 恒为对象**，与 `E`/`c` 的取值无关。`E` 只影响"input 是摊平在顶层还是有 `input` 键"。

**② 真机：Read 分档在 GUI 会话里真的跑通过。**
`read` 档在宿主侧留下的唯一可观测痕迹是 `回看: Read offset=N limit=M`（`mode === 'read'` 独有，
其他档位不产生）。全量 transcript 里读到 **11 处**，且账本 `stats/c48f9ba5.json`、`f87c445e.json`
各记了 `read: 2` 次压缩。若 `e.input` 判不出，`toolPathOf` 返回 null → `register.ts` 的
`if (!path) return r` 会直接透传，**不可能产生 read 档标记**。

**③ 真机：全量 transcript 反查，零缺口。**
把每个 Read 结果按 `file_path` → `classifyRead()` 分档，与实际行数对照，235 条超预算未压缩的 Read
**全部**落在"行数门正确拦截"（`READ_SOURCE minLines=1500` / `READ_DOC|STRUCT 800` / `READ_DATA 200`），
**没有一条**属于"判不出路径"：

```
== ③ Read 档归因（超预算却没被压缩）==
   行数门正确拦截: 235
   mod 已压缩:     14
   宿主已落盘:     0
   判不出路径(缺口): 0
```

### 8.2 逐个工具的 input 字段名（真实 transcript，7493 次调用）

`node test/audit-tiers.mjs` ① 表，摘要：

| 工具 | 调用数 | 路径键 | 实际 input 键名 | 走的档 |
|---|---|---|---|---|
| Read | 689 | `file_path` | `file_path, limit, offset` | read |
| Edit | 1467 | `file_path` | `file_path, new_string, old_string` | other（兜底） |
| Write | 245 | `file_path` | `content, file_path` | other（兜底） |
| Grep | 169 | `path` | `path, pattern, -n, head_limit, output_mode, glob` | jsonlist |
| Glob | 11 | `path` | `path, pattern` | jsonlist |
| Bash | 4266 | — | `command, description, timeout, run_in_background` | shell |
| PowerShell | 43 | — | `command, description, timeout` | shell |
| TaskOutput | 129 | — | `task_id, block, timeout` | shell |
| WebFetch | 24 | — | `url, prompt` | doc |
| WebSearch | 25 | — | `query, freshness` | doc |
| ViewImage | 152 | — | `image_path, query` | other（兜底） |
| Edit/Write 之外无路径键者 | — | — | Task* 系列、present_files、ToolSearch、AskUserQuestion… | other（兜底） |

**关键澄清**：`toolPathOf` **只在 `kind === 'read'` 时被调用**（`register.ts` 两处调用都在 read 分支内），
shell / jsonlist / doc / other 四档**从不读 input 的路径字段**。因此：

- 「`e.input` 字段名」只影响 **Read 一档**的深度分档（源码/文档/数据/结构），不影响别的档是否生效；
- Write / Edit 走兜底是**策略有意为之**（写入类工具的输出本来就小，压缩收益低），
  不是"判不出路径所以走兜底"——它们**有** `file_path`，`toolPathOf` 能取到，只是策略没让它们走 read 档；
- Grep / Glob 的 `path` 是**目录**（如 `...\docs`），语义与 Read 的文件路径不同，本就不该喂给 `classifyRead`。

### 8.3 分档命中率与未压缩归因

`node test/audit-tiers.mjs` ②③ 表。全量 transcript（约 7500 条工具结果）：

| 工具 | 结果数 | 超预算 | 结局 |
|---|---|---|---|
| Bash | 4262 | 232 | mod已压缩 47 · 非零Exit Code 透传 6 · 生效前历史 159 · 未归因 20 |
| Read | 689 | 249 | 行数门拦截 235 · mod已压缩 14 |
| Grep | 169 | 12 | 生效前历史 12 |
| WebSearch | 25 | 11 | mod已压缩 3 · 生效前历史 8 |
| WebFetch | 24 | 8 | mod已压缩 2 · 生效前历史 4 · 未归因 2 |
| 其他 | — | — | 均 ≤2 条，逐条核对为历史数据或宿主自身落盘 |

**"生效前历史"的口径**：压缩能力在本机 transcript 中最早留下 `[wb-ops]` 标记的时间是
**2026-11-05 11:28:19**（本地时区）。此前 187 条"超预算未压缩"是插件尚未生效时的历史数据，**不计入缺口**。

**未归因项逐条核对结果**（`未归因` 20 条 Bash + 2 条 WebFetch + 1 条 Glob）：

- 20 条 Bash：全部落在 **11-05 13:45–13:53**（插件刚安装的调试期），此后（11-05 14:00 → 11-06 全天）
  shell 档 **未压缩 0 条 / 压缩 49 条**——属历史残留，非当前缺陷；
- 2 条 WebFetch + 1 条 Glob：经查该会话（`90e7ce2c`）**无 stats 账本**（当时 `WB_OPS_STATS` 未开），
  且 Glob 那次的 transcript `arguments` 记录串位（记录了前一个 Bash 的参数），属宿主记录侧现象，
  与 mod 无关。

**11-06 全天（插件稳定运行期）shell 档：超预算未压缩 0 条，成功压缩 15 条。**

### 8.4 由此得出的两条工程结论

1. **`e.input` 判据无需修改**——它在真机上 100% 命中，`tool_input` / `arguments` 两个候选键是冗余但无害的兜底。
2. **可观测性缺口**：本次定位耗时最长的不是判据本身，而是"**超预算却没被压缩**"缺少归因出口。
   `register.ts` 现有诊断通道只覆盖"**结果形状判不出**"（`describeShape`），没有覆盖"**压缩没发生**"。
   下一步应补一条 `compress-skipped` 诊断（记录 kind / 字节 / 行数 / 拦截原因：行数门 / deadline / 非零退出码），
   让这类问题下次一分钟内自证，不必再翻 180MB bundle 与全量 transcript。

### 8.5 本次核对的取舍

- 未采用"装探针 mod 跑真机"的方案：探针版（0.17.0-probe）已装但**mod 只在新运行时生效**，
  且 CLI 侧报 `Authentication required` 跑不了模型回合；而静态 bundle + 真机 transcript + 账本
  三条证据已经闭环，探针的边际收益不足以抵消它引入的"重装/回滚"风险；
- 全量 transcript 用**字节**口径判定超预算（与 `DEFAULT_BUDGET` 的字节语义一致）——
  字符口径会漏掉中文密集的内容（Grep 12 条 vs 字符口径 8 条）；
- 本节的"生效前历史"判定基于**本机** transcript，新机器跑同一脚本时该数字会变，
  但"判不出路径 = 0"这个结论与机器无关。

---

## 9. v0.18：`compress-skipped` 诊断出口（P0 收口，2026-11-06）

### 9.1 问题：压缩会放弃，但放弃不留痕

压缩的核心是"超预算就压回去"。但压缩**会主动放弃**——Read 行数门、错误现场保护、
软超时、双压防护、宿主已落盘……放弃时若不留痕，就留下一个黑洞：

> 输出超了预算、原样进了上下文、模型多烧一轮 token，而插件侧**没有任何记录**说清是谁拦下的。

§8.4 已经点出这个缺口：v0.17 归因 235 条 Read + 20 条 Bash 未压缩，
耗时最长的不是判据本身（20 分钟就定了），而是**翻全量 transcript 逐条反查**，
且结论无法复现——下次再遇到还是得重查一遍。

### 9.2 做法：让「放弃」自报原因

改动落在两处：

1. **`compress()` 新增 trace 出参**——此前每个 `return null` 都是**匿名**的，
   调用方只知道"没压"，不知道"为什么没压"。现在每个放弃点都带上原因：
   `lines-gate` / `deadline` / `exit-code` / `already-marked` / `under-budget`；
2. **跳过账本**——handler 把每条"超预算却没被压缩"的路径写进
   `debug/skipped-<sid8>.json`：

```text
agg:     [ {kind, reason, n, bytes, lines, tools:{}} ]     // 按 (分档, 原因) 聚合
samples: [ {t, kind, tool, reason, bytes, lines, path} ≤60 ]  // 最近明细
```

聚合与明细**分两段**是刻意的：聚合回答"哪类漏压最多、漏了多少体量"，
明细回答"具体哪个文件、哪次调用"。只有明细会封顶，**计数不受影响**——
否则账本会随会话变长而失真。

### 9.3 记账口径：只在确实超预算时记

这是设计里最容易做错的一环。首版实现对**所有**非零退出码记账，
结果正常的失败命令（预算内、几百字节）也会进账本——账本立刻被噪音淹没，
"归因"也就没了意义。最终口径：

| 情形 | 记账？ | 理由 |
|---|---|---|
| 结果超预算且没被压缩 | ✅ | 这就是"漏压"，正是账本要记的 |
| 结果在预算内 | ❌ | 本来就没打算压，不是漏压 |
| 预算内的非零退出码 | ❌ | 同上（失败本身不是漏压） |
| 压缩成功 | ❌ | 账本是"未压缩"侧的观测 |

实现上用便宜的判据先筛（`len * 3 >= budget` → 才去算精确字节），
避免为记账给热路径加全量扫描。

### 9.4 原因分三档：设计使然 / 性能 / 疑似缺口

| 档 | 原因 | 审计含义 |
|---|---|---|
| 设计使然 | `lines-gate`、`exit-code`、`host-persisted`、`already-marked`、`too-large`、`fallback-off` | 透传是策略，不是缺陷 |
| 性能 | `deadline` | 不是判据错，是软超时没赶上（可调 `WB_OPS_DEADLINE_MS`） |
| **疑似缺口** | `no-path`、`shape-unknown` | 判据没命中或宿主改形状——**真出现就要查** |

分档的意义：账本里出现 `lines-gate` 238 次是正常的（Read 行数门在起作用），
出现 `no-path` 2 次就要查判据。**没有分档的账本是没法用的**——全是噪音。

### 9.5 验收

**归因入口**（v0.18 新增）：

```bash
node test/audit-tiers.mjs --from-ledger      # 只读账本归因，不扫 transcript
node test/audit-tiers.mjs --from-ledger --json
```

本机实测（本功能刚落地，尚无真实账本文件，故用等价形态的账本验证解析与判定）：

```
== 跳过账本归因（插件自报，不翻 transcript）==
   账本文件: 1 个 · 目录: …/wb-ops/debug
   分档/原因                            次数          字节       行数  说明
   --------------------------------------------------------------------------------------------
   read/lines-gate                 238   12056.3KB    91000  Read 行数门（行数不足该档门槛）
                                                             工具: Read×238
   shell/deadline                   14     229.1KB    12000  压缩软超时（可调 WB_OPS_DEADLINE_MS）
                                                             工具: Bash×14
   read/no-path                      2       8.8KB      300  判不出文件路径 → 无法分档  ⚠疑似缺口
                                                             工具: Read×2

   合计漏压: 254 次 · 疑似缺口: 2 次
== 结论：账本里有 2 次疑似缺口（no-path / shape-unknown）——需排查判据 ==
```

退出码：疑似缺口 > 0 → 1，否则 0（可直接作 CI 门禁）。

**默认模式交叉核对**：`node test/audit-tiers.mjs`（全量 transcript 核对）
现在额外打印账本归因，并把两边的"未归因"数量并列——
transcript 反查是**事后猜**的，账本是**当下决定**的，两者应能互证。
本次核对结论（无缺口）与 v0.17 一致：Read 判不出路径 **0** 条。

**单测**：115 → **128** 全绿（新增 13 项）：

| 用例 | 钉死的行为 |
|---|---|
| `compress()` trace 四种原因 | 行数门 / 软超时 / 非零退出码 / 预算内，各自报对原因与行数 |
| Read 行数门 → 账本 | kind=read、n=1、bytes/lines 都有、**path 落到具体文件** |
| 判不出路径 → `no-path` | 归入**缺口档**（`GAP_SKIP_REASONS`） |
| **账本绝不含正文** | 正文与正文片段都不进账本；样本字段白名单校验 |
| 预算内不记账 | 正常透传不进账本 |
| 预算内失败不记账 | 非零退出码但未超预算 → 不记 |
| 聚合语义（纯函数） | 同类合并、异类分开、字节/行数/工具维度累计 |
| `countLines` | 行数口径与 `split('\n').length` **逐字一致** |
| `roughBytes` | 不分配中间字符串求体量上界 |
| 写盘失败 | fail-open：账本写失败不影响工具结果 |
| 压缩成功不记账 | 压了就不记漏压 |

**benchmark**：9 夹具全部门禁通过，合计省量 85.6%（与 v0.17 持平——本改动不触碰压缩算法，只加观测）。

### 9.6 这次改动的取舍

- **只加观测，不动压缩算法**：压缩率、标记格式、落盘策略一律不变。
  benchmark 的省量数字与 v0.17 完全一致（85.6%），可作为"没碰算法"的旁证。
- **账本只在"未压缩"侧写**：压缩成功时不写，因此热路径写盘频率不增反减
  （压缩成功才是高频路径，账本记的是例外）。
- **明细封顶 60 条**：防止长会话把账本撑大；但**聚合计数不受影响**，
  归因结论始终准确。
- **原因枚举是稳定标识**：审计脚本按字符串归因，改名会断历史账本——
  故 `SkipReason` 在 `register.ts` 与 `audit-tiers.mjs` 两处**手工同步**，
  两边都有各自的常量表（`SKIP_REASONS`）。
- **未做**：把账本接进看板（`dashboard.mjs`）。看板现在只展示"省了多少"，
  "漏压了多少"是另一个问题（需要新的信息层级），不在本 P0 范围内。
