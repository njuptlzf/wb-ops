/**
 * wb-ops — WorkBuddy Mod：工具输出治理（进程内，确定性，fail-open）
 * v0.3 覆盖面：Bash / PowerShell / TaskOutput / Grep / Glob / Read / WebFetch / WebSearch。
 * 后续按事件逐个拓展（所有烧 token 的出口）。
 *
 * 设计规则（吸取同类 shell-hook 输出治理工具"同步子进程+全量扫描击穿宿主超时预算"的事故教训，见 docs/DESIGN.md）：
 *  1. 零子进程：只做 Mods 的 tool.call 中间件，不注册任何 shell hook。
 *  2. fail-open：未知形状、任何异常、超预算(时间/体积) —— 一律原样返回工具结果。
 *  3. 错误透传：isError 或 Exit Code 非零的输出不压缩（保完整现场）；shell 失败现场另附一行
 *     nextAction 提示（HINTS 表），对应 dsh-ops「报错重试循环」遏制原则——提示不是压缩，不加预算负担。
 *  4. 确定性策略：head/tail + 关键行 + 原文落盘（spill）带回查路径，热路径无 LLM。
 *  5. 并发安全：无共享可变状态文件；spill 文件名含 session/callId/序号，互不覆盖。
 *  6. 双压缩防护：已带本插件或同类工具标记的文本不再处理。
 *  7. 宿主已兜底的不碰：Read 的 <persisted-output>（宿主自己落盘并给预览）直接透传。
 *
 * 数值来源：经同类工具长期真实使用校准过的阈值（字节预算、头尾占比 30/22、
 * FILL_TARGET 85%、KEY 行 40 条均匀抽样、空洞指路 ≥20 行等）——已被大量测试与
 * 真实使用磨出来的数字，重调一遍纯烧 token。
 *
 * 沙箱约束：mods 内禁止 node:require/process/global —— 本文件零运行时 import、不碰 global；
 * 文件系统走 $.fs，环境变量走 $.env，会话走 $.session。
 */

import type { On } from 'codebuddy-code';

const MARKER = '[wb-ops]';                   // 本 Mod 的标记
// 同类 shell-hook 输出治理工具的真实标记前缀，共存防双压。
const FOREIGN_MARKERS = ['[wb-ops 省略', '[wb-ops 以下为原文末尾'];

const DEFAULT_BUDGET = 4500;                 // 预算按 UTF-8 字节计（中文 3 字节≈1 token，按字符会漏）。
                                          // 4500 而非 8000：宿主 Bash/Grep 的 <persisted-output> 落盘阈值实测 ≈8KB
                                          // （"Output too large (8.3KB)"），预算贴近阈值时 mod 的可压缩区间被宿主抢走，
                                          // 4500 留出 ~45% 余量，保证 (预算, 宿主阈值) 这段"宿主不管"的区间真正归 mod。
const DEFAULT_DEADLINE_MS = 100;             // 压缩自设软超时；超时放弃，返回原文
const DEFAULT_GUARD_PCT = 85;                // 水位守卫阈值（%. usage 形状判不出即静默）
const MAX_SPILL_CHARS = 4_000_000;           // 落盘写入门槛：超过不写（唯一的同步 IO 必须封顶）
const MAX_INPUT_BYTES = 8_000_000;           // 超大输入一律透传（split 本身都不做）
const TX_TAIL_CHARS = 4_000_000;             // transcript 超大时只解析尾部这么多字符（≈尾部 40 行富余）
const LINE_MAX_BYTES = 1000;                 // 单行展示上限（防 minified 巨行吃满预算）
const KEY_MAX_LINES = 40;                    // 中段捞回上限，超出均匀抽样
const KEY_POOL_MAX = 4000;                   // 命中爆炸护栏：池满即用已有部分
const ANCHOR_AFTER = 4;                     // 锚点扩行：严重错误行后顺带保留的连续行数（堆栈帧）
const ANCHOR_MAX = 60;                      // 锚点扩行总量护栏（防止满屏错误时无限扩）
const KEY_BYTE_SHARE = 0.42;                // 关键行可占预算的最大比例（其余留给头尾与标记）
// 严重错误锚点：命中这些的行会额外带上后续上下文行（堆栈帧/调用链）
const SEVERE = /(fatal|exception|traceback|panic|segmentation|core dumped|abort|assertion|\berror\b|错误|异常|崩溃|致命)/i;
const GAP_HINT_MIN_LINES = 20;               // 空洞指路门槛
const GAP_HINT_MAX_LIMIT = 180;              // 指路 limit 上限：太大又会被同一道门槛裁一次
const READ_HEAD_MIN = 20, READ_HEAD_MAX = 400, READ_TAIL_MIN = 10, READ_TAIL_MAX = 300;
const HEAD_MIN = 8, HEAD_MAX = 400, TAIL_MIN = 5, TAIL_MAX = 300;
const FILL_TARGET = 0.85;                    // 预算利用率目标（打满会塞进低价值行，不追求）
const GROW_ROUNDS = 5;                       // 头尾扩张轮数上限（每轮 ×1.25）
const MARKER_RESERVE = 1200;                 // 硬截余量（标记行本身要放得下）
// ponytail: 上限=4MB 以上的原文不落盘（仍压缩，标记如实说明「过大」）；升级路径=分块异步写或
// 只存最长空洞段。100MB split 约 0.5–1s，线性且有引擎 10s 兜底。

// 关键行（英文+中文+warn 档并集）
const KEY = /(error|fatal|exception|traceback|panic|fail|failure|warn|cannot|denied|refused|not found|no such file|undefined reference|segmentation|core dumped|abort|assert|timeout|timed out|\bexited with code\b|错误|失败|警告|异常|未能|无法|超时|拒绝)/i;
// 源码骨架行（子串匹配）
const SYMBOLS = ['#include', 'function ', 'def ', 'class ', 'struct ', 'namespace ', 'impl ', 'interface ', 'pub fn', 'export ', 'typedef ', 'import '];
// 文档骨架：md 标题 / 加粗标题 / 链接行（WebFetch/WebSearch 输出的天然目录）
const DOC_HEAD = /^#{1,6}\s|^\*\*|^https?:\/\/|^\s*[-*]\s\[|^\[[^\]]+\]\(/;
// Read 行号前缀：`  43→content`（实测 WorkBuddy Read 输出格式）
const READ_LINE_NO = /^\s*(\d+)\u2192/;

/** Read 分档（读完多半要接着改的，门槛高，中段不能随便丢） */
const DATA_EXTS = ['.log', '.jsonl', '.ndjson', '.csv', '.tsv', '.out', '.err', '.txt'];

/**
 * v0.18 P0：压缩**未发生**的拦截原因（v0.17 核对时暴露的可观测性缺口）。
 *
 * 语义：这些原因全部表示「结果超预算却没有被压缩」。分两类：
 *  - 有意为之（policy）：非零退出码、宿主已落盘、行数门、已带标记、超大输入、兜底关闭；
 *  - 疑似缺口（gap）：判不出路径、形状判不出、压缩超时——真出现就得查。
 *
 * 稳定标识：审计脚本（test/audit-tiers.mjs）按这些字符串归因，改名会断历史账本。
 */
export type SkipReason =
  | 'lines-gate'       // Read 行数门：行数不足该档门槛，保守透传
  | 'deadline'         // 压缩软超时（WB_OPS_DEADLINE_MS）
  | 'exit-code'        // 非零退出码：错误现场完整透传
  | 'host-persisted'   // 宿主已落盘并指路（<persisted-output>）
  | 'no-path'          // 判不出文件路径 → 无法分档（疑似缺口）
  | 'already-marked'   // 已带 [wb-ops] 标记，防双压
  | 'too-large'        // 超过 MAX_INPUT_BYTES 上限
  | 'shape-unknown'    // 结果形状判不出（疑似缺口）
  | 'fallback-off'     // 兜底压缩被关（WB_OPS_FALLBACK=0）
  | 'under-budget'     // 字节未超预算（compress 内部早退，直接调用者用）
  | 'unknown';         // 兜底分类（不该出现，出现即需排查）

export const SKIP_REASONS: readonly SkipReason[] = [
  'lines-gate', 'deadline', 'exit-code', 'host-persisted', 'no-path',
  'already-marked', 'too-large', 'shape-unknown', 'fallback-off',
  'under-budget', 'unknown',
];

/** 疑似缺口：真出现就要查判据/宿主形状，而不是当成设计使然。 */
export const GAP_SKIP_REASONS: readonly SkipReason[] = ['no-path', 'shape-unknown'];
/** 性能类：不是判据错，是软超时没赶上——可调 WB_OPS_DEADLINE_MS。 */
export const PERF_SKIP_REASONS: readonly SkipReason[] = ['deadline'];

/**
 * 一条跳过记录：**只含元数据，绝不含工具正文**（正文绝不落盘是本项目的硬纪律）。
 * bytes/lines 判不出时为 null（形状未知时连长度都不可信，宁缺毋滥）。
 */
export interface SkipEntry {
  t: string;             // ISO 时刻
  kind: string;          // 分档（shell/read/jsonlist/doc/other）
  tool: string;          // 工具名
  reason: SkipReason;
  bytes: number | null;  // 原文字节
  lines: number | null;  // 原文行数
  chars?: number;        // 字符数（字节不可知时至少留个量级）
  path?: string;         // read 档的文件路径（判不出路径时没有）
}

