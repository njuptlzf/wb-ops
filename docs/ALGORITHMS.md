# wb-ops 省量算法说明

> 各出口的压缩算法、阈值与口径。设计动机见 [DESIGN.md](DESIGN.md)，保真度评测见 [BENCHMARK.md](BENCHMARK.md)。

## 0. 三个全局常量

| 项 | 值 | 说明 |
|---|---|---|
| **token 估算** | `estTokens(s) = ceil(中文字符数 / 1.8) + ceil(其余字符数 / 4)` | 与宿主 TokenUtils 同公式，**只用于展示**（标记行/报表/记账） |
| **压缩决策** | 按 **UTF-8 字节** | 按字符会放过中文越线输出（中文 3 字节/字，同样"字数"体积×3）；预算默认 4500 字节（`WB_OPS_BUDGET`） |
| **软超时** | 100ms（`WB_OPS_DEADLINE_MS`） | 每 512 行查一次时钟，超时放弃压缩、透传原文 |

硬性豁免（任何出口通用）：原文 ≤ 预算；原文 > 8MB；已带 `[wb-ops]` 标记（防双压）；`isError` 或异常（fail-open）。

标记行格式（所有出口统一，四段固定）：

```text
[wb-ops] 已省略 N 行 · 原文 12.4KB≈4.1k tok → ≈1.2k tok（省 71%） · 落盘 ~/.workbuddy/wb-ops/spill/<sid8>/<seq>-<callId>.txt
```

落盘原文 >4MB 时不写文件，标记如实说明"过大"。`after tok` 用压缩后正文实测（标记自身 ~20 tok 不计入，省量宁少勿多）。

## 1. shell 类（Bash / PowerShell / TaskOutput）

```text
进入条件：byteLen(raw) > budget 且 退出码 == 0（失败现场永不压缩）
│
├─ 行数 ≤ 20（少行巨字节：minified、单行 JSON dump）
│    → 字节级截断：首 60% 预算 + 尾 28% 预算，中间一行标记
│
└─ 行数 > 20（自适应三段式）
     头段：预算×30% 折算行数（8~400 行，按平均行长），保底 1 行（首行 Command: 信息量最高）
     尾段：预算×22% 折算行数（5~300 行），保底 1 行
     中段：KEY 正则命中行进池（≤40 条）
          └ 锚点扩行：命中"严重错误"的行（FATAL/ERROR/Exception/Traceback/panic/…），
             顺带保留其后 4 个连续行（堆栈帧/调用链），总量护栏 ≤60 行
          └ 抽样：超过 40 条时按「连续块」抽（块整块保留、块内均匀采样），
             不逐行撒点——打散后的堆栈帧每帧单独一行就失去意义
          └ 字节配额：关键行合计 ≤ 预算×42%（锚点块优先，其余整块丢弃），
             否则关键行独占预算会把尾部挤出预算、尾部硬截断丢掉 Exit Code 行
     Exit Code 行保底：在最后 50 行内找到则强行纳入尾段（模型必须能判断成败）
     增长：头尾各 ×1.25 扩张至多 5 轮，直到预算利用率 ≥85%（打满会塞进低价值行，不追求）
     硬截：最终仍超 预算+1200B → 字节级再截并注明 …截断
```

KEY 正则（英文+中文并集）：`error|fatal|exception|traceback|panic|fail|failure|warn|cannot|denied|refused|not found|no such file|undefined reference|segmentation|core dumped|abort|assert|timeout|timed out|exited with code|错误|失败|警告|异常|未能|无法|超时|拒绝`。

**失败分支**（提示门在预算门之前，小失败也管）：`Exit Code` 非零 → 完整透传 + 一行 `[wb-ops 提示]`。9 类可识别错误模式（路径不存在/权限/端口占用/找不到命令/依赖缺失…）→ 可执行的下一步动作；只扫头尾 4KB，防重复提示，`WB_OPS_HINTS=0` 关。

## 2. Grep / Glob（jsonlist）

宿主给的是 `content: string[]`（原生数组）：

```text
裁剪内核 trimList：
  保留前 K 条，K 按预算×70% 折算（每条封顶 1000B）
  尾部追加一条单行说明：[wb-ops] 共 N 条，已省略 M 条 · … 落盘 <path>.json
  保持数组形态回写（与宿主序列化同构，不改 content 类型）
```

JSON 数组文本形态（旧宿主）：`parseJsonList` 还原成数组后走同一内核。被裁条目整串落盘 `.json`。设计取舍：**列表尾部条目不比头部更值钱**，不硬凑尾段——计数与总数保证模型知道"还有多少没看"，要看细节读落盘文件。

