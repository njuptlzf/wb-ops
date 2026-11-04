#!/usr/bin/env node
// wb-ops 节省报表 CLI 版：聚合 ~/.workbuddy/wb-ops/stats/*.json（会话内请用 mcp__*__report 工具）
// 用法: node hooks/report.mjs   （只读，无需 WorkBuddy 运行）
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.workbuddy', 'wb-ops', 'stats');
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(2) + 'MB' : (n / 1024).toFixed(1) + 'KB';

let files;
try { files = readdirSync(dir).filter(f => f.endsWith('.json')); }
catch { console.log(`[wb-ops] 无记账目录：${dir}（需要 WB_OPS_STATS=1 且发生过压缩）`); process.exit(0); }

const rows = [];
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    rows.push({ file: f, calls: j.calls || 0, before: j.before || 0, after: j.after || 0, tool: j.tool || '?', ts: j.ts || '' });
  } catch { /* 跳过坏文件 */ }
}
if (!rows.length || !rows.reduce((a, r) => a + r.calls, 0)) { console.log('[wb-ops] 还没有记账数据'); process.exit(0); }

const calls = rows.reduce((a, r) => a + r.calls, 0);
const before = rows.reduce((a, r) => a + r.before, 0);
const after = rows.reduce((a, r) => a + r.after, 0);
const pct = before ? ((before - after) / before * 100).toFixed(1) : '0.0';
console.log(`[wb-ops 报表] 压缩 ${calls} 次 · 原文 ${kb(before)} → 压缩后 ${kb(after)} · 省 ${kb(before - after)} (${pct}%) · 记账会话 ${rows.length} 个`);
rows.sort((a, b) => b.ts.localeCompare(a.ts));
for (const r of rows.slice(0, 20)) console.log(`  ${r.file.replace(/\.json$/, '')}  ${r.calls} 次  ${kb(r.before)}→${kb(r.after)}  最后: ${r.tool} ${String(r.ts).slice(0, 10)}`);
console.log('  口径：只计本 Mod 实际改写的输出；被裁原文在 ~/.workbuddy/wb-ops/spill/ 可回查。');
