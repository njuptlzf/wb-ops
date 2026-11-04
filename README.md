# wb-ops

WorkBuddy 的**上下文治理 Mod**（Mod-first）：进程内 `tool.call` 中间件，在工具结果进入模型上下文之前做确定性压缩，原文落盘可回查。错误输出**永不压缩**。目标只有一个：**降本增效——让进入上下文的每一份 token 都携带高价值信息**。

当前版本 v0.2 覆盖 **Bash**；压缩核心与事件无关，后续按事件逐个拓展（Read/Grep/Glob/WebFetch → 全生命周期出口）。命名不叫 `wb-bash-ops` 正是因为这个路线图。

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

## 行为

超过 8000 字符（可调）且退出码为 0 的 Bash 输出被压成：

- 头部 ≤12 行（含 `Command:` 行，模型知道当时跑了什么）
- 中部强关键词行（error/fatal/traceback/cannot/… 至多 40 行）
- 尾部 ≤10 行（含 `Exit Code:`）
- 一行标记：`[wb-ops] 已省略 N 行 · 原文 Xb → 落盘 ~/.workbuddy/wb-ops/spill/<sid8>/<seq>-<callId>.txt`

模型需要细节时用 Read/Grep 读 spill 路径。已带 `[wb-ops]` 或 sana 标记前缀的文本不再二次压缩。

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
| `WB_OPS_BUDGET` | 8000 | 压缩后文本长度上限（>512 才生效）；与 sana 同名同义，共存时一个值管两边 |
| `WB_OPS_DEADLINE_MS` | 100 | 压缩自设软超时；`0` 等效禁用压缩 |

## 开发 / 测试

```bash
node --test test/register.test.ts   # 12 项，全绿
```

沙箱纪律：mods 内禁止 `node:require/process/global`（引擎会当场拒绝整个 mod），`register.ts` 唯一的 import 是 `codebuddy-code` 的**纯类型**导入，运行时被擦除。所有宿主能力走 `$`：`$.env` / `$.fs.write` / `$.session.id()`。

## 已验证 / 未验证

- ✅ mods 加载、沙箱合规、`tool.call` 注册（CLI 启动日志）
- ✅ 压缩策略、透传条件、spill、并发去重（离线 mock `$` 单测）
- ⚠️ **真实 Bash 结果的运行时形状**：文档示例显示 `result` 可为 string 或对象，`extractText` 对 string / `{text}` / `{content:string}` / 单 text 块数组四种形状做了适配，其余形状透传。`/login` 后跑一条大输出命令（如 `node -e "for(let i=0;i<5000;i++)console.log('line '+i)"`），结果里出现 `[wb-ops]` 标记即闭环。
- ⚠️ GUI marketplace 目录格式装载。