## 3. Read（按文件类型分档）

`classifyRead(path)` 按扩展名定门槛——**读完多半要接着改的文件，中段不能随便丢**：

| 档 | 扩展名 | 行数门 | 硬字节阀 | 骨架 |
|---|---|---|---|---|
| 源码 | .ts/.js/.py/.go/… | **<1500 行一律不裁** | — | symbol |
| 数据 | .log/.jsonl/.csv/.txt/… | >200 行才裁 | — | keyword |
| 结构 | .json/.md | >800 行才裁 | ≥40KB 的少行 dump 走硬阀 | keyword/heading |
| 文档骨架 | — | — | — | 标题/加粗/链接行 |

行号格式 `  43→content`。**空洞指路**：中段最长连续省略段 ≥20 行时，标记行追加 ` · 回看: Read offset=<行号> limit=<≤180>`——limit 上限 180，太大又会被同一道门槛再裁一次。头尾范围比 shell 宽（20~400 / 10~300 行）。

## 4. WebFetch / WebSearch（文档骨架）

`DOC_HEAD` 骨架行 = md 标题 / 加粗行 / 裸链接 / 列表链接——文档的天然目录。正文段省略，链接与结构保留（模型要细节时带 URL 重新取，或读落盘原文）。

## 5. 通配兜底（③）

策略表之外的任何工具名（MCP `mcp__*`、宿主新增）由函数谓词 matcher 接住，走与 shell 相同的压缩核心（keyword 骨架）；`Exit Code` 非零同样整场透传；`WB_OPS_FALLBACK=0` 单独关闭。

## 6. 记账与报表口径

每次实际改写（`compress`/`compressList` 返回非 null）记一笔：

```text
stats/<sid8>.json{
  calls, before, after,                        // 字节
  tokBefore, tokAfter,                         // estTokens 口径
  kinds:   { shell|read|jsonlist|other: {...} },   // 按出口分桶
  models:  { <model>: {...} },                 // 按模型分桶（v0.16+）
  events:  [ {t, k, m, tb, ta} ≤300 条 ],      // 逐次明细（v0.16+）
}
```

三份报表（会话内 MCP 工具 / CLI `hooks/report.mjs` / 看板 `scripts/dashboard.mjs`）共用 `lib/report-core.mjs` 聚合，口径不可能漂移。**只计 wb-ops 实际改写的输出**——模型回复、用户输入、系统提示不在内。

## 7. 跳过账本（v0.18）：「为什么没压」的归因口径

记账只记**压成功**的；**没压**的那侧另有一本账。

```text
触发条件：结果**超预算**（byteLen > budget）却最终没被压缩
落盘：debug/skipped-<sid8>.json（只含元数据，正文绝不落盘）

agg:     [ {kind, reason, n, bytes, lines, tools:{}} ]     // 按 (分档, 原因) 聚合
samples: [ {t, kind, tool, reason, bytes, lines, path} ≤60 ]  // 最近明细（封顶，计数不受影响）
```

**为什么只在超预算时记**：预算内的正常透传不是漏压，记它是噪音。
非零退出码同理——只在**超预算**时记（预算内的失败本就不该压）。
同理，压缩成功时**不记**（账本是「未压缩」侧的观测）。

原因枚举（`SkipReason`，稳定标识——审计脚本按这些字符串归因，改名会断历史账本）：

| reason | 触发点 | 档 |
|---|---|---|
| `lines-gate` | Read 行数门：行数不足该档门槛 | 设计使然 |
| `exit-code` | 非零退出码：错误现场完整透传 | 设计使然 |
| `host-persisted` | 宿主已落盘并指路（`<persisted-output>`） | 设计使然 |
| `already-marked` | 已带 `[wb-ops]` 标记，防双压 | 设计使然 |
| `too-large` | 超过 8MB 上限 | 设计使然 |
| `fallback-off` | 兜底压缩被关（`WB_OPS_FALLBACK=0`） | 设计使然 |
| `deadline` | 压缩软超时（`WB_OPS_DEADLINE_MS`） | 性能 |
| `no-path` | 判不出文件路径 → 无法分档 | **疑似缺口** |
| `shape-unknown` | 结果形状判不出 | **疑似缺口** |
| `under-budget` | 字节未超预算（`compress()` 内部早退） | 正常 |
| `unknown` | 兜底分类（不该出现，出现即需排查） | **疑似缺口** |

**归因入口**：`node test/audit-tiers.mjs --from-ledger` —— 只读账本出归因表，
**不扫 transcript**（本机全量 transcript 可达数十 MB）。退出码 0 = 无疑似缺口。

