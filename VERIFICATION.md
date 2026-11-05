# wb-ops 验证报告

本文档落盘 wb-ops 全部真机验证的**流程、原始数据与结论**，可复现。验证环境：Windows 11 + WorkBuddy-cn（CLI 运行时 `codebuddy-lite-wb.mjs`）+ Node v22.22.2。

| 版本 | 日期 | 结论 | 提交 |
|---|---|---|---|
| v0.12.0 | 2026-11-05 | ✅ 三项全过（沙箱读权限 / 水位提醒 / auto-compact 合并） | `cce1dd1` |
| v0.12.1 | 2026-11-05 | ✅ 大文件降级（22MB transcript 不再失守） | `802458a` |

离线单测：**91/91 全绿**（`node --test test/register.test.ts`）。宿主校验器：`plugin validate` ✔、`plugin list` → `enabled`。

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

## 4. 验证过程踩坑（复现时必读）

| 坑 | 现象 | 规避 |
|---|---|---|
| `--session-id` 非法 UUID | 被宿主**静默忽略**、另起随机 sid → 看到的落盘是别的会话的 | 用标准 UUID（8-4-4-4-12） |
| `--plugin-dir` + 已安装版本**同时加载两份 mod** | 工作区新版 + cache 旧版各跑一遍，两套 fsprobe 写同一文件 → "新旧错误并存"是假象 | 隔离验证前先 `node scripts/install-gui.mjs --uninstall` |
| 中文路径 + Bash 引号 | 命令内联转义失败 | 固化到 `test/run-acceptance.sh`，不写内联长命令 |
| `install-gui.mjs --uninstall` 首次 ENOENT | 竞态，重跑即成功 | 无需处理 |
| `txt.length` 是字符数 | 中文场景 bytes/char ≈ 1.1–1.2，字节判断要用 `fs.stat` 的 size | v0.12.1 已改用 stat |

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