/** 归因聚合：按 (kind, reason) 汇总计数与体量，tools 给出工具维度拆分。 */
export interface SkipAgg {
  kind: string;
  reason: SkipReason;
  n: number;             // 次数
  bytes: number;         // 累计字节（bytes 不可知的样本不计）
  lines: number;         // 累计行数（同上）
  tools: Record<string, number>;
}

/** 跳过账本文件结构（debug/skipped-<sid8>.json）。 */
export interface SkipLedger {
  v: number;
  updated: string;
  agg: SkipAgg[];
  samples: SkipEntry[];  // 最近 N 条明细（封顶，计数不受影响）
}

interface ReadGate { minLines: number; hardBytes: number; skeleton: 'keyword' | 'symbol' | 'heading'; }
const READ_SOURCE: ReadGate = { minLines: 1500, hardBytes: 0, skeleton: 'symbol' };
const READ_DATA: ReadGate = { minLines: 200, hardBytes: 0, skeleton: 'keyword' };
const READ_STRUCT: ReadGate = { minLines: 800, hardBytes: 40000, skeleton: 'keyword' };
const READ_DOC: ReadGate = { minLines: 800, hardBytes: 40000, skeleton: 'heading' };

export function classifyRead(path: string): ReadGate {
  const p = (path || '').trim().toLowerCase().replace(/\\/g, '/');
  if (p.endsWith('.md') || p.endsWith('.markdown')) return READ_DOC;
  if (p.endsWith('.json')) return READ_STRUCT;
  for (const e of DATA_EXTS) if (p.endsWith(e)) return READ_DATA;
  return READ_SOURCE;
}

/** 工具 → 策略。前 8 个按文档验证过的字面 matcher 注册；其余工具名走末尾谓词 matcher（③ 兜底）。 */
const POLICY: Record<string, string> = {
  Bash: 'shell', PowerShell: 'shell', TaskOutput: 'shell',
  Grep: 'jsonlist', Glob: 'jsonlist',
  Read: 'read', WebFetch: 'doc', WebSearch: 'doc',
};
const KNOWN_TOOLS = new Set(Object.keys(POLICY));

/**
 * 错误现场 nextAction 提示（dsh-ops 原则④「遏制报错重试循环」：一行可执行的下一步，
 * 比模型盲目重跑省一整轮）。首中即停、至多一行；WB_OPS_HINTS=0 可关。
 */
export const HINT_PREFIX = '[wb-ops 提示] ';
export const HINTS: Array<[RegExp, string]> = [
  [/(command not found|not recognized as|No such command|不是内部或外部命令|无法将.+识别为)/i, '命令不存在：核对拼写，用 where.exe/Get-Command <命令> 确认 PATH'],
  [/(permission denied|access is denied|EACCES|operation not permitted|拒绝访问)/i, '权限不足：确认是否需要提权或目标只读/被占用'],
  [/(no such file or directory|ENOENT|找不到指定的路径|找不到文件)/i, '路径不存在：先 ls/pwd 确认 cwd 与目标路径拼写'],
  [/(EADDRINUSE|address already in use|port .+already in use|端口.+占用)/i, '端口被占：netstat -ano | findstr <端口> 找 PID，处理占用进程后重试'],
  [/(cannot find module|module not found|MODULE_NOT_FOUND)/i, '模块缺失：确认依赖已装（npm install）或入口路径正确'],
  [/(ModuleNotFoundError|ImportError|No module named)/i, 'Python 包缺失：pip install 对应包，并确认虚拟环境已激活'],
  [/(npm ERR! 404|404 Not Found|ENOTFOUND|getaddrinfo|ETIMEDOUT|ECONNREFUSED|ECONNRESET|Could not resolve host|连接(超时|失败))/i, '网络/源问题：检查代理与 DNS，或换 registry 重试'],
  [/(not a git repository|fatal: not a git)/i, '不在 git 仓库内：cd 到项目根目录，确需新仓库再 git init'],
  [/(exit code: 124|timed out)/i, '超时：拆小任务或加超时参数，先排查是否在等交互输入'],
];
/** 错误几乎总在头（命令回显后的 Stderr）或尾（Exit Code 前）；扫描限 4KB+4KB，10MB 输出也不拖慢。 */
export function hintFor(raw: string): string | null {
  const zone = raw.length <= 8000 ? raw : raw.slice(0, 4000) + '\n' + raw.slice(-4000);
  for (const [re, hint] of HINTS) if (re.test(zone)) return hint;
  return null;
}

interface Cfg { enabled: boolean; budget: number; deadlineMs: number; home: string; stats: boolean; hints: boolean; guard: boolean; guardPct: number; guardFs: boolean; projects: string; fallback: boolean; }
type Sink = { put: (s: string | string[]) => unknown };
export interface Compression { text: string; dropped: number; }
/** extractText 的产物：raw = 可压缩的纯文本；items = 原生字符串数组（宿主 Grep/Glob 形态）；isArray = sink 收数组而非文本。 */
export interface ExtractResult { raw: string; sink: Sink; items?: string[]; isArray?: boolean }

// ---------------------------------------------------------------- text shape

