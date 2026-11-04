/**
 * wb-ops — WorkBuddy Mod：工具输出治理（进程内，确定性，fail-open）
 * v0.3 覆盖面：Bash / PowerShell / TaskOutput / Grep / Glob / Read / WebFetch / WebSearch。
 * 后续按事件逐个拓展（所有烧 token 的出口）。
 *
 * 设计规则（源自 sana35421/wb-ops 的 UserPromptSubmit 5s 超时事故分析，见 README）：
 *  1. 零子进程：只做 Mods 的 tool.call 中间件，不注册任何 shell hook。
 *  2. fail-open：未知形状、任何异常、超预算(时间/体积) —— 一律原样返回工具结果。
 *  3. 错误透传：isError 或 Exit Code 非零的输出不压缩（保完整现场）；shell 失败现场另附一行
 *     nextAction 提示（HINTS 表），对应 dsh-ops「报错重试循环」遏制原则——提示不是压缩，不加预算负担。
 *  4. 确定性策略：head/tail + 关键行 + 原文落盘（spill）带回查路径，热路径无 LLM。
 *  5. 并发安全：无共享可变状态文件；spill 文件名含 session/callId/序号，互不覆盖。
 *  6. 双压缩防护：已带本插件或 sana 版标记的文本不再处理。
 *  7. 宿主已兜底的不碰：Read 的 <persisted-output>（宿主自己落盘并给预览）直接透传。
 *
 * 数值来源：sana35421/wb-ops trim.py v1.3.3 实测校准过的阈值（字节预算、头尾占比 30/22、
 * FILL_TARGET 85%、KEY 行 40 条均匀抽样、空洞指路 ≥20 行等）——那是 544 测试 + 真实
 * 使用磨出来的数字，重调一遍纯烧 token。
 *
 * 沙箱约束：mods 内禁止 node:require/process/global —— 本文件零运行时 import、不碰 global；
 * 文件系统走 $.fs，环境变量走 $.env，会话走 $.session。
 */

import type { On } from 'codebuddy-code';

const MARKER = '[wb-ops]';                   // 本 Mod 的标记
// sana35421/wb-ops（shell-hook 版）的真实标记前缀（trim.py L61-62），共存防双压。
const FOREIGN_MARKERS = ['[wb-ops 省略', '[wb-ops 以下为原文末尾'];

const DEFAULT_BUDGET = 8000;                 // 预算按 UTF-8 字节计（中文 3 字节≈1 token，按字符会漏）
const DEFAULT_DEADLINE_MS = 100;             // 压缩自设软超时；超时放弃，返回原文
const MAX_SPILL_CHARS = 4_000_000;           // 落盘写入门槛：超过不写（唯一的同步 IO 必须封顶）
const MAX_INPUT_BYTES = 8_000_000;           // 超大输入一律透传（split 本身都不做）
const LINE_MAX_BYTES = 1000;                 // 单行展示上限（防 minified 巨行吃满预算；sana MAX_LINE_BYTES）
const KEY_MAX_LINES = 40;                    // 中段捞回上限，超出均匀抽样（sana MAX_KEY_LINES）
const KEY_POOL_MAX = 4000;                   // 命中爆炸护栏：池满即用已有部分
const GAP_HINT_MIN_LINES = 20;               // 空洞指路门槛（sana v1.3.0）
const GAP_HINT_MAX_LIMIT = 180;              // 指路 limit 上限：太大又会被同一道门槛裁一次
const READ_HEAD_MIN = 20, READ_HEAD_MAX = 400, READ_TAIL_MIN = 10, READ_TAIL_MAX = 300;
const HEAD_MIN = 8, HEAD_MAX = 400, TAIL_MIN = 5, TAIL_MAX = 300;
const FILL_TARGET = 0.85;                    // 预算利用率目标（sana：打满会塞进低价值行，不追求）
const GROW_ROUNDS = 5;                       // 头尾扩张轮数上限（每轮 ×1.25）
const MARKER_RESERVE = 1200;                 // 硬截余量（标记行本身要放得下）
// ponytail: 上限=4MB 以上的原文不落盘（仍压缩，标记如实说明「过大」）；升级路径=分块异步写或
// 只存最长空洞段。100MB split 约 0.5–1s，线性且有引擎 10s 兜底。

