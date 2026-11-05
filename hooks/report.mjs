#!/usr/bin/env node
// wb-ops 节省报表 CLI 版：聚合 ~/.workbuddy/wb-ops/stats/*.json（会话内请用 mcp__*__report 工具）
// v0.13：token 口径与宿主同公式估算 ceil(中文/1.8)+ceil(其余/4)，与 [wb-ops] 标记行同源。
// 用法: node hooks/report.mjs   （只读，无需 WorkBuddy 运行）
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.workbuddy', 'wb-ops', 'stats');
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(2) + 'MB' : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B';
const tok = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

let files;
try { files = readdirSync(dir).filter(f => f.endsWith('.json')); }
catch { console.log(`[wb-ops] 无记账目录：${dir}（WB_OPS_STATS 默认开；设 0/off 可关，需发生过压缩）`); process.exit(0); }

const rows = [];
const kinds = {};
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    rows.push({ file: f, calls: j.calls || 0, before: j.before || 0, after: j.after || 0, tokBefore: j.tokBefore || 0, tokAfter: j.tokAfter || 0, tool: j.tool || '?', ts: j.ts || '' });
    for (const [k, v] of Object.entries(j.kinds || {})) {
      const t = kinds[k] = kinds[k] || { calls: 0, before: 0, after: 0, tokBefore: 0, tokAfter: 0 };
      t.calls += v.calls || 0; t.before += v.before || 0; t.after += v.after || 0;
      t.tokBefore += v.tokBefore || 0; t.tokAfter += v.tokAfter || 0;
    }
  } catch { /* 跳过坏文件 */ }
}
if (!rows.length || !rows.reduce((a, r) => a + r.calls, 0)) { console.log('[wb-ops] 还没有记账数据'); process.exit(0); }

const sum = k => rows.reduce((a, r) => a + r[k], 0);
const calls = sum('calls'), before = sum('before'), after = sum('after');
const tokBefore = sum('tokBefore'), tokAfter = sum('tokAfter');
const pct = before ? ((before - after) / before * 100).toFixed(1) : '0.0';
console.log(tokBefore > 0
  ? `[wb-ops 报表] 压缩 ${calls} 次 · 省 ≈${tok(tokBefore - tokAfter)} tok / ${kb(before - after)} (${pct}%) · 原文 ${kb(before)}≈${tok(tokBefore)} tok → 压缩后 ${kb(after)}≈${tok(tokAfter)} tok · 记账会话 ${rows.length} 个`
  : `[wb-ops 报表] 压缩 ${calls} 次 · 原文 ${kb(before)} → 压缩后 ${kb(after)} · 省 ${kb(before - after)} (${pct}%) · 记账会话 ${rows.length} 个`);
const kl = Object.entries(kinds).sort((a, b) => b[1].before - a[1].before);
if (kl.length) console.log('  分类：' + kl.map(([k, v]) => v.tokBefore ? `${k} ${v.calls}次 ≈${tok(v.tokBefore)}→${tok(v.tokAfter)} tok` : `${k} ${v.calls}次 ${kb(v.before)}→${kb(v.after)}`).join(' · '));
rows.sort((a, b) => b.ts.localeCompare(a.ts));
for (const r of rows.slice(0, 20)) console.log(`  ${r.file.replace(/\.json$/, '')}  ${r.calls} 次  ${kb(r.before)}→${kb(r.after)}  最后: ${r.tool} ${String(r.ts).slice(0, 10)}`);
console.log('  口径：token 为估算（与宿主同公式 ceil(中文/1.8)+ceil(其余/4)）；只计本 Mod 实际改写的输出，被裁原文在 ~/.workbuddy/wb-ops/spill/ 可回查。');