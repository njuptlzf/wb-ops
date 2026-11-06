#!/usr/bin/env node
// P0 验收脚本：宿主 `e.input` 字段名核对 + 各工具分档命中率。
//
// 验收目标（见 docs/ROADMAP.md「P0 · 宿主 e.input 字段名逐个核对」）：
//   ① 逐个工具核对真实 input 键名，确认 wb-ops 的 toolPathOf 判据（file_path/path/filePath）能命中；
//   ② 统计各工具「真实调用数 vs 压缩命中数」，量化分档命中率；
//   ③ 把「超预算却没被压缩」的结果逐条归因——区分「宿主/插件设计上的有意透传」与「真的判不出路径」。
//
// 数据源：本机真实 transcript（~/.workbuddy/projects/*/*.jsonl）与统计账本（~/.workbuddy/wb-ops/stats/*.json）。
//   - transcript 里 function_call.arguments 是**字符串** JSON（持久化格式），
//     但 function_call_result.output 是**对象**——两者形状不同，别混为一谈；
//   - 账本只记「真正压缩过」的调用，因此账本次数 ≤ 真实超预算次数，差额要靠归因解释。
//
// 用法：
//   node test/audit-tiers.mjs              # 打印完整报告
//   node test/audit-tiers.mjs --json       # 机器可读（CI 用）
//   WB_OPS_PROJECTS=... WB_OPS_STATS=... node test/audit-tiers.mjs   # 自定义数据目录
//
// 退出码：0 = 核对通过（无「判不出路径」类缺口）；1 = 存在 toolPathOf 失效样本（需修）。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const PROJ = process.env.WB_OPS_PROJECTS || join(HOME, '.workbuddy', 'projects');
const STATS = process.env.WB_OPS_STATS || join(HOME, '.workbuddy', 'wb-ops', 'stats');
const BUDGET = 4500; // 与 hooks/register.ts 的 DEFAULT_BUDGET 一致

// 与 hooks/register.ts 的 POLICY / classifyRead 保持同步
const POLICY = {
  Bash: 'shell', PowerShell: 'shell', TaskOutput: 'shell',
  Grep: 'jsonlist', Glob: 'jsonlist',
  Read: 'read', WebFetch: 'doc', WebSearch: 'doc',
};
const PATH_KEYS = ['file_path', 'path', 'filePath'];
const DATA_EXTS = ['.log', '.jsonl', '.ndjson', '.csv', '.tsv', '.out', '.err', '.txt'];
const READ_GATES = { READ_SOURCE: 1500, READ_DOC: 800, READ_STRUCT: 800, READ_DATA: 200 };

function classifyRead(path) {
  const p = (path || '').trim().toLowerCase().replace(/\\/g, '/');
  if (p.endsWith('.md') || p.endsWith('.markdown')) return 'READ_DOC';
  if (p.endsWith('.json')) return 'READ_STRUCT';
  for (const e of DATA_EXTS) if (p.endsWith(e)) return 'READ_DATA';
  return 'READ_SOURCE';
}

function outText(d) {
  const o = d?.output;
  if (typeof o === 'string') return o;
  if (o && typeof o === 'object') return o.text || '';
  return '';
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 采集
const callArgs = new Map();   // callId -> arguments（对象）
const results = [];           // {tool, bytes, text}

for (const f of walk(PROJ)) {
  let txt;
  try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of txt.split('\n')) {
    if (!line) continue;
    if (!line.includes('function_call')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'function_call') {
      let a = d.arguments;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
      if (a && typeof a === 'object') callArgs.set(String(d.callId || d.id || ''), a);
    } else if (d.type === 'function_call_result') {
      const text = outText(d);
      if (!text) continue;
      results.push({
        tool: d.name || '(无名)',
        callId: String(d.callId || d.id || ''),
        bytes: Buffer.byteLength(text, 'utf8'),
        text,
        ts: d.timestamp || 0,
      });
    }
  }
}

