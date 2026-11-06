#!/usr/bin/env node
/**
 * wb-ops 省量保真度 benchmark（确定性，无需 LLM/API）
 *
 * 用真压缩器（hooks/register.ts 导出的 compress/compressList）跑一组带"必留信息"锚点的
 * 标准夹具，回答三个问题：
 *   ① 省了多少（字节 / 估算 token / 百分比）
 *   ② 失真了吗（关键信息保留率 / 有没有捏造出原文没有的行 / 行完整性 / 尾部真实性）
 *   ③ 比裸截断强多少（与"只留前 budget 字节"的朴素基线对比同一组锚点）
 *
 * 用法：
 *   node test/benchmark.mjs              # 表格报告
 *   node test/benchmark.mjs --json       # 机器可读
 *   node test/benchmark.mjs --qa         # 生成 LLM 评测问答卷（见 docs/BENCHMARK.md §4）
 *
 * 退出码：任何 critical 锚点丢失或出现捏造行 → 1（可当回归门禁用）。
 */
import { compress, compressList, estTokens, byteLen, u8Prefix, classifyRead } from '../hooks/register.ts';

/* ---------------- 确定性伪随机（夹具可复现） ---------------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUDGET = 4500, DEADLINE = 1000, SPILL = '~/.workbuddy/wb-ops/spill/<sid8>/1-0.txt';
const MARKER_RESERVE = 1200;

/* ---------------- 夹具构造 ---------------- */
function fill(prefix, n, seed) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) out.push(`${prefix} line-${i} ${r().toFixed(6)} ${'x'.repeat(Math.floor(r() * 40))}`);
  return out;
}

function buildShellLog() {
  const L = fill('info', 3200, 42);
  const want = []; // desired：最好留在上下文；丢了=靠落盘兜底
  const put = (i, line) => { L[i] = line; want.push(line); };
  put(400, '[ERROR] vite build: module "foo-bar" not found in rollup resolve');
  put(1100, '[WARN] deprecated API usage: fs.rmdirSync (2 occurrences)');
  put(1700, '[FATAL] missing dependency foo-bar@1.2.3 — install to continue');
  put(1701, '    at resolveDep (/build/resolve.js:88:15)');
  put(2400, '[WARN] chunk size 2.4MB exceeds budget warning limit');
  L.push('Exit Code: 0');
  return { name: 'shell/build-log', kind: 'shell', raw: L.join('\n'), want, critical: [/^\[wb-ops\] (已省略|少行巨字节)/m, /落盘 /, /Exit Code:/] };
}

function buildTestRunner() {
  const L = fill('ok', 1400, 7);
  const want = [];
  const put = (i, line) => { L[i] = line; want.push(line); };
  for (let k = 0; k < 6; k++) put(200 + k * 150, `FAIL src/api/order-${k}.test.ts — expected 200 got 503 (retry budget exhausted)`);
  put(1390, 'Tests: 198 passed, 6 failed, 204 total');
  L.push('Exit Code: 0');
  return { name: 'shell/test-runner', kind: 'shell', raw: L.join('\n'), want, critical: [/^\[wb-ops\] /m, /Exit Code:/] };
}

function buildStackTrace() {
  const L = fill('req', 900, 99);
  const want = [];
  const put = (i, line) => { L[i] = line; want.push(line); };
  put(450, 'FATAL: unhandled rejection in worker pool');
  for (let k = 0; k < 4; k++) put(451 + k, `    at Worker.run (/srv/worker.js:${120 + k}:22)`);
  put(470, '[ERROR] pool drained: 0 healthy of 4 workers');
  L.push('Exit Code: 0');
  return { name: 'shell/stack-trace', kind: 'shell', raw: L.join('\n'), want, critical: [/^\[wb-ops\] /m, /Exit Code:/] };
}