/** 从未知形状的 ToolResult 中提取可安全替换的纯文本；未知形状返回 null（透传）。 */
export function extractText(res: unknown): ExtractResult | null {
  if (typeof res === 'string') return { raw: res, sink: { put: (s) => s } };
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    if (typeof o.text === 'string') return { raw: o.text, sink: { put: (s) => ({ ...o, text: s }) } };
    if (typeof o.content === 'string') return { raw: o.content, sink: { put: (s) => ({ ...o, content: s }) } };
    if (Array.isArray(o.content)) {
      const texts = o.content.filter((b) => b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string');
      if (texts.length === 1 && texts[0].text.length > 0) {
        const i = o.content.indexOf(texts[0]);
        return {
          raw: texts[0].text,
          sink: { put: (s) => { const c = o.content.slice(); c[i] = { ...c[i], text: s }; return { ...o, content: c }; } },
        };
      }
      // 宿主 Grep/Glob 的原生形态：content 是**纯字符串数组**（如 ["C:\\a.ts","C:\\b.ts"]），
      // 不是 {text} 块数组——上面的块分支永远不命中，必须单开一条，否则 jsonlist 通道形同虚设。
      // 宿主把该数组序列化成 JSON 文本发给模型，所以回写保持"数组"形态最安全（与原生同构）。
      if (o.content.length > 0 && o.content.every((x) => typeof x === 'string')) {
        const arr = o.content as string[];
        return {
          raw: JSON.stringify(arr),
          sink: { put: (s) => ({ ...o, content: s }) },
          items: arr,
          isArray: true,
        };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ shape diagnostics
// 只描述结构（键名 / 类型 / 长度 / 数值），**绝不吐正文**——诊断信息要落盘，不能把工具内容写进磁盘。
const DEBUG_LIMIT = 20;                       // 每会话诊断条数上限（热路径纪律：低频、可关、失败静默）

export function describeShape(v: unknown, depth = 0): Record<string, unknown> {
  if (v === null) return { t: 'null' };
  if (typeof v === 'string') return { t: 'string', len: v.length };
  if (typeof v === 'number') return { t: 'number', v: Number.isFinite(v) ? v : null };
  if (typeof v === 'boolean') return { t: 'boolean', v };
  if (typeof v !== 'object') return { t: typeof v };
  if (depth >= 2) {
    const keys = Object.keys(v as object).slice(0, 20);
    return { t: Array.isArray(v) ? 'array' : 'object', keys };
  }
  if (Array.isArray(v)) {
    const allStr = v.length > 0 && v.every((x) => typeof x === 'string');
    let totalLen: number | undefined;
    if (allStr) { totalLen = 0; for (const x of v as string[]) totalLen += x.length; }
    return { t: 'array', len: v.length, totalLen, first: v.length ? describeShape(v[0], depth + 1) : null };
  }
  const o = v as Record<string, unknown>;
  const keys: Record<string, unknown> = {};
  for (const k of Object.keys(o).slice(0, 20)) keys[k] = describeShape(o[k], depth + 1);
  return { t: 'object', keys };
}

/** 形状里是否存在「长字符串」——判不出文本且内容够大才值得记一条诊断。 */
export function hasLongString(shape: Record<string, unknown>, min: number): boolean {
  if (shape.t === 'string' && typeof shape.len === 'number' && shape.len >= min) return true;
  if (shape.t === 'array') {
    if (typeof shape.totalLen === 'number' && shape.totalLen >= min) return true;
    return !!shape.first && hasLongString(shape.first as Record<string, unknown>, min);
  }
  if (shape.t === 'object' && shape.keys && typeof shape.keys === 'object') {
    for (const k of Object.keys(shape.keys as object)) {
      if (hasLongString((shape.keys as Record<string, unknown>)[k], min)) return true;
    }
  }
  return false;
}

/** 诊断落盘：~/.workbuddy/wb-ops/debug/<name>-<sid>.json（最多 20 条，失败静默）。 */
async function writeDebug($: any, home: string, sid: string, name: string, entry: Record<string, unknown>): Promise<void> {
  try {
    if (!home) return;
    const dir = `${home.replace(/\\/g, '/')}/.workbuddy/wb-ops/debug`;
    const path = `${dir}/${name}-${sid}.json`;
    let rows: unknown[] = [];
    try {
      const cur = await $.fs.read(path);
      const txt = typeof cur === 'string' ? cur : cur && typeof (cur as { text?: unknown }).text === 'string' ? (cur as { text: string }).text : '';
      if (txt) { const p = JSON.parse(txt); if (Array.isArray(p)) rows = p; }
    } catch { /* 首次：没有就空数组 */ }
    rows.push({ t: new Date().toISOString(), ...entry });
    await $.fs.write(path, JSON.stringify(rows.slice(-DEBUG_LIMIT)));
  } catch { /* 诊断失败不影响主链路 */ }
}

// ------------------------------------------------------- compress-skipped 账本（v0.18 P0）
//
// 为什么要有这个出口：v0.17 核对「超预算却没被压缩」时，只能翻全量 transcript
// 手工反查（235 条 Read + 20 条 Bash，耗时最长的就是这一步）。根因是**压缩放弃
// 时不留任何痕迹**——compress() 的每个 `return null` 都是匿名的，调用方只知道
// 「没压」，不知道「为什么没压」。
//
// 现在：放弃压缩时把原因自报出来，聚合写进 debug/skipped-<sid>.json。
// 归因从「翻 7500 条 transcript」变成「读一条账本」。
//
// 三条硬纪律：
//  1. **绝不写正文**——只记 kind/工具名/原因/字节/行数/路径，不记任何输出内容。
//  2. **热路径纪律**——账本是「未压缩」侧的观测，写盘频率天然低（压缩成功才频繁）。
//  3. **失败静默**——账本写失败绝不影响主链路（透传原文照旧）。

const SKIP_LEDGER_LIMIT = 60;              // 明细样本封顶（聚合计数不受影响）

/**
 * 把一条跳过记录并入账本（纯函数，便于单测）。
 * 聚合按 (kind, reason) 归并，tools 维度再拆一层——归因时能直接回答
 * 「哪个工具、哪个分档、被什么原因拦下」。
 */
export function mergeSkip(led: SkipLedger, e: SkipEntry): SkipLedger {
  const agg = led.agg.slice();
  const i = agg.findIndex((a) => a.kind === e.kind && a.reason === e.reason);
  if (i >= 0) {
    const a = agg[i];
    agg[i] = {
      ...a,
      n: a.n + 1,
      bytes: a.bytes + (e.bytes ?? 0),
      lines: a.lines + (e.lines ?? 0),
      tools: { ...a.tools, [e.tool]: (a.tools[e.tool] ?? 0) + 1 },
    };
  } else {
    agg.push({
      kind: e.kind, reason: e.reason, n: 1,
      bytes: e.bytes ?? 0, lines: e.lines ?? 0,
      tools: { [e.tool]: 1 },
    });
  }
  const samples = led.samples.concat([e]);
  return {
    v: led.v,
    updated: e.t,
    agg,
    samples: samples.length > SKIP_LEDGER_LIMIT ? samples.slice(-SKIP_LEDGER_LIMIT) : samples,
  };
}

/** 空账本。 */
export function emptySkipLedger(): SkipLedger {
  return { v: 1, updated: '', agg: [], samples: [] };
}

/**
 * 跳过账本落盘：~/.workbuddy/wb-ops/debug/skipped-<sid>.json。
 * 读改写（无 append 能力，与 stats 账本同模式）；失败静默。
 */
async function writeSkipLedger($: any, home: string, sid: string, e: SkipEntry): Promise<void> {
  try {
    if (!home) return;
    const dir = `${home.replace(/\\/g, '/')}/.workbuddy/wb-ops/debug`;
    const path = `${dir}/skipped-${sid}.json`;
    let led = emptySkipLedger();
    try {
      const cur = await $.fs.read(path);
      const txt = typeof cur === 'string' ? cur : cur && typeof (cur as { text?: unknown }).text === 'string' ? (cur as { text: string }).text : '';
      if (txt) {
        const p = JSON.parse(txt) as Partial<SkipLedger>;
        if (p && Array.isArray(p.agg) && Array.isArray(p.samples)) led = p as SkipLedger;
      }
    } catch { /* 首次：没有就空账本 */ }
    await $.fs.write(path, JSON.stringify(mergeSkip(led, e)));
  } catch { /* 账本写失败不影响主链路 */ }
}

// ---------------------------------------------------------------- byte utils

/** UTF-8 字节长（预算与单行截断都按字节，中文内容不再漏过上界）。 */
export function byteLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** token 估算：与宿主 `TokenUtils.estimateTokensRough` 逐字同公式（shared.cjs：
 *  `ceil(CJK/1.8) + ceil(其余字符/4)`）——报表/标记的口径与 wb 自身计数同源，不另立一套。
 *  纯展示用途，不参与任何压缩/透传决策（决策仍按字节，字节是保守上界）。 */
export function estTokens(s: string): number {
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fa5) cjk++;
  }
  return Math.ceil(cjk / 1.8) + Math.ceil((s.length - cjk) / 4);
}

/** 行数：只数换行，**不分配数组**（大文本上 split('\n') 会炸内存）。
 *  口径与 `raw.split('\n').length` 逐字一致（空串 = 1 行）。 */
export function countLines(s: string): number {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/** 形状描述里最大的字符串长度（判不出文本时至少能给个量级，不给正文）。
 *  口径：字符串取 len；数组取 totalLen 与首元素的较大者；对象取各字段的最大值。 */
export function maxStringLen(shape: Record<string, unknown>): number {
  if (shape.t === 'string') return typeof shape.len === 'number' ? shape.len : 0;
  if (shape.t === 'array') {
    const total = typeof shape.totalLen === 'number' ? shape.totalLen : 0;
    const first = shape.first ? maxStringLen(shape.first as Record<string, unknown>) : 0;
    return Math.max(total, first);
  }
  if (shape.t === 'object' && shape.keys && typeof shape.keys === 'object') {
    let m = 0;
    for (const k of Object.keys(shape.keys as object)) {
      m = Math.max(m, maxStringLen((shape.keys as Record<string, unknown>)[k]));
    }
    return m;
  }
  return 0;
}

/**
 * 内容体量的**廉价上界探测**（不分配大字符串）。
 *
 * 用途：某些分支在拿到文本之前就要决定「要不要为这次跳过记账」——
 * 比如 WB_OPS_FALLBACK=0 时未知工具整类不压，若先 extractText 再判断，
 * 数组形态会走 JSON.stringify(arr)（大数组上是几 MB 的分配，纯浪费）。
 * 这里只做遍历求和，不构造任何中间字符串。
 *
 * 口径：字符串取 UTF-8 字节；数组取各元素之和（对象元素递归）；对象取各字段之和；
 * 深度封顶 4 层（再深的内容对体量判断无意义）。
 */
export function roughBytes(v: unknown, depth = 0): number {
  if (typeof v === 'string') return byteLen(v);
  if (v === null || typeof v !== 'object') return 0;
  if (depth >= 4) return 0;
  if (Array.isArray(v)) {
    let n = 0;
    for (const x of v) n += roughBytes(x, depth + 1);
    return n;
  }
  const o = v as Record<string, unknown>;
  let n = 0;
  for (const k of Object.keys(o)) n += roughBytes(o[k], depth + 1);
  return n;
}

/** 人读体量：13.4KB（原来直接甩 13200B，看不出省没省）。 */
export function fmtBytes(n: number): string {
  return n >= 1048576 ? (n / 1048576).toFixed(2) + 'MB' : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B';
}
export function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

/** 标记行正文（头段之后那一行）：一行给出原文/压缩后的体量与 token 估算，模型与人都一眼看到省了多少。 */
function markerNote(head: string, rawBytes: number, beforeTok: number, afterTok: number, spillPath: string | null): string {
  const pct = beforeTok > 0 ? Math.round((Math.max(0, beforeTok - afterTok) / beforeTok) * 100) : 0;
  const keep = spillPath ? '落盘 ' + spillPath : '未落盘（原文过大或写入失败，可重跑命令）';
  return `${MARKER} ${head} · 原文 ${fmtBytes(rawBytes)}≈${fmtTok(beforeTok)} tok → ≈${fmtTok(afterTok)} tok（省 ${pct}%） · ${keep}`;
}

/** UTF-8 安全的字节前缀（代理对不被劈开）。 */
export function u8Prefix(s: string, maxBytes: number): string {
  let n = 0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    if (n + w > maxBytes) break;
    n += w; i += w === 4 ? 2 : 1;
  }
  return s.slice(0, i);
}

export function u8Suffix(s: string, maxBytes: number): string {
  let n = 0, i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    let w = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
      const h = s.charCodeAt(i - 2);
      if (h >= 0xd800 && h <= 0xdbff) w = 4;
    }
    if (n + w > maxBytes) break;
    n += w; i -= w === 4 ? 2 : 1;
  }
  return s.slice(i);
}

// ------------------------------------------------------------------ policy

function alreadyMarked(raw: string): boolean {
  if (raw.indexOf(MARKER) >= 0) return true;
  for (let i = 0; i < FOREIGN_MARKERS.length; i++) if (raw.indexOf(FOREIGN_MARKERS[i]) >= 0) return true;
  return false;
}