// ---------------------------------------------------------------- ① input 键名核对
const keysByTool = new Map();
for (const [callId, a] of callArgs) {
  const tool = a.__tool || null; // arguments 里没有工具名，改由 results 侧反查
  void tool; void callId;
}
const toolByCallId = new Map();
for (const f of walk(PROJ)) {
  let txt;
  try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of txt.split('\n')) {
    if (!line.includes('"function_call"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'function_call') toolByCallId.set(String(d.callId || d.id || ''), d.name || '?');
  }
}
for (const [cid, a] of callArgs) {
  const t = toolByCallId.get(cid) || '(未知)';
  const ks = Object.keys(a).sort().join(',');
  if (!keysByTool.has(t)) keysByTool.set(t, new Map());
  const m = keysByTool.get(t);
  m.set(ks, (m.get(ks) || 0) + 1);
}

// ---------------------------------------------------------------- ② 分档结局统计
const outcome = new Map();   // tool -> Map(outcome -> count)
const overBudget = new Map();
const bump = (tool, key) => {
  if (!outcome.has(tool)) outcome.set(tool, new Map());
  const m = outcome.get(tool);
  m.set(key, (m.get(key) || 0) + 1);
};

const readDetail = { gated: 0, compressed: 0, noPath: 0, hostSpill: 0, samples: [] };

// 压缩能力的启用时刻 = 本机 transcript 中首次出现 [wb-ops] 标记的时间。
// 早于此刻的「超预算未压缩」属历史数据（插件尚未生效），不是缺口。
let firstMarkTs = Infinity;
for (const r of results) if (r.text.includes('[wb-ops]') && r.ts) firstMarkTs = Math.min(firstMarkTs, r.ts);
const ACTIVE = Number.isFinite(firstMarkTs) ? firstMarkTs : 0;

const preActive = new Map();   // tool -> count（插件生效前的历史未压缩）
const bumpPre = (tool) => preActive.set(tool, (preActive.get(tool) || 0) + 1);

for (const r of results) {
  const over = r.bytes > BUDGET;
  if (!over) { bump(r.tool, '预算内'); continue; }
  if (r.text.startsWith('<persisted-output>')) { bump(r.tool, '宿主已落盘'); if (r.tool === 'Read') readDetail.hostSpill++; continue; }
  if (r.text.includes('[wb-ops]')) { bump(r.tool, 'mod已压缩'); if (r.tool === 'Read') readDetail.compressed++; continue; }

  // 超预算却未被压缩 → 归因
  if (r.tool === 'Read') {
    const a = callArgs.get(r.callId) || {};
    const fp = a.file_path || a.path || a.filePath;
    if (!fp) {
      bump(r.tool, '判不出路径(缺口)');
      readDetail.noPath++;
      readDetail.samples.push({ bytes: r.bytes, reason: 'no-path' });
      continue;
    }
    const gate = READ_GATES[classifyRead(fp)];
    const lines = r.text.split('\n').length;
    if (lines < gate) {
      bump(r.tool, '行数门拦截');
      readDetail.gated++;
    } else {
      bump(r.tool, '判不出路径(缺口)');
      readDetail.noPath++;
      readDetail.samples.push({ bytes: r.bytes, file: fp, lines, gate, reason: 'gated-but-lines-ok' });
    }
    continue;
  }

  // shell 档：非零 Exit Code = 错误现场有意透传
  const codes = [...r.text.slice(-2000).matchAll(/Exit Code:\s*(-?\d+)/gi)];
  if (codes.length && parseInt(codes[codes.length - 1][1], 10) !== 0) {
    bump(r.tool, '非零Exit Code(错误现场透传)');
    continue;
  }
  // 其余未归因：先看是不是压缩能力启用之前的历史数据
  if (ACTIVE && r.ts && r.ts < ACTIVE) { bumpPre(r.tool); continue; }
  bump(r.tool, '未归因(需排查)');
  if (r.tool === 'Read') {
    readDetail.noPath++;
    readDetail.samples.push({ bytes: r.bytes, reason: 'unattributed' });
  }
}

// 账本
const ledger = new Map();
if (existsSync(STATS)) {
  for (const name of readdirSync(STATS)) {
    if (!name.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(readFileSync(join(STATS, name), 'utf8')); } catch { continue; }
    for (const [k, v] of Object.entries(d.kinds || {})) {
      ledger.set(k, (ledger.get(k) || 0) + (v.calls || 0));
    }
  }
}

// ---------------------------------------------------------------- 输出
const lines = [];
const P = (s = '') => lines.push(s);

P('== ① 各工具真实 input 键名（toolPathOf 判据 = file_path / path / filePath）==');
P(`   ${'工具'.padEnd(16)}${'调用数'.padStart(7)}  命中路径键    实际键名`);
P('   ' + '-'.repeat(78));
for (const [tool, m] of [...keysByTool].sort((a, b) => {
  const sa = [...a[1].values()].reduce((x, y) => x + y, 0);
  const sb = [...b[1].values()].reduce((x, y) => x + y, 0);
  return sb - sa;
})) {
  let total = 0, hit = null, topKs = '', topN = 0;
  for (const [ks, n] of m) {
    total += n;
    if (n > topN) { topN = n; topKs = ks; }
    if (!hit) for (const k of PATH_KEYS) if (ks.split(',').includes(k)) { hit = k; break; }
  }
  P(`   ${tool.padEnd(16)}${String(total).padStart(7)}  ${(hit || '-- 无 --').padEnd(14)} ${topKs}`);
}

P('');
P('== ② 各工具分档结局（真实 transcript 全量）==');
P(`   ${'工具'.padEnd(16)}${'结果数'.padStart(7)}${'超预算'.padStart(7)}  结局分布`);
P('   ' + '-'.repeat(86));
for (const [tool, m] of [...outcome].sort((a, b) => {
  const sa = [...a[1].values()].reduce((x, y) => x + y, 0);
  const sb = [...b[1].values()].reduce((x, y) => x + y, 0);
  return sb - sa;
})) {
  const total = [...m.values()].reduce((x, y) => x + y, 0);
  const over = total - (m.get('预算内') || 0);
  if (!over) continue;
  const dist = Object.fromEntries([...m].filter(([k]) => k !== '预算内'));
  P(`   ${tool.padEnd(16)}${String(total).padStart(7)}${String(over).padStart(7)}  ${JSON.stringify(dist)}`);
}

P('');
P('== ③ Read 档归因（超预算却没被压缩）==');
P(`   行数门正确拦截: ${readDetail.gated}`);
P(`   mod 已压缩:     ${readDetail.compressed}`);
P(`   宿主已落盘:     ${readDetail.hostSpill}`);
P(`   判不出路径(缺口): ${readDetail.noPath}`);
if (readDetail.samples.length) {
  P('   缺口样本:');
  for (const s of readDetail.samples.slice(0, 10)) {
    P(`     ${s.bytes}B ${s.file || ''} ${s.lines || ''}${s.gate ? ` (gate=${s.gate})` : ''}`);
  }
}

P('');
P('== ④ 账本压缩计数（仅含真正压缩过的调用）==');
P('   ' + JSON.stringify(Object.fromEntries(ledger)));

P('');
P('== ⑤ 压缩能力启用时刻与历史数据 ==');
const fmtTs = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '?');
P(`   压缩能力首次生效（transcript 中最早 [wb-ops] 标记）: ${fmtTs(firstMarkTs)}`);
if (preActive.size) {
  const tot = [...preActive.values()].reduce((x, y) => x + y, 0);
  P(`   插件生效前的历史「超预算未压缩」: ${tot} 条（不计入缺口）`);
  for (const [t, n] of [...preActive].sort((a, b) => b[1] - a[1])) P(`     ${t}: ${n}`);
}

const fail = readDetail.noPath > 0;
P('');
P(fail ? '== 结论：存在「判不出路径」缺口，需修复 ==' : '== 结论：核对通过——无「判不出路径」缺口 ==');

if (process.argv.includes('--json')) {
  const out = {
    ok: !fail,
    inputKeys: Object.fromEntries([...keysByTool].map(([t, m]) => [t, Object.fromEntries(m)])),
    outcomes: Object.fromEntries([...outcome].map(([t, m]) => [t, Object.fromEntries(m)])),
    readDetail,
    ledger: Object.fromEntries(ledger),
  };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(lines.join('\n'));
}
process.exit(fail ? 1 : 0);