// 关键行（英文+中文+warn 档；sana KEY_PATTERN v1.3.3 并集）
const KEY = /(error|fatal|exception|traceback|panic|fail|failure|warn|cannot|denied|refused|not found|no such file|undefined reference|segmentation|core dumped|abort|assert|timeout|timed out|\bexited with code\b|错误|失败|警告|异常|未能|无法|超时|拒绝)/i;
// 源码骨架行（sana SYMBOLS，子串匹配）
const SYMBOLS = ['#include', 'function ', 'def ', 'class ', 'struct ', 'namespace ', 'impl ', 'interface ', 'pub fn', 'export ', 'typedef ', 'import '];
// 文档骨架：md 标题 / 加粗标题 / 链接行（WebFetch/WebSearch 输出的天然目录）
const DOC_HEAD = /^#{1,6}\s|^\*\*|^https?:\/\/|^\s*[-*]\s\[|^\[[^\]]+\]\(/;
// Read 行号前缀：`  43→content`（实测 WorkBuddy Read 输出格式）
const READ_LINE_NO = /^\s*(\d+)\u2192/;

/** Read 分档（sana v1.2.2/v1.3.0：读完多半要接着改的，门槛高，中段不能随便丢） */
const DATA_EXTS = ['.log', '.jsonl', '.ndjson', '.csv', '.tsv', '.out', '.err', '.txt'];

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

/** 工具 → 策略。匹配器逐工具注册（mods 文档只验证过 {tool:'X'} 字面匹配，不赌正则）。 */
const POLICY: Record<string, string> = {
  Bash: 'shell', PowerShell: 'shell', TaskOutput: 'shell',
  Grep: 'jsonlist', Glob: 'jsonlist',
  Read: 'read', WebFetch: 'doc', WebSearch: 'doc',
};

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

interface Cfg { enabled: boolean; budget: number; deadlineMs: number; home: string; stats: boolean; hints: boolean; }
type Sink = { put: (s: string) => unknown };
export interface Compression { text: string; dropped: number; }

// ---------------------------------------------------------------- text shape

/** 从未知形状的 ToolResult 中提取可安全替换的纯文本；未知形状返回 null（透传）。 */
export function extractText(res: unknown): { raw: string; sink: Sink } | null {
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
    }
  }
  return null;
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
 * 纯函数压缩核心。返回 null = 放弃（调用方透传原文）。
 * opts.mode：shell（退出码门）| read（行数门槛+硬阀+空洞指路）| doc（标题/链接行命中）。
 */