function buildCjkLog() {
  const L = fill('信息', 2200, 5);
  const want = [];
  const put = (i, line) => { L[i] = line; want.push(line); };
  put(300, '[错误] 数据库连接超时：127.0.0.1:5432 连接被拒绝（重试 3 次失败）');
  put(800, '[警告] 磁盘水位 87%，超过阈值 85%');
  put(1500, '[异常] 订单同步任务中断：无法解析上游响应（重试 3 次失败）');
  L.push('Exit Code: 0');
  return { name: 'shell/cjk-log', kind: 'shell', raw: L.join('\n'), want, critical: [/^\[wb-ops\] /m, /Exit Code:/] };
}

function buildMinified() {
  const r = rng(11);
  const obj = { rows: Array.from({ length: 900 }, (_, i) => ({ i, v: r().toFixed(6), pad: 'y'.repeat(30) })) };
  const raw = `{"dump":"2026-11-06","rows":[${obj.rows.map((o) => JSON.stringify(o)).join(',')}],"end":true}\nExit Code: 0`;
  return { name: 'shell/minified-dump', kind: 'shell', raw, want: [], critical: [/^\[wb-ops\] 少行巨字节/m, /落盘 /, /Exit Code: 0/] };
}

function buildGrepList() {
  const items = [];
  for (let i = 0; i < 220; i++) {
    const p = `src/module-${i}/handler-${i}.ts:1:${i} export const handler${i} = async () => {{}}`;
    items.push(p);
  }
  return {
    name: 'grep/native-array', kind: 'list', items, raw: items.join('\n'),
    want: [items[0]], // 首条本就该在
    critical: [/^\[wb-ops\] 共 220 条，已省略/m, /落盘 /],
  };
}

function buildReadLog() {
  const L = [];
  const want = [];
  for (let i = 1; i <= 600; i++) {
    let line;
    if (i === 150) { line = `   ${i}→[ERROR] cache coherence violated on shard-7 (seq=88342)`; want.push(line); }
    else if (i === 450) { line = `   ${i}→[ERROR] replication lag 42s exceeds hard limit`; want.push(line); }
    else line = `   ${i}→info heartbeat seq=${i} latency=3ms region=cn-north`;
    L.push(line);
  }
  const raw = L.join('\n');
  return { name: 'read/data-log', kind: 'read', path: 'logs/app.log', raw, want, critical: [/^\[wb-ops\] 已省略/m, /回看: Read offset=(\d+) limit=(\d+)/] };
}

function buildReadSource() {
  const L = [];
  for (let i = 1; i <= 800; i++) L.push(`   ${i}→const value_${i} = compute(${i}, { region: 'cn-north' });`);
  return { name: 'read/source-800', kind: 'read', path: 'src/app.ts', raw: L.join('\n'), want: [], critical: [], expectPassthrough: true };
}

function buildWebDoc() {
  const L = fill('body paragraph', 700, 21);
  const want = [];
  const put = (i, line) => { L[i] = line; want.push(line); };
  put(10, '# API Reference');
  put(150, '## Authentication');
  put(320, '**Rate limits:** 60 requests/min per token');
  put(500, '### Error codes');
  put(690, '- [Changelog](https://example.com/changelog)');
  const raw = L.join('\n');
  return { name: 'webfetch/doc', kind: 'skeleton', raw, want, critical: [/^\[wb-ops\] /m] };
}

/* ---------------- 指标 ---------------- */
const isNoise = (l) => !l || l.startsWith('[wb-ops') || l.startsWith('--- ') || l.startsWith('· ') || l === '…截断' || l.endsWith(' …截断');
function linesInOutput(text) { return text.split('\n'); }