export function exitCodeOf(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /Exit Code:\s*(-?\d+)\s*$/i.exec(lines[i]);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** Grep/Glob 的 JSON 字符串数组识别；不是就返回 null 走通用压缩。 */
export function parseJsonList(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  if (t.length > 2_000_000) return null; // 解析成本封顶
  let arr: unknown;
  try { arr = JSON.parse(t); } catch { return null; }
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const out: string[] = [];
  for (const it of arr) {
    if (typeof it !== 'string') return null;
    out.push(it);
  }
  return out;
}

function truncLine(l: string): string {
  const b = byteLen(l);
  return b <= LINE_MAX_BYTES ? l : u8Prefix(l, LINE_MAX_BYTES) + `…[+${b - LINE_MAX_BYTES}B]`;
}

function contentOf(l: string): string {
  // Read 行号前缀会挡住 ^ 锚定的文档骨架匹配，先脱掉
  const m = READ_LINE_NO.exec(l);
  return m ? l.slice(m[0].length) : l;
}

function hitKey(line: string, skeleton: string): boolean {
  if (KEY.test(line)) return true;
  if (skeleton === 'symbol') return SYMBOLS.some((s) => line.includes(s));
  if (skeleton === 'heading' || skeleton === 'doc') return DOC_HEAD.test(contentOf(line));
  return false;
}

/**
 * 关键行字节配额裁剪：把选中行按「连续块」分组，锚点块（错误行及其堆栈帧）优先保留，
 * 放不下的普通块整块丢弃（保持块内连续——半块堆栈帧没有意义）。
 * 目的：关键行独占预算会把尾部挤出预算，触发硬截断丢掉 Exit Code 行。
 */
function trimKeyToBudget(idx: number[], anchorSet: Set<number>, cap: number, cost: (i: number) => number): number[] {
  if (!idx.length) return idx;
  const bytes = (arr: number[]) => arr.reduce((s, i) => s + cost(i), 0);
  if (bytes(idx) <= cap) return idx;
  const blocks: number[][] = [];
  for (const i of idx) {
    const last = blocks[blocks.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else blocks.push([i]);
  }
  const ordered = blocks
    .map((b, k) => ({ b, k, p: b.some((i) => anchorSet.has(i)) ? 0 : 1 }))
    .sort((x, y) => x.p - y.p || x.k - y.k);
  const kept: number[][] = [];
  let used = 0;
  for (const { b } of ordered) {
    const c = bytes(b);
    if (used + c > cap && kept.length) continue;  // 整块丢弃，不切半块
    kept.push(b); used += c;
  }
  return kept.flat().sort((a, b) => a - b);
}

/**
 * 纯函数压缩核心。返回 null = 放弃（调用方透传原文）。
 * opts.mode：shell（退出码门）| read（行数门槛+硬阀+空洞指路）| doc（标题/链接行命中）。
 *
 * v0.18 P0：可选的 `trace` 出参——放弃压缩时把**原因**自报出来。
 * 此前所有 `return null` 都是匿名的，调用方只知道"没压"，不知道"为什么没压"，
 * 于是「超预算却没被压缩」只能靠翻全量 transcript 反查（v0.17 归因 235+20 条的代价）。
 * 现在原因直接落在账本里，一条记录即可归因，不必翻 transcript。
 */
export function compress(
  raw: string, budget: number, deadlineMs: number, spillPath: string | null,
  opts?: { mode?: string; minLines?: number; hardBytes?: number; skeleton?: string },
  trace?: { reason?: SkipReason; lines?: number },
): Compression | null {
  const mode = opts?.mode ?? 'shell';
  const bytes = byteLen(raw);
  if (bytes <= budget) { if (trace) { trace.reason = 'under-budget'; trace.lines = countLines(raw); } return null; }
  if (alreadyMarked(raw)) { if (trace) { trace.reason = 'already-marked'; trace.lines = countLines(raw); } return null; }
  const start = Date.now();
  const lines = raw.split('\n');
  const total = lines.length;

  // Read 分档行数门。硬阀例外只给「行数少体量巨大的 dump」；
  // 几百行的整篇文档不算 dump——误伤整篇文档比漏压贵。
  if (opts?.minLines && total < opts.minLines && !(opts.hardBytes && bytes >= opts.hardBytes && total <= 60)) {
    if (trace) { trace.reason = 'lines-gate'; trace.lines = total; }
    return null;
  }

  if (mode === 'shell') {
    const code = exitCodeOf(lines);
    if (code !== null && code !== 0) { if (trace) { trace.reason = 'exit-code'; trace.lines = total; } return null; } // 错误现场：完整透传
  }

  // ---- 少行巨字节：字节级首尾截（Grep content 单行 JSON、minified、dump；v0.2 缺的正好是这条）----
  if (total <= 20) {
    const head = u8Prefix(raw, Math.floor(budget * 0.6));
    const tail = u8Suffix(raw, Math.floor(budget * 0.28));
    const note = `${MARKER} 少行巨字节(${bytes}B/${total}行) · 保留首${byteLen(head)}B+尾${byteLen(tail)}B → ${spillPath ? '落盘 ' + spillPath : '未落盘（原文过大或写入失败，可重跑命令）'}`;
    const text = `${head}\n${note}\n${tail}`;
    return { text: byteLen(text) > budget + MARKER_RESERVE ? u8Prefix(text, budget + MARKER_RESERVE) + `\n${MARKER} …截断` : text, dropped: bytes };
  }

  // ---- 自适应头尾：按平均行长估行数（固定行数对短行/长行两头都亏）----
  const avg = Math.max(8, bytes / total);
  const headMin = mode === 'read' ? READ_HEAD_MIN : HEAD_MIN;
  const headMax = mode === 'read' ? READ_HEAD_MAX : HEAD_MAX;
  const tailMin = mode === 'read' ? READ_TAIL_MIN : TAIL_MIN;
  const tailMax = mode === 'read' ? READ_TAIL_MAX : TAIL_MAX;
  const sideMax = Math.max(1, Math.floor((total - 6) / 2));
  let headN = Math.min(Math.max(Math.round(budget * 0.3 / avg), headMin), headMax, sideMax);
  let tailN = Math.min(Math.max(Math.round(budget * 0.22 / avg), tailMin), tailMax, sideMax);

  // 中段关键行池（deadline 每 512 行一查）
  const skeleton = opts?.skeleton ?? 'keyword';
  const pool: number[] = [];
  const anchors: number[] = [];   // 锚点扩行：严重错误行之后的连续上下文（堆栈帧）
  const anchorSet = new Set<number>();
  let anchorLeft = ANCHOR_MAX;
  for (let i = 0; i < total; i++) {
    if ((i & 511) === 0 && Date.now() - start >= deadlineMs) {
      if (trace) { trace.reason = 'deadline'; trace.lines = total; }
      return null;
    }
    const l = lines[i];
    if (l.length > 0 && hitKey(l, skeleton)) {
      pool.push(i);
      // 锚点扩行：错误行本身命中了，但它的上下文行（如 `    at Worker.run (…)` 堆栈帧）
      // 不含关键词——排查失败时缺了它们等于缺了半张现场。严重错误行后顺带保留若干行。
      if (anchorLeft > 0 && SEVERE.test(l)) {
        for (let k = 1; k <= ANCHOR_AFTER && i + k < total && anchorLeft > 0; k++) {
          anchors.push(i + k); anchorSet.add(i + k); anchorLeft--;
        }
      }
      if (pool.length >= KEY_POOL_MAX) break; // 命中爆炸：用已有池，不再扫
    }
  }
  if (anchors.length) {
    // 合并去重并按行号排序（锚点可能与后续命中重叠或乱序）
    const merged = Array.from(new Set(pool.concat(anchors))).sort((a, b) => a - b);
    pool.length = 0; pool.push(...merged);
  }

  const cost = (i: number) => Math.min(byteLen(lines[i]), LINE_MAX_BYTES) + 1;

  let headKeep = headN, tailKeep = tailN, keyIdx: number[] = [];
  for (let round = 0; ; round++) {
    // 头段按字节裁（超长行挤占预算时少留几行），尾部从后往前，同理
    headKeep = 0;
    let used = 0;
    for (let i = 0; i < headN; i++) { used += cost(i); if (used > budget * 0.34) break; headKeep = i + 1; }
    tailKeep = 0; used = 0;
    for (let j = 0; j < tailN; j++) { const i = total - 1 - j; used += cost(i); if (used > budget * 0.24) break; tailKeep = j + 1; }
    // 保底：头尾至少各 1 行（首行 Command:/标题、尾行 Exit Code: 信息量最高）。
    // truncLine 封顶单行 1000B + MARKER_RESERVE 1200，兜得住保底超支。
    if (headN > 0 && headKeep === 0) headKeep = 1;
    if (tailN > 0 && tailKeep === 0) tailKeep = 1;
    const mid: number[] = [];
    for (const i of pool) if (i >= headKeep && i < total - tailKeep) mid.push(i);
    if (mid.length > KEY_MAX_LINES) {
      // 按「连续块」抽样而不是逐行撒点：锚点扩行产生的连续帧（堆栈/调用链）被均匀
      // 撒点打散后，每帧单独一行就失去意义——块要整块留，块内再均匀采样。
      const blocks: number[][] = [];
      for (const i of mid) {
        const last = blocks[blocks.length - 1];
        if (last && last[last.length - 1] === i - 1) last.push(i);
        else blocks.push([i]);
      }
      const bStep = Math.max(1, Math.ceil(blocks.length / KEY_MAX_LINES));
      const nSel = Math.ceil(blocks.length / bStep);
      const perBlock = Math.max(1, Math.floor(KEY_MAX_LINES / nSel));
      const sel: number[] = [];
      for (let b = 0; b < blocks.length && sel.length < KEY_MAX_LINES; b += bStep) {
        const bl = blocks[b];
        if (bl.length <= perBlock) sel.push(...bl);
        else {
          const step = bl.length / perBlock;          // 块内均匀采样（连续块过长时）
          for (let k = 0; k < perBlock; k++) sel.push(bl[Math.floor(k * step)]);
        }
      }
      keyIdx = sel;
    } else keyIdx = mid;
    if (mode === 'shell') {
      // Exit Code 行保底：命令失败现场已透传，能走到这说明它是 0——但这行必须可见，
      // 否则模型无从判断成败。在最近 50 行内找到它，强行纳入尾段。
      for (let i = 0; i < Math.min(50, total - headKeep); i++) {
        if (/Exit Code:/i.test(lines[total - 1 - i])) { tailKeep = Math.max(tailKeep, i + 1); break; }
      }
      keyIdx = keyIdx.filter((i) => i >= headKeep && i < total - tailKeep); // 尾段扩张后去重
    }
    // 关键行字节配额：锚点扩行后关键行可能独占预算，把尾部挤出预算 → 尾部硬截断会丢掉
    // Exit Code 行（模型就不知道成没成）。配额内优先保锚点块，其余整块丢弃。
    keyIdx = trimKeyToBudget(keyIdx, anchorSet, budget * KEY_BYTE_SHARE, cost);
    let u = 0;
    for (let i = 0; i < headKeep; i++) u += cost(i);
    for (let i = total - tailKeep; i < total; i++) u += cost(i);
    for (const i of keyIdx) u += cost(i);
    if (u >= budget * FILL_TARGET || round >= GROW_ROUNDS || (headN >= headMax && tailN >= tailMax)) break;
    headN = Math.min(Math.floor(headN * 1.25) + 1, headMax, sideMax);
    tailN = Math.min(Math.floor(tailN * 1.25) + 1, tailMax, sideMax);
  }

  // 空洞指路：只认最长连续段，≥20 行才指；仅 Read（有行号可指）
  let hint = '';
  if (mode === 'read') {
    const keep = new Set<number>(keyIdx);
    let bestStart = -1, bestLen = 0, i = headKeep;
    const midEnd = total - tailKeep;
    while (i < midEnd) {
      if (keep.has(i)) { i++; continue; }
      let j = i;
      while (j < midEnd && !keep.has(j)) j++;
      if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
      i = j;
    }
    if (bestStart >= 0 && bestLen >= GAP_HINT_MIN_LINES) {
      const m = READ_LINE_NO.exec(lines[bestStart]);
      if (m) hint = ` · 回看: Read offset=${m[1]} limit=${Math.min(bestLen, GAP_HINT_MAX_LIMIT)}`;
    }
  }

  const dropped = Math.max(0, total - headKeep - tailKeep - keyIdx.length);
  const parts: string[] = [];
  for (let i = 0; i < headKeep; i++) parts.push(truncLine(lines[i]));
  const noteAt = parts.length;               // 占位：标记要写「压缩后 tok」，先拼正文再回填
  parts.push('');                            // 空串只差一个换行，≈ 值不受影响
  if (keyIdx.length) {
    parts.push(`--- 命中关键行 (${keyIdx.length}) ---`);
    for (const i of keyIdx) parts.push(truncLine(lines[i]));
  }
  parts.push('--- 尾部 ---');
  for (let i = total - tailKeep; i < total; i++) parts.push(truncLine(lines[i]));

  // 先拼正文 → 量压缩后体量 → 回填标记（标记自身约 20 tok 不计，≈ 口径：省量宁少勿多）
  parts[noteAt] = markerNote(`已省略 ${dropped} 行`, bytes, estTokens(raw), estTokens(parts.join('\n')), spillPath) + hint;
  let text = parts.join('\n');
  if (byteLen(text) > budget + MARKER_RESERVE) text = u8Prefix(text, budget + MARKER_RESERVE) + `\n${MARKER} …截断`;
  return { text, dropped };
}

/** 字符串数组的裁剪内核：保留前 K 条（按字节预算）+ 一条**单行**说明（列表尾部条目不比头部更值钱，不硬凑尾段）。 */
export function trimList(items: string[], budget: number, spillPath: string | null, rawBytes: number): { kept: string[]; note: string; dropped: number } {
  const cap = Math.floor(budget * 0.7);
  let used = 0, k = 0;
  for (const it of items) {
    const c = Math.min(byteLen(it), LINE_MAX_BYTES) + 1;
    if (used + c > cap && k >= 1) break;
    used += c; k++;
  }
  const kept = items.slice(0, k).map(truncLine);
  // 标记自身约 20 tok 不计入 afterTok（≈ 口径：省量宁少勿多）
  const beforeTok = items.reduce((a, it) => a + estTokens(it), 0);
  const afterTok = kept.reduce((a, it) => a + estTokens(it), 0);
  const note = markerNote(`共 ${items.length} 条，已省略 ${items.length - k} 条`, rawBytes, beforeTok, afterTok, spillPath);
  return { kept, note, dropped: items.length - k };
}

/** Grep/Glob 的 JSON 数组模式：前 K 条 + 计数 + 落盘（文本形态：结果本身是一段 JSON 文本时走这里）。 */
export function compressList(items: string[], budget: number, spillPath: string | null, rawBytes: number): Compression {
  const { kept, note, dropped } = trimList(items, budget, spillPath, rawBytes);
  return { text: kept.join('\n') + '\n' + note, dropped };
}

/** 工具名（诊断用）：宿主事件里的工具名字段名未文档化，多候选取第一个。 */
export function toolNameOf(e: any): string {
  for (const k of ['tool', 'toolName', 'name', 'tool_name']) {
    const v = e?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '?';
}

// ------------------------------------------------------------------ config

async function readCfg($: any): Promise<Cfg> {
  const g = async (k: string): Promise<string> => {
    try { return String((await $.env.get(k)) ?? ''); } catch { return ''; }
  };
  const off = /^(0|off|false|no)$/i.test((await g('WB_OPS')).trim());
  const budget = parseInt(await g('WB_OPS_BUDGET'), 10);
  const deadline = parseInt(await g('WB_OPS_DEADLINE_MS'), 10);
  const home = (await g('USERPROFILE')) || (await g('HOME')) || '';
  const gpct = parseFloat(await g('WB_OPS_GUARD_PCT'));
  return {
    enabled: !off,
    budget: budget > 512 ? budget : DEFAULT_BUDGET,
    deadlineMs: deadline >= 0 ? deadline : DEFAULT_DEADLINE_MS,
    home,
    // v0.13：默认开——"看到省了多少"不该先要用户配环境变量；WB_OPS_STATS=0/off/false/no 可关。
    stats: !/^(0|off|false|no)$/i.test((await g('WB_OPS_STATS')).trim()),
    hints: !/^(0|off|false|no)$/i.test((await g('WB_OPS_HINTS')).trim()),
    guard: !/^(0|off|false|no)$/i.test((await g('WB_OPS_GUARD')).trim()),
    guardPct: gpct > 0 && gpct < 100 ? gpct : DEFAULT_GUARD_PCT,
    // v0.12：宿主 mods 的 $.session.usage() 恒 0（快照没接上），guard 的 fallback 数据源 =
    // transcript 尾部采样。整链路 fail-open，WB_OPS_GUARD_FS=0 可单独关掉；WB_OPS_PROJECTS
    // 可覆盖 projects 目录（CLI 自定义 CODEBUDDY_CONFIG_DIR 时 HOME 推导会错）。
    guardFs: !/^(0|off|false|no)$/i.test((await g('WB_OPS_GUARD_FS')).trim()),
    projects: (await g('WB_OPS_PROJECTS')).trim(),
    fallback: !/^(0|off|false|no)$/i.test((await g('WB_OPS_FALLBACK')).trim()),
  };
}

let seq = 0;

async function getSid8($: any): Promise<string> {
  try { return String(await $.session.id()).slice(0, 8); } catch { return 'nosid'; }
}

/** transcript 文件名用完整 session id（不是 sid8）；拿不到就 'nosid'，调用方据此跳过采样。 */
async function getFullSid($: any): Promise<string> {
  try { return String(await $.session.id()); } catch { return 'nosid'; }
}

/** projects 目录 slug 依赖 cwd：宿主既暴露 $.session.cwd()，也可能只有 PWD（CLI 自定义配置时）。 */
async function getCwd($: any): Promise<string> {
  try {
    if (typeof $.session?.cwd === 'function') {
      const v = await $.session.cwd();
      if (typeof v === 'string' && v) return v;
    }
  } catch { /* 落到 PWD */ }
  try { const v = await $.env.get('PWD'); return typeof v === 'string' ? v : ''; } catch { return ''; }
}

async function spillRaw($: any, e: any, text: string, home: string, sid: string, ext: string): Promise<string | null> {
  if (!home || text.length > MAX_SPILL_CHARS) return null;
  try {
    const call = String(e?.callId ?? e?.call_id ?? Date.now()).replace(/[^\w.-]/g, '_').slice(0, 40);
    const name = `${(++seq) % 10000}-${call}${ext}`;
    const path = `${home.replace(/\\/g, '/')}/.workbuddy/wb-ops/spill/${sid}/${name}`;
    await $.fs.write(path, text);
    return path;
  } catch {
    return null; // 落盘失败：仍压缩，但标记如实说明原文未保留
  }
}

/** 记账（WB_OPS_STATS 开，v0.13 起默认开）：每会话一个小 JSON 计数器，整读整写小文件，不做无界追写。
 *  字节是老口径，tok* 是 v0.13 新增的 token 口径（与宿主同公式估算）。
 *  任何失败静默——纯观测件，绝不反噬主流程。 */
async function recordStats($: any, home: string, sid: string, tool: string, before: number, after: number, beforeTok: number, afterTok: number): Promise<void> {
  try {
    const path = `${home.replace(/\\/g, '/')}/.workbuddy/wb-ops/stats/${sid}.json`;
    let cur: Record<string, any> = { calls: 0, before: 0, after: 0, kinds: {} };
    try {
      const v = await $.fs.read(path);
      const txt = typeof v === 'string' ? v : v && typeof (v as { text?: unknown }).text === 'string' ? (v as { text: string }).text : '';
      if (txt) cur = { ...cur, ...(JSON.parse(txt) as Record<string, any>) };
    } catch { /* 首次 */ }
    // v0.16 模型维度：宿主 bundle 有 session.model 事件（i.model?.()，拿不到会 deny 抛错）。
    // 任何异常/缺失一律记 'unknown'——纯观测件，绝不反噬主流程。
    let model = 'unknown';
    try {
      const m = await ($.session && typeof $.session.model === 'function' ? $.session.model() : null);
      if (typeof m === 'string' && m.trim()) model = m.trim().slice(0, 64);
    } catch { /* deny/不支持 → unknown */ }
    cur.calls = (cur.calls || 0) + 1;
    cur.before = (cur.before || 0) + before;
    cur.after = (cur.after || 0) + after;
    cur.tokBefore = (cur.tokBefore || 0) + beforeTok;
    cur.tokAfter = (cur.tokAfter || 0) + afterTok;
    cur.kinds = cur.kinds || {}; // ① 按类细分（老文件无此字段自动补上）
    const kk = cur.kinds[tool] = cur.kinds[tool] || { calls: 0, before: 0, after: 0, tokBefore: 0, tokAfter: 0 };
    kk.calls++; kk.before += before; kk.after += after;
    kk.tokBefore = (kk.tokBefore || 0) + beforeTok; kk.tokAfter = (kk.tokAfter || 0) + afterTok;
    // ② v0.16 按模型累计（全史）——首页「按模型」汇总用这个，不受事件封顶影响
    cur.models = cur.models || {};
    const mm = cur.models[model] = cur.models[model] || { calls: 0, before: 0, after: 0, tokBefore: 0, tokAfter: 0 };
    mm.calls++; mm.before += before; mm.after += after;
    mm.tokBefore += beforeTok; mm.tokAfter += afterTok;
    // ③ v0.16 每压缩事件流（详情页时间轴图用）。
    // ponytail: 封顶 300 条保热路径整读整写 ~30KB 量级；升级路径 = append-only JSONL + 尾读。
    cur.events = Array.isArray(cur.events) ? cur.events : [];
    cur.events.push({ t: Date.now(), k: tool, m: model, tb: beforeTok, ta: afterTok });
    if (cur.events.length > 300) cur.events = cur.events.slice(-300);
    await $.fs.write(path, JSON.stringify({ ...cur, tool, ts: new Date().toISOString() }));
  } catch { /* 记账失败不影响主流程 */ }
}

// 报表渲染（#3）v0.14 起移出本文件：见 lib/report-core.mjs。
// 原因见 register() 顶部「报表工具」注释——工具注册不再由 mod 承担，渲染也就没有理由
// 在 mod 沙箱里留第二份实现（两份实现必然漂口径）。本文件只负责**产生**记账数据。

// ---------------------------------------------------------------- guard (#4/#5)

let lastUsageSig: string | null = null;   // usage 形状签名：变了才落盘（每轮写盘违反热路径纪律）
let lastFsSig: string | null = null;      // transcript 读权限探测签名（成功/失败原因变了才落盘）

/**
 * usage 探测：拿真实返回形状（只记结构，不记内容），同时把原值交回水位守卫。
 * v0.12 宿主契约已实锤（shared.cjs）：`createModsUsageBinding` 返回
 *   {context:{tokens,window,percent}, rateLimits:[]}
 *   - window = resolveSessionContextBudget(...) —— **真算的，可信**
 *   - tokens = getCurrentContextUsage(session)?.totalInputTokens ?? 0
 *     → mods 持有的 session 上 getLatestUsageSnapshot 缺失 ⇒ 恒 0（宿主绑定层缺口，可报 issue）
 * 数据本身没丢：宿主 ACP 的 usage_update 用 getLatestUsage()?.inputTokens，transcript JSONL
 * 每条模型响应也带 providerData.usage.inputTokens（单调增长）。故 v0.12 加 transcript fallback。
 */
export async function probeUsage($: any): Promise<{ value?: unknown; shape?: Record<string, unknown>; err?: string; deny?: string }> {
  try {
    const sess: any = $.session;
    if (!sess || typeof sess.usage !== 'function') return { err: '$.session.usage is not a function' };
    const value = await sess.usage();
    const deny = value && typeof value === 'object' ? (value as Record<string, unknown>).deny : undefined;
    return { value, shape: describeShape(value), deny: typeof deny === 'string' ? deny : undefined };
  } catch (e) {
    return { err: String(e) };
  }
}

// $.session.usage() 的宿主形状未文档化：bundle 里同时存在 {used,size}、{inputTokens,contextWindow}
// 与 v0.12 实测的嵌套 {context:{tokens,window,percent}} 三套构造 → 多字段候选。
// tokens===0 视为「无数据」（真实会话上下文不可能为 0；宿主当前正卡在这个缺口上），
// 判不出即返回 null，守卫静默（无阻塞、无扫描、可整体关闭）。
export function pickWatermark(u: unknown): { used: number; size: number } | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const num = (k: string): number | undefined =>
    typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined;
  const c = o.context && typeof o.context === 'object' ? o.context as Record<string, unknown> : null;
  const cn = (k: string): number | undefined =>
    c && typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : undefined;
  const used = num('used') ?? num('inputTokens') ?? num('promptTokens') ?? num('totalTokens') ?? cn('tokens');
  const size = num('size') ?? num('contextWindow') ?? num('maxInputTokens') ?? cn('window');
  if (used === undefined || size === undefined || size <= 0 || used <= 0) return null;
  return { used, size };
}

/** 只取窗口大小：宿主 binding 的 context.window 是真算的（本会话 300000），即使 tokens 恒 0 也可信。 */
export function pickWindow(u: unknown): number {
  if (!u || typeof u !== 'object') return 0;
  const o = u as Record<string, unknown>;
  const c = o.context && typeof o.context === 'object' ? o.context as Record<string, unknown> : null;
  const vals: unknown[] = [o.size, o.contextWindow, o.maxInputTokens, c?.window, c?.size, c?.contextWindow];
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return 0;
}

/** cwd → 宿主 projects 目录 slug（实测 C:/Users/dev/work/wb-ops → c-Users-dev-work-wb-ops）。 */
export function projectSlug(cwd: string): string {
  let p = (cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const posix = /^\/([A-Za-z])\//.exec(p);      // Git Bash 的 /c/Users/... 也认
  if (posix) p = posix[1].toLowerCase() + ':/' + p.slice(3);
  return p.replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase()).replace(/\//g, '-');
}

/**
 * JSONL 尾部逆扫最后一条模型响应的 inputTokens（已含 cache_read，不要再叠加），最多回看 40 行。
 * from 允许只传文件尾部的一段（超大文件的降级路径）：靠前的行被丢弃不影响结论。
 */
export function lastInputTokens(txt: string, from = 0): number | undefined {
  const SCAN_LINES = 40, LINE_CAP = 2_000_000;
  let end = txt.length;
  while (end > 0 && (txt[end - 1] === '\n' || txt[end - 1] === '\r')) end--;
  for (let seen = 0; end > from && seen < SCAN_LINES; seen++) {
    let start = txt.lastIndexOf('\n', end - 1);
    start = start < 0 ? 0 : start + 1;
    if (start < from) start = from;                 // 越过分段起点
    const line = txt.slice(start, end);
    end = start > 0 ? start - 1 : 0;
    if (!line) continue;
    if (line.length > LINE_CAP) continue;
    if (line.indexOf('inputTokens') < 0 && line.indexOf('input_tokens') < 0) continue;
    try {
      const o = JSON.parse(line) as Record<string, any>;
      const vals = [o?.providerData?.usage?.inputTokens, o?.message?.usage?.input_tokens, o?.usage?.inputTokens];
      for (const v of vals) if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    } catch { /* 坏行/噪音行跳过 */ }
  }
  return undefined;
}

export interface TxProbe { used?: number; bytes?: number; path?: string; err?: string; truncated?: boolean; }
let txPathCache: { sid: string; base: string; path: string } | null = null;   // 命中后下轮直读，不再列目录

/**
 * v0.12 沙箱读权限探测 + fallback 水位源：读 <projects>/<slug>/<sid>.jsonl 的最后一条 usage。
 * 只发生在 prompt.submit（每轮用户提交一次），不是 tool.call 热路径；任何失败都返回 err 而不抛。
 * 路径推导失败时列一次目录找 <sid>.jsonl（兼容宿主改 slug 规则 / 自定义 projects 目录）。
 * 绝不把正文写进 debug：只回传 used/bytes/path/err。
 *
 * v0.12.1 超大文件降级：宿主 transcript 只增不减，长会话实测可达 20MB+（见 MEMORY）。
 * 旧实现对 >8MB 直接判 err → 长会话 fallback 永久失效（usage 恰好在 compact 后短暂归零时）。
 * 现改为：仍读全文（实测 22MB 约 115ms，可接受），但只解析尾部若干行；
 * 且用 fs.stat 预判体积，超限时在 debug 里标 truncated —— 不再因为体积而整条链路失守。
 */
export async function probeTranscript($: any, home: string, sid: string, cwd: string, projectsDir?: string): Promise<TxProbe> {
  if (!home) return { err: 'no home' };
  if (!sid || sid === 'nosid') return { err: 'no sid' };
  const base = (projectsDir || `${home.replace(/\\/g, '/')}/.workbuddy/projects`).replace(/\\/g, '/').replace(/\/+$/, '');
  let lastErr = '';
  const readOne = async (p: string): Promise<TxProbe | null> => {
    try {
      // 先 stat 拿体积：超限时在 debug 里留痕（fs.stat 失败不影响后续 read）
      let size = 0;
      try {
        const st = await $.fs.stat(p);
        if (st && typeof st.size === 'number' && st.size > 0) size = st.size;
      } catch { /* stat 不可用则按未知处理 */ }
      const v = await $.fs.read(p);
      const txt = typeof v === 'string' ? v : v && typeof (v as { text?: unknown }).text === 'string' ? (v as { text: string }).text : '';
      if (!txt) return null;
      const truncated = size > MAX_INPUT_BYTES || txt.length > MAX_INPUT_BYTES;
      // 尾部采样：只解析末尾若干行；被截断文件的首行可能是半行，丢弃不影响结论
      const from = truncated ? Math.max(0, txt.length - TX_TAIL_CHARS) : 0;
      const used = lastInputTokens(txt, from);
      if (truncated && used === undefined) {
        // 尾部没抓到（罕见：尾部全是工具调用行）→ 再放宽到整文件尾部大窗口
        return { err: 'transcript tail has no usage', bytes: size || txt.length, path: p, truncated: true };
      }
      return { used, bytes: size || txt.length, path: p, truncated };
    } catch (e) { lastErr = String(e); return null; }
  };
  const slug = projectSlug(cwd);
  const wants: string[] = [];
  if (txPathCache?.sid === sid && txPathCache.base === base) wants.push(txPathCache.path);
  if (slug) wants.push(`${base}/${slug}/${sid}.jsonl`);
  for (const p of wants) {
    const got = await readOne(p);
    if (got) { if (got.used) txPathCache = { sid, base, path: got.path! }; return got; }
  }
  // slug 猜不中才列目录；读到第 3 个目录仍失败就停（多半是 fs 权限，别把目录扫穿）
  try {
    const ents: unknown = await $.fs.list(base);
    const arr = Array.isArray(ents) ? ents : [];
    let tried = 0, fails = 0;
    for (const en of arr) {
      const name = typeof en === 'string' ? en : en && typeof (en as { name?: unknown }).name === 'string' ? (en as { name: string }).name : '';
      if (!name || tried >= 40) break;
      tried++;
      const got = await readOne(`${base}/${name}/${sid}.jsonl`);
      if (got) { if (got.used) txPathCache = { sid, base, path: got.path! }; return got; }
      if (++fails >= 3) break;             // 连续 3 个读不到：多半是 fs 权限，别扫穿目录
    }
  } catch (e) { lastErr = lastErr || String(e); }
  return { err: lastErr || 'transcript not found' };
}

/** ② 水位数值行：模型可 Read 的纯文本余量。 */
export function watermarkLine(w: { used: number; size: number }, source = 'usage'): string {
  const pct = ((w.used / w.size) * 100).toFixed(1);
  return `${w.size - w.used}\n已用 ${w.used}/${w.size} tok（${pct}%）· ${new Date().toISOString()}${source !== 'usage' ? ' · 来源 ' + source : ''}`;
}

export function guardNote(w: { used: number; size: number }, pct: number, wmPath?: string): string | null {
  const p = (w.used / w.size) * 100;
  if (p < pct) return null;
  return `[wb-ops 水位] 上下文约 ${p.toFixed(0)}%（${w.used}/${w.size} tok）。接近上限时宿主将有损压缩；建议本轮起：大输出命令自带 head/过滤、探索合并成批、避免整读大文件。wb-ops 已把每次越线输出压回预算内。${wmPath ? ` 余量速查：Read ${wmPath}` : ''}`;
}

export const COMPACT_RETENTION = '[wb-ops] 压缩保留优先级：错误/警告行原文、文件路径+行号、[wb-ops] 标记及其落盘路径、最近 3 条用户指令原文；其余可安全摘要。';

// ------------------------------------------------------------------ entry

/**
 * 从 tool.call 事件里取工具入参里的文件路径。
 *
 * 宿主形状已真机实锤（v0.17，见 docs/VERIFICATION.md §8）：
 * 事件里工具入参对象恒在 `e.input` 上且是**普通对象**（不是 JSON 字符串）——
 * 静态侧宿主 bundle 的 `dispatchModsToolCall` 只把
 * `tool / tool_use_id / agentId / consent` 四个键抽走（folded envelope），
 * `input` 不在其中；真机侧全量 transcript 反查「判不出路径 = 0 条」。
 * 因此 `tool_input` / `arguments` 两个候选键是**冗余但无害**的兜底，保留以防宿主改形状。
 *
 * 判据键 `file_path / path / filePath` 覆盖真实 transcript 里的全部路径字段名：
 * Read/Edit/Write = `file_path`，Grep/Glob = `path`（目录，语义不同，本就不喂 classifyRead）。
 */
export function toolPathOf(e: any): string | null {
  const inp = e?.input ?? e?.tool_input ?? e?.arguments;
  if (!inp || typeof inp !== 'object') return null;
  for (const k of ['file_path', 'path', 'filePath']) {
    const v = (inp as Record<string, unknown>)[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function makeHandler(kind: string) {
  let cfgP: Promise<Cfg> | null = null;
  return async ($: any, e: any, next: any) => {
    const r = await next(e);                 // 工具照常执行一次
    try {
      if (!r || typeof r !== 'object' || r.isError) return r;
      if (!cfgP) cfgP = readCfg($);
      const cfg = await cfgP;
      if (!cfg.enabled) return r;

      const tool = toolNameOf(e);
      // v0.18 P0：跳过账本出口。**只记元数据，绝不记正文**。
      // 每条「超预算却没被压缩」的路径都经它留痕——归因从此读一条账本，不必翻 transcript。
      const noteSkip = async (reason: SkipReason, info?: { bytes?: number | null; lines?: number | null; chars?: number; path?: string }) => {
        if (!cfg.home) return;
        try {
          const sidDbg = await getSid8($);
          await writeSkipLedger($, cfg.home, sidDbg, {
            t: new Date().toISOString(),
            kind, tool, reason,
            bytes: info?.bytes ?? null,
            lines: info?.lines ?? null,
            chars: info?.chars,
            path: info?.path,
          });
        } catch { /* 账本失败不影响主链路 */ }
      };

      if (kind === 'other' && !cfg.fallback) {
        // ③ 兜底单独开关：WB_OPS_FALLBACK=0 → 未知工具一律不压（有意为之，但需可归因）。
        // 只在**确实超预算**时记账：预算内的未知工具本就没打算压，记它是噪音。
        const rb = roughBytes(r.result);
        if (rb > cfg.budget) await noteSkip('fallback-off', { bytes: rb, lines: null });
        return r;
      }
      const t = extractText(r.result);
      if (!t) {
        // 判不出文本形状 → 记一条**结构**诊断（只写键名/类型/长度，不写正文）。
        // 用途：宿主改形状时能立刻定位，不用再去 180MB bundle 里捞。频率天然低（只在这里写盘）。
        const shape = describeShape(r.result);
        if (hasLongString(shape, cfg.budget)) {
          const sidDbg = await getSid8($);
          await writeDebug($, cfg.home, sidDbg, 'shape', { kind, tool: toolNameOf(e), shape });
          // 形状判不出 → 走不到任何分档逻辑：**疑似缺口**，必须可归因。
          // 字节数给不出精确值（判不出正文），用 roughBytes 求上界量级。
          await noteSkip('shape-unknown', { bytes: null, lines: null, chars: roughBytes(r.result) });
        }
        return r;
      }
      const len = t.raw.length;

      // shell 类（含 ③ 兜底的未知工具——MCP bash 包装同样遵守 Exit Code 尾标）：非零 → 现场完整透传。
      // 特意放在预算/大小早退之前：失败输出多半不大，而"盲目重跑一整轮"恰恰发生在这些小现场上。
      if (kind === 'shell' || kind === 'other') {
        const codes = t.raw.slice(-2000).match(/Exit Code:\s*(-?\d+)/gi);
        if (codes && codes.length) {
          const last = parseInt(codes[codes.length - 1].replace(/.*?:\s*/, ''), 10);
          if (Number.isFinite(last) && last !== 0) {
            // 非零退出码：错误现场完整透传（有意为之）。
            // 只在**确实超预算**时记账——预算内的失败输出本就不该压，记它是噪音。
            // 归因价值在于「超预算却因失败现场而透传」这一类，不在于失败本身。
            if (len * 3 >= cfg.budget) {
              const eb = byteLen(t.raw);
              if (eb > cfg.budget) await noteSkip('exit-code', { bytes: eb, lines: countLines(t.raw) });
            }
            if (kind !== 'shell' || !cfg.hints || len > MAX_INPUT_BYTES || alreadyMarked(t.raw)) return r;
            const h = hintFor(t.raw);
            return h ? { ...r, result: t.sink.put(t.raw + '\n' + HINT_PREFIX + h) } : r;
          }
        }
      }

      if (len > MAX_INPUT_BYTES) { await noteSkip('too-large', { bytes: null, lines: null, chars: len }); return r; } // 字节数 ≥ 字符数：字符都超限则字节必超，免全量扫描
      if (len * 3 < cfg.budget) return r;         // 每字符顶格 3 字节也进不了预算：免测
      const bytes = byteLen(t.raw);               // 预算是字节语义；字符数会放过「字符≤预算<字节」的中文串
      if (bytes <= cfg.budget) return r;           // 预算内：正常透传，不是「漏压」，不记账
      if (bytes > MAX_INPUT_BYTES) { await noteSkip('too-large', { bytes, lines: countLines(t.raw) }); return r; }
      if (alreadyMarked(t.raw)) { await noteSkip('already-marked', { bytes, lines: countLines(t.raw) }); return r; } // 双压缩防护（含同类工具标记）

      let gate: ReadGate | null = null;
      if (kind === 'read') {
        if (t.raw.startsWith('<persisted-output>')) {
          // 宿主已落盘+指路，二次压缩纯属捣乱（有意为之）
          await noteSkip('host-persisted', { bytes, lines: countLines(t.raw) });
          return r;
        }
        const path = toolPathOf(e);
        if (!path) {
          // 判不了文件类型：保守透传（源码被误伤比漏压贵）。**这是疑似缺口**，必须可归因。
          await noteSkip('no-path', { bytes, lines: countLines(t.raw) });
          return r;
        }
        gate = classifyRead(path);
      }

      const sid = await getSid8($);

      if (kind === 'jsonlist') {
        // 两条来源：① 原生数组（宿主 Grep/Glob：content 是 string[]）② 文本形态（结果本身是一段 JSON 文本）
        const listItems = t.items ?? parseJsonList(t.raw);
        if (listItems) {
          const path = await spillRaw($, e, t.raw, cfg.home, sid, '.json');
          if (t.isArray) {
            // 原生数组：裁条目 + 追加一条单行说明，**保持数组形态**（宿主会序列化成 JSON 文本给模型，
            // 与原生同构；改成字符串会撞上渲染器对 content 类型的假设）。
            const { kept, note, dropped } = trimList(listItems, cfg.budget, path, bytes);
            const arr = [...kept, note];
            if (cfg.stats && cfg.home) await recordStats($, cfg.home, sid, kind, bytes, byteLen(arr.join('\n')), estTokens(t.raw), estTokens(arr.join('\n')));
            return { ...r, result: t.sink.put(arr) };
          }
          const out = compressList(listItems, cfg.budget, path, bytes);
          if (cfg.stats && cfg.home) await recordStats($, cfg.home, sid, kind, bytes, byteLen(out.text), estTokens(t.raw), estTokens(out.text));
          return { ...r, result: t.sink.put(out.text) };
        }
      }

      const opts = kind === 'read'
        ? { mode: 'read', minLines: gate!.minLines, hardBytes: gate!.hardBytes, skeleton: gate!.skeleton }
        : kind === 'doc' ? { mode: 'doc', skeleton: 'doc' } : { mode: 'shell' };
      const rp = kind === 'read' ? toolPathOf(e) : null;
      const ext = kind === 'jsonlist' || (rp && /\.(json|jsonl|ndjson)$/.test(rp.toLowerCase())) ? '.json' : '.txt';
      const path = await spillRaw($, e, t.raw, cfg.home, sid, ext);
      // v0.18 P0：把「为什么没压」带出来（行数门 / 软超时 / 非零退出码 / 已带标记）。
      const trace: { reason?: SkipReason; lines?: number } = {};
      const out = compress(t.raw, cfg.budget, cfg.deadlineMs, path, opts, trace);
      if (!out) {
        // 放弃压缩（门槛/行数门/软超时）——留下原因，归因不必再翻 transcript
        await noteSkip(trace.reason ?? 'unknown', { bytes, lines: trace.lines ?? countLines(t.raw), path: rp ?? undefined });
        return r;
      }
      if (cfg.stats && cfg.home) await recordStats($, cfg.home, sid, kind, bytes, byteLen(out.text), estTokens(t.raw), estTokens(out.text));
      return { ...r, result: t.sink.put(out.text) };
    } catch {
      return r;                              // fail-open：任何问题都不影响工具结果
    }
  };
}

/**
 * 报表工具（#3）：v0.14 起**不再由 mod 注册**——改由插件清单声明 MCP 服务器
 * （.codebuddy-plugin/plugin.json 的 mcpServers.wb_ops → mcp/server.mjs），工具名 mcp__wb_ops__report。
 *
 * 这段是本项目最长的一次返工，别再改回去（2026-11-05 读宿主 bundle 的实测结论）：
 *   宿主有两套 core，能力不同，且**不由时机决定**——
 *   ① 应用级 core（bootstrapFunctionHookMods → hostBindings → createModsCommandToolBindings）：
 *      registerTool 有真实现（toolManager.register(ModProxyTool)），CLI 探针实测返回
 *      {tool:"mcp__wbopsprobe__probereport"}。
 *   ② 会话级 core（createFunctionalHooks → makeCore）：registerTool 被**硬绑**成
 *      `() => { throw Error("Session tool registration is not bound") }`。
 *   GUI 会话里 mod 的每个钩子（session.start / prompt.submit / …）拿到的都是同一个 ② 号 core，
 *   所以 v0.13.1 的「多入口重试」在 GUI 下必然徒劳——差别不在时机，在 core。
 *   MCP 服务器由宿主 MCP 管理器起进程并注册工具，与 mod core 无关，两条路径都通
 *   （旁证：内置插件 builtin-calendar / workbuddy-sheetagent 就是这么声明的）。
 *
 * 本函数因此只剩三件事：压缩、水位守卫、压缩保留指示——全部 fail-open，报表是纯增强项。
 */
export function register(on: On, _options?: unknown): void {
  for (const tool of Object.keys(POLICY)) {
    on('tool.call', { tool }, makeHandler(POLICY[tool]));
  }
  // ③ 通配兜底：所有未列策略的工具（MCP 工具、宿主新增工具）过同一套通用压缩。
  // 谓词每次事件重评（文档 mods.txt「深匹配」节）。
  // 预算内的输出本来就原样透传——兜底只碰真正超线的，Edit/Write 这类小结果零影响。
  on('tool.call', { tool: (v: unknown) => typeof v === 'string' && !KNOWN_TOOLS.has(v) }, makeHandler('other'));

  // #4 水位守卫：每轮用户提交查一次 $.session.usage()（进程内 O(1)，非每回合同步扫大文件的路线）
  // 越线才改写：契约 {text, context:string[]}，context 数组随 prompt 进模型（bundle @2099903 合并逻辑）
  on('prompt.submit', async ($: any, e: any, next: any) => {
    try {
      const cfg = await readCfg($);
      if (cfg.enabled && cfg.guard) {
        // 一次读取两用：① 探测真实形状（写 debug，只记结构/数值）② 喂水位守卫
        const probe = await probeUsage($);
        if (probe.shape || probe.err) {
          const sig = JSON.stringify(probe.shape ?? probe.err);
          if (sig !== lastUsageSig) {          // 形状没变就不重复落盘
            lastUsageSig = sig;
            await writeDebug($, cfg.home, await getSid8($), 'usage', { shape: probe.shape, deny: probe.deny, err: probe.err });
          }
        }
        let w = pickWatermark(probe.value);
        let source = 'usage';
        if (!w && cfg.guardFs) {
          // v0.12：宿主 binding 的 tokens 恒 0 → 从 transcript 尾部取真实 inputTokens，
          // 窗口仍用 usage().context.window（真算的）。同一次读取兼作沙箱读权限探测。
          const tp = await probeTranscript($, cfg.home, await getFullSid($), await getCwd($), cfg.projects);
          const fsSig = JSON.stringify({ ok: !!tp.used, err: tp.err ?? null, path: tp.path ?? null, bytes: tp.bytes ?? null, truncated: tp.truncated ?? false });
          if (fsSig !== lastFsSig) {   // 权限结论没变就不重复落盘
            lastFsSig = fsSig;
            await writeDebug($, cfg.home, await getSid8($), 'fsprobe', { source: 'transcript', ...tp });
          }
          const size = pickWindow(probe.value);
          if (tp.used && size > 0) { w = { used: tp.used, size }; source = 'transcript'; }
        }
        let note: string | null = null;
        if (w) {
          // ② 每轮把余量写进 <sid8>.num（几十字节小文件，进程内 fs）——越线提醒之外让模型可主动查
          let wmPath: string | undefined;
          try {
            if (cfg.home) {
              wmPath = `${cfg.home.replace(/\\/g, '/')}/.workbuddy/wb-ops/watermark/${await getSid8($)}.num`;
              await $.fs.write(wmPath, watermarkLine(w, source));
            }
          } catch { wmPath = undefined; }
          note = guardNote(w, cfg.guardPct, wmPath);
        }
        if (note) {
          const r = await next(e);
          const text = r && typeof r.text === 'string' ? r.text : String(e?.text ?? '');
          const ctx: string[] = Array.isArray(r?.context) ? r.context : [];
          return { text, context: [...ctx, note] };
        }
      }
    } catch { /* 形状未知/usage 抛错 → 透传 */ }
    return next(e);
  });

  // #5 压缩保留指示：session.compact 事件带 instructions（bundle @1704343），next 前改写 = Mod 版 PreCompact
  on('session.compact', async ($: any, e: any, next: any) => {
    try {
      const cfg = await readCfg($);
      if (cfg.enabled && cfg.guard) {
        const base = typeof e?.instructions === 'string' && e.instructions ? e.instructions + '\n' : '';
        const merged = base + COMPACT_RETENTION;
        // 诊断：只记长度与是否含保留指示，不记正文（与 usage/fsprobe 同口径）
        await writeDebug($, cfg.home, await getSid8($), 'compact', {
          trigger: typeof e?.trigger === 'string' ? e.trigger : undefined,
          hadBase: !!base,
          baseLen: base.length,
          mergedLen: merged.length,
          hasRetention: merged.includes(COMPACT_RETENTION),
        });
        return next({ ...e, instructions: merged });
      }
    } catch { /* 透传 */ }
    return next(e);
  });
}