export function compress(
  raw: string, budget: number, deadlineMs: number, spillPath: string | null,
  opts?: { mode?: string; minLines?: number; hardBytes?: number; skeleton?: string },
): Compression | null {
  const mode = opts?.mode ?? 'shell';
  const bytes = byteLen(raw);
  if (bytes <= budget) return null;
  if (alreadyMarked(raw)) return null;
  const start = Date.now();
  const lines = raw.split('\n');
  const total = lines.length;

  // Read 分档行数门。硬阀例外只给「行数少体量巨大的 dump」（sana READ_STRUCT_HARD_BYTES）；
  // 几百行的整篇文档不算 dump——误伤整篇文档比漏压贵。
  if (opts?.minLines && total < opts.minLines && !(opts.hardBytes && bytes >= opts.hardBytes && total <= 60)) return null;

  if (mode === 'shell') {
    const code = exitCodeOf(lines);
    if (code !== null && code !== 0) return null; // 错误现场：完整透传
  }

  // ---- 少行巨字节：字节级首尾截（Grep content 单行 JSON、minified、dump；v0.2 缺的正好是这条）----
  if (total <= 20) {
    const head = u8Prefix(raw, Math.floor(budget * 0.6));
    const tail = u8Suffix(raw, Math.floor(budget * 0.28));
    const note = `${MARKER} 少行巨字节(${bytes}B/${total}行) · 保留首${byteLen(head)}B+尾${byteLen(tail)}B → ${spillPath ? '落盘 ' + spillPath : '未落盘（原文过大或写入失败，可重跑命令）'}`;
    const text = `${head}\n${note}\n${tail}`;
    return { text: byteLen(text) > budget + MARKER_RESERVE ? u8Prefix(text, budget + MARKER_RESERVE) + `\n${MARKER} …截断` : text, dropped: bytes };
  }

  // ---- 自适应头尾：按平均行长估行数（sana v1.1：固定行数对短行/长行两头都亏）----
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
  for (let i = 0; i < total; i++) {
    if ((i & 511) === 0 && Date.now() - start >= deadlineMs) return null;
    const l = lines[i];
    if (l.length > 0 && hitKey(l, skeleton)) {
      pool.push(i);
      if (pool.length >= KEY_POOL_MAX) break; // 命中爆炸：用已有池，不再扫
    }
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
      const step = Math.ceil(mid.length / KEY_MAX_LINES);
      keyIdx = mid.filter((_, j) => j % step === 0); // 均匀撒点（sana：连续段等于没省）
    } else keyIdx = mid;
    if (mode === 'shell') {
      // Exit Code 行保底：命令失败现场已透传，能走到这说明它是 0——但这行必须可见，
      // 否则模型无从判断成败。在最近 50 行内找到它，强行纳入尾段。
      for (let i = 0; i < Math.min(50, total - headKeep); i++) {
        if (/Exit Code:/i.test(lines[total - 1 - i])) { tailKeep = Math.max(tailKeep, i + 1); break; }
      }
      keyIdx = keyIdx.filter((i) => i >= headKeep && i < total - tailKeep); // 尾段扩张后去重
    }
    let u = 0;
    for (let i = 0; i < headKeep; i++) u += cost(i);
    for (let i = total - tailKeep; i < total; i++) u += cost(i);
    for (const i of keyIdx) u += cost(i);
    if (u >= budget * FILL_TARGET || round >= GROW_ROUNDS || (headN >= headMax && tailN >= tailMax)) break;
    headN = Math.min(Math.floor(headN * 1.25) + 1, headMax, sideMax);
    tailN = Math.min(Math.floor(tailN * 1.25) + 1, tailMax, sideMax);
  }

  // 空洞指路（sana v1.3.0）：只认最长连续段，≥20 行才指；仅 Read（有行号可指）
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
  const note = `${MARKER} 已省略 ${dropped} 行 · 原文 ${bytes}B → ${spillPath ? '落盘 ' + spillPath : '未落盘（原文过大或写入失败，可重跑命令）'}${hint}`;
  const parts: string[] = [];
  for (let i = 0; i < headKeep; i++) parts.push(truncLine(lines[i]));
  parts.push(note);
  if (keyIdx.length) {
    parts.push(`--- 命中关键行 (${keyIdx.length}) ---`);
    for (const i of keyIdx) parts.push(truncLine(lines[i]));
  }
  parts.push('--- 尾部 ---');
  for (let i = total - tailKeep; i < total; i++) parts.push(truncLine(lines[i]));

  let text = parts.join('\n');
  if (byteLen(text) > budget + MARKER_RESERVE) text = u8Prefix(text, budget + MARKER_RESERVE) + `\n${MARKER} …截断`;
  return { text, dropped };
}

/** Grep/Glob 的 JSON 数组模式：前 K 条 + 计数 + 落盘（列表尾部条目不比头部更值钱，不硬凑尾段）。 */
export function compressList(items: string[], budget: number, spillPath: string | null, rawBytes: number): Compression {
  const cap = Math.floor(budget * 0.7);
  let used = 0, k = 0;
  for (const it of items) {
    const c = Math.min(byteLen(it), LINE_MAX_BYTES) + 1;
    if (used + c > cap && k >= 1) break;
    used += c; k++;
  }
  const kept = items.slice(0, k).map(truncLine);
  const note = `${MARKER} 共 ${items.length} 条，已省略 ${items.length - k} 条 · 原文 ${rawBytes}B → ${spillPath ? '落盘 ' + spillPath : '未落盘（原文过大或写入失败，可重跑命令）'}`;
  return { text: kept.join('\n') + '\n' + note, dropped: items.length - k };
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
  return {
    enabled: !off,
    budget: budget > 512 ? budget : DEFAULT_BUDGET,
    deadlineMs: deadline >= 0 ? deadline : DEFAULT_DEADLINE_MS,
    home,
    stats: /^(1|true|on|yes)$/i.test((await g('WB_OPS_STATS')).trim()),
    hints: !/^(0|off|false|no)$/i.test((await g('WB_OPS_HINTS')).trim()),
  };
}

let seq = 0;