function measure(raw, res, fx) {
  const m = {
    savings: null, criticalHit: 0, criticalTotal: fx.critical.length,
    desiredIn: 0, desiredTotal: fx.want.length, fabricated: 0,
    budgetOk: true, tailAuthentic: true, exitCodeOk: true, passthrough: res === null,
  };
  if (res === null) {
    m.savings = 0; m.criticalHit = fx.critical.length; m.desiredIn = fx.want.length; m.exitCodeOk = true;
    return m;
  }
  const text = res.text;
  const bOut = byteLen(text), bIn = byteLen(raw);
  m.savings = 1 - bOut / bIn;
  m.budgetOk = bOut <= BUDGET + MARKER_RESERVE;
  for (const re of fx.critical) if (re.test(text)) m.criticalHit++;
  for (const w of fx.want) if (text.includes(w)) m.desiredIn++;

  // 反捏造：除标记/分节/截断行外，每一行都必须来自原文
  for (const l of linesInOutput(text)) {
    if (isNoise(l)) continue;
    if (l.endsWith('…')) { if (!raw.includes(l.slice(0, 80))) m.fabricated++; }
    else if (!raw.includes(l)) m.fabricated++;
  }
  // 尾部真实性：原文最后一个非空行应出现在压缩结果里
  const lastRaw = raw.split('\n').filter(Boolean).pop();
  m.tailAuthentic = text.includes(lastRaw);
  // shell：退出码行必须可见
  if (fx.kind === 'shell') m.exitCodeOk = /Exit Code:/i.test(text);
  return m;
}

/* ---------------- 朴素基线：只留前 budget+1200 字节 ---------------- */
function naiveMeasure(raw, fx) {
  const text = u8Prefix(raw, BUDGET + MARKER_RESERVE);
  let criticalHit = 0;
  for (const re of fx.critical) {
    // 基线的 Exit Code 行天然不在头部——为公平只测与压缩器同口径的正则
    if (re.test(text)) criticalHit++;
  }
  let desiredIn = 0;
  for (const w of fx.want) if (text.includes(w)) desiredIn++;
  return { criticalHit, desiredIn, savings: 1 - byteLen(text) / byteLen(raw) };
}

/* ---------------- 跑夹具 ---------------- */
function runFixture(fx) {
  let res = null;
  if (fx.kind === 'shell') {
    res = compress(fx.raw, BUDGET, DEADLINE, SPILL, { mode: 'shell' });
  } else if (fx.kind === 'list') {
    const rawBytes = fx.items.reduce((a, s) => a + byteLen(s) + 1, 0);
    res = compressList(fx.items, BUDGET, SPILL, rawBytes);
    // 统一成 { text } 评测口径
    res = { text: res.text, dropped: res.dropped };
  } else if (fx.kind === 'read') {
    const gate = classifyRead(fx.path);
    res = compress(fx.raw, BUDGET, DEADLINE, SPILL, { mode: 'read', minLines: gate.minLines, skeleton: gate.skeleton });
  } else if (fx.kind === 'skeleton') {
    res = compress(fx.raw, BUDGET, DEADLINE, SPILL, { mode: 'shell', skeleton: 'heading' });
  }
  const m = measure(fx.raw, res, fx);
  const nv = naiveMeasure(fx.raw, fx);
  return { fx, res, m, naive: nv };
}

const FIXTURES = [
  buildShellLog(), buildTestRunner(), buildStackTrace(), buildCjkLog(),
  buildMinified(), buildGrepList(), buildReadLog(), buildReadSource(), buildWebDoc(),
];

/* ---------------- 报告 ---------------- */
function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }

function report(rows, asJson) {
  if (asJson) return JSON.stringify(rows, null, 2);
  const head = [
    '夹具'.padEnd(22), '省字节'.padStart(8), '关键锚点'.padStart(10), '期望信息(上下文内)'.padStart(14),
    '捏造行'.padStart(6), '预算'.padStart(4), '尾真实'.padStart(6), '退码'.padStart(4),
    '| 基线关键'.padStart(10), '基线期望'.padStart(10),
  ].join('');
  const lines = [head, '-'.repeat(head.length)];
  let fail = [];
  for (const { fx, res, m, naive } of rows) {
    const cr = m.criticalTotal ? `${m.criticalHit}/${m.criticalTotal}` : 'n/a';
    const dr = m.desiredTotal ? `${m.desiredIn}/${m.desiredTotal}` : 'n/a';
    lines.push([
      fx.name.padEnd(22),
      fmtPct(m.savings ?? 0).padStart(8),
      cr.padStart(10),
      dr.padStart(14),
      String(m.fabricated).padStart(6),
      (m.budgetOk ? 'ok' : 'OVER').padStart(4),
      (fx.kind === 'shell' ? String(m.tailAuthentic) : 'n/a').padStart(6),
      (fx.kind === 'shell' ? String(m.exitCodeOk) : 'n/a').padStart(4),
      `${naive.criticalHit}/${m.criticalTotal}`.padStart(10),
      `${naive.desiredIn}/${m.desiredTotal}`.padStart(10),
    ].join(''));
    if (m.criticalHit < m.criticalTotal) fail.push(`${fx.name}: critical ${m.criticalHit}/${m.criticalTotal}`);
    if (m.fabricated > 0) fail.push(`${fx.name}: ${m.fabricated} fabricated lines`);
    if (!m.budgetOk) fail.push(`${fx.name}: over budget`);
    if (fx.kind === 'shell' && !m.exitCodeOk) fail.push(`${fx.name}: exit code lost`);
  }
  return lines.join('\n') + '\n\n' + (fail.length ? 'FAIL:\n' + fail.map((s) => '  - ' + s).join('\n') : 'ALL GATES PASSED');
}

/* ---------------- QA 卷（LLM 评测，可选） ---------------- */
function qaSheet(rows) {
  const qa = [];
  const pick = (fx, qs) => ({ fixture: fx.name, questions: qs });
  for (const { fx, res } of rows) {
    if (res === null) continue;
    qa.push(pick(fx, [
      { q: '这次执行/这份输出最终成功了吗？依据哪一行？', probe: 'tail（Exit Code 行 / 总结行）' },
      { q: '输出里出现过哪些错误或警告？各给出一条原文。', probe: '中段关键行池' },
      { q: '没有完整看到的中间部分，如何取回原文？给出确切路径或命令。', probe: '标记行落盘路径 / 回看 hint' },
    ]));
  }
  return [
    '# wb-ops LLM 可用性评测卷（人工/模型判分）',
    '',
    '对每张卷：把【压缩输出】贴给模型问 3 个问题；再把【原文】贴给同一模型问同样问题。',
    '两边答案一致 → 该卷"可用性保持"；压缩侧答不出但原文能答 → 记一次失真点。',
    '评分口径见 docs/BENCHMARK.md §4。',
    '',
    ...qa.flatMap((s) => [`## ${s.fixture}`, ...s.questions.map((q) => `- [探针:${q.probe}] ${q.q}`), '']),
  ].join('\n');
}

/* ---------------- 入口 ---------------- */
const args = process.argv.slice(2);
const rows = FIXTURES.map(runFixture);
if (args.includes('--json')) console.log(report(rows, true));
else if (args.includes('--qa')) console.log(qaSheet(rows));
else {
  console.log(report(rows, false));
  const totalIn = rows.reduce((a, r) => a + estTokens(r.fx.raw), 0);
  const totalOut = rows.reduce((a, r) => a + (r.res ? estTokens(r.res.text) : estTokens(r.fx.raw)), 0);
  console.log(`\n合计：${fmtPct(1 - totalOut / totalIn)} tok（≈${totalIn} → ≈${totalOut}）· 退出码门槛：critical 全中、零捏造、预算内`);
}
const failed = rows.some(({ m }) => m.criticalHit < m.criticalTotal || m.fabricated > 0 || !m.budgetOk || (m.exitCodeOk === false));
process.exit(failed ? 1 : 0);