async function getSid8($: any): Promise<string> {
  try { return String(await $.session.id()).slice(0, 8); } catch { return 'nosid'; }
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

/** 记账（WB_OPS_STATS=1 才开）：每会话一个小 JSON 计数器，整读整写小文件，不做无界追写。
 *  任何失败静默——纯观测件，绝不反噬主流程。 */
async function recordStats($: any, home: string, sid: string, tool: string, before: number, after: number): Promise<void> {
  try {
    const path = `${home.replace(/\\/g, '/')}/.workbuddy/wb-ops/stats/${sid}.json`;
    let cur: Record<string, number> = { calls: 0, before: 0, after: 0 };
    try {
      const v = await $.fs.read(path);
      const txt = typeof v === 'string' ? v : v && typeof (v as { text?: unknown }).text === 'string' ? (v as { text: string }).text : '';
      if (txt) cur = { ...cur, ...(JSON.parse(txt) as Record<string, number>) };
    } catch { /* 首次 */ }
    cur.calls = (cur.calls || 0) + 1;
    cur.before = (cur.before || 0) + before;
    cur.after = (cur.after || 0) + after;
    await $.fs.write(path, JSON.stringify({ ...cur, tool, ts: new Date().toISOString() }));
  } catch { /* 记账失败不影响主流程 */ }
}

// ------------------------------------------------------------------ entry

function toolPathOf(e: any): string | null {
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
      const t = extractText(r.result);
      if (!t) return r;
      const len = t.raw.length;

      // shell 类：Exit Code 非零 → 现场完整透传（不压缩、不落盘），至多加一行 nextAction 提示。
      // 特意放在预算/大小早退之前：失败输出多半不大，而"盲目重跑一整轮"恰恰发生在这些小现场上。
      if (kind === 'shell') {
        const codes = t.raw.slice(-2000).match(/Exit Code:\s*(-?\d+)/gi);
        if (codes && codes.length) {
          const last = parseInt(codes[codes.length - 1].replace(/.*?:\s*/, ''), 10);
          if (Number.isFinite(last) && last !== 0) {
            if (!cfg.hints || len > MAX_INPUT_BYTES || alreadyMarked(t.raw)) return r;
            const h = hintFor(t.raw);
            return h ? { ...r, result: t.sink.put(t.raw + '\n' + HINT_PREFIX + h) } : r;
          }
        }
      }

      if (len > MAX_INPUT_BYTES) return r;        // 字节数 ≥ 字符数：字符都超限则字节必超，免全量扫描
      if (len * 3 < cfg.budget) return r;         // 每字符顶格 3 字节也进不了预算：免测
      const bytes = byteLen(t.raw);               // 预算是字节语义；字符数会放过「字符≤预算<字节」的中文串
      if (bytes <= cfg.budget || bytes > MAX_INPUT_BYTES) return r;
      if (alreadyMarked(t.raw)) return r;         // 双压缩防护（含 sana 标记）

      let gate: ReadGate | null = null;
      if (kind === 'read') {
        if (t.raw.startsWith('<persisted-output>')) return r; // 宿主已落盘+指路，二次压缩纯属捣乱
        const path = toolPathOf(e);
        if (!path) return r;                 // 判不了文件类型：保守透传（源码被误伤比漏压贵）
        gate = classifyRead(path);
      }

      const sid = await getSid8($);

      const items = kind === 'jsonlist' ? parseJsonList(t.raw) : null;
      if (items) {
        const path = await spillRaw($, e, t.raw, cfg.home, sid, '.json');
        const out = compressList(items, cfg.budget, path, bytes);
        if (cfg.stats && cfg.home) await recordStats($, cfg.home, sid, kind, bytes, byteLen(out.text));
        return { ...r, result: t.sink.put(out.text) };
      }

      const opts = kind === 'read'
        ? { mode: 'read', minLines: gate!.minLines, hardBytes: gate!.hardBytes, skeleton: gate!.skeleton }
        : kind === 'doc' ? { mode: 'doc', skeleton: 'doc' } : { mode: 'shell' };
      const rp = kind === 'read' ? toolPathOf(e) : null;
      const ext = kind === 'jsonlist' || (rp && /\.(json|jsonl|ndjson)$/.test(rp.toLowerCase())) ? '.json' : '.txt';
      const path = await spillRaw($, e, t.raw, cfg.home, sid, ext);
      const out = compress(t.raw, cfg.budget, cfg.deadlineMs, path, opts);
      if (!out) return r;                    // 放弃压缩（门槛/行数门/软超时）
      if (cfg.stats && cfg.home) await recordStats($, cfg.home, sid, kind, bytes, byteLen(out.text));
      return { ...r, result: t.sink.put(out.text) };
    } catch {
      return r;                              // fail-open：任何问题都不影响工具结果
    }
  };
}

export function register(on: On, _options?: unknown): void {
  for (const tool of Object.keys(POLICY)) {
    on('tool.call', { tool }, makeHandler(POLICY[tool]));
  }
}
