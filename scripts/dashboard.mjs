#!/usr/bin/env node
// wb-ops 省量看板：把 ~/.workbuddy/wb-ops/stats/*.json 渲染成一个自包含 HTML，
// 浏览器打开即可看每个会话省了多少 token。
//
// 数据口径与 mcp/server.mjs、hooks/report.mjs 完全同源（lib/report-core.mjs），
// 这里只做聚合展示，不另立一套数字。token 为估算：ceil(中文/1.8)+ceil(其余/4)。
//
// 用法:
//   node scripts/dashboard.mjs                 # 生成 ~/.workbuddy/wb-ops/dashboard.html 并打印路径
//   node scripts/dashboard.mjs --open          # 生成后用默认浏览器打开
//   node scripts/dashboard.mjs --serve [端口]  # 起本地服务（默认 8765），每次刷新重读账本
//   node scripts/dashboard.mjs --out <路径>    # 自定义输出文件（与 --serve 互不干扰）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { collectRows, summarize, fmtBytes, fmtTok, statsDir } from '../lib/report-core.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 会话名解析：读宿主 workbuddy.db 的 sessions 表（id 前 8 位 ↔ stats 文件名）。
 *  零依赖（node:sqlite，Node ≥22.5）；任何失败 → 空表，看板退化为纯 hash 展示，不报错。 */
export function sessionNames(statsDirPath) {
  const out = {};
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(resolve(statsDirPath, '..', '..', 'workbuddy.db'), { readOnly: true });
    for (const r of db.prepare('select id, title, custom_title from sessions').all()) {
      const sid8 = String(r.id || '').slice(0, 8);
      const name = String(r.custom_title || r.title || '').trim();
      if (sid8 && name) out[sid8] = name;
    }
    db.close();
  } catch {}
  return out;
}

/** 会话行 → 展示模型：主口径优先 token，老账本（无 tok 字段）回落字节。
 *  names：sid8 → 会话名（宿主 sessions 表），缺了就纯 hash 展示。 */
export function buildModel(rows, names = {}) {
  const agg = summarize(rows);
  const sessions = rows
    .map((r) => {
      const useTok = (r.tokBefore || 0) > 0;
      const base = useTok ? r.tokBefore : r.before;
      const kept = useTok ? r.tokAfter : r.after;
      const saved = base - kept;
      const sid = r.file.replace(/\.json$/, '');
      return {
        ...r,
        useTok,
        sid,
        name: names[sid] || '',
        base, kept, saved,
        pct: base ? (saved / base) * 100 : 0,
        kinds: Object.entries(r.kinds || {}).sort((a, b) => ((b[1].tokBefore || b[1].before) - (a[1].tokBefore || a[1].before))),
      };
    })
    .sort((a, b) => b.saved - a.saved || (b.ts || '').localeCompare(a.ts || ''));
  const totalBase = agg.tokBefore || agg.before;
  const totalKept = agg.tokBefore ? agg.tokAfter : agg.after;
  const maxBase = Math.max(1, ...sessions.map((s) => s.base));
  return { agg, sessions, totalBase, totalSaved: totalBase - totalKept, totalPct: totalBase ? ((totalBase - totalKept) / totalBase) * 100 : 0, maxBase };
}

const fmtNum = (n, tok) => (tok ? '≈' + fmtTok(n) + ' tok' : fmtBytes(n));

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return esc(String(ts).slice(0, 16));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sessionCard(s, maxBase) {
  const wBase = Math.max(1.5, (s.base / maxBase) * 100);
  const wKept = s.base ? (s.kept / s.base) * wBase : 0;
  const chips = s.kinds
    .map(([k, v]) => {
      const vt = (v.tokBefore || 0) > 0;
      const b = vt ? v.tokBefore : v.before, a = vt ? v.tokAfter : v.after;
      return `<span class="chip">${esc(k)} ×${v.calls} · ${fmtNum(b, vt)}→${fmtNum(a, vt)}（省 ${b ? Math.round(((b - a) / b) * 100) : 0}%）</span>`;
    })
    .join('');
  return `<div class="card">
  <div class="row">${s.name ? `<b class="sname">${esc(s.name)}</b><span class="sid dim">${esc(s.sid)}</span>` : `<b class="sid">${esc(s.sid)}</b>`}<span class="meta">${fmtTs(s.ts)} · ${s.calls} 次压缩 · 最后 ${esc(s.tool)}</span>
    <span class="saved">省 <b>${fmtNum(s.saved, s.useTok)}</b> (${s.pct.toFixed(0)}%)</span></div>
  <div class="bar"><div class="seg all" style="width:${wBase.toFixed(1)}%" title="原文 ${fmtNum(s.base, s.useTok)}"><div class="seg kept" style="width:${(s.base ? (s.kept / s.base) * 100 : 0).toFixed(1)}%" title="压缩后 ${fmtNum(s.kept, s.useTok)}"></div></div></div>
  <div class="legend">原文 ${fmtNum(s.base, s.useTok)} → 压缩后 ${fmtNum(s.kept, s.useTok)}（深色=留在上下文，浅色=省掉）${s.useTok ? '' : ' · 旧账本无 tok 字段，按字节'}</div>
  <div class="chips">${chips}</div>
</div>`;
}

export function renderHtml(model, meta = {}) {
  const { agg, sessions, totalSaved, totalPct, maxBase } = model;
  const tokFirst = agg.tokBefore > 0;
  const head = tokFirst
    ? `累计省 <b>≈${fmtTok(totalSaved)} tok</b>（${totalPct.toFixed(1)}%） · 原文 ≈${fmtTok(agg.tokBefore)} tok → 压缩后 ≈${fmtTok(agg.tokAfter)} tok`
    : `累计省 <b>${fmtBytes(totalSaved)}</b>（${totalPct.toFixed(1)}%） · 原文 ${fmtBytes(agg.before)} → 压缩后 ${fmtBytes(agg.after)}`;
  const body = sessions.length
    ? sessions.map((s) => sessionCard(s, maxBase)).join('\n')
    : `<div class="card empty">还没有记账数据。WB_OPS_STATS 默认开（设 0/off 关）；先让 wb 里发生一次超预算的工具输出，再刷新本页。</div>`;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>wb-ops 省量看板</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:#101418;color:#dfe6ee;font:14px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
h1{font-size:19px;margin:0 0 2px}
.sub{color:#8a97a5;font-size:12px;margin-bottom:14px}
.totals{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.totals .t{background:#171d24;border:1px solid #232c36;border-radius:10px;padding:10px 16px}
.totals .t b{display:block;font-size:18px;color:#6fd08c}
.totals .t.head{flex:1 1 100%;font-size:15px;color:#dfe6ee;background:#141a20}
.totals .t.head b{display:inline;font-size:17px}
.card{background:#171d24;border:1px solid #232c36;border-radius:10px;padding:12px 16px;margin-bottom:10px}
.row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.sid{font-family:Consolas,monospace;font-size:15px}
.sname{font-size:15px}
.sid.dim{font-size:12px;color:#66717c;font-weight:400}
.meta{color:#8a97a5;font-size:12px;flex:1}
.saved{color:#6fd08c;font-size:14px}
.saved b{font-size:16px}
.bar{height:16px;margin:8px 0 4px;border-radius:4px;background:#1d232b;overflow:hidden}
.seg.all{height:100%;background:#2f7d46;border-radius:4px;display:flex;align-items:center}
.seg.kept{height:100%;background:#7fc98f;border-radius:4px 0 0 4px}
.legend{color:#8a97a5;font-size:12px}
.chips{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.chip{background:#20282f;border:1px solid #2c3742;border-radius:20px;padding:2px 10px;font-size:12px;color:#b7c2cd}
.empty{text-align:center;color:#8a97a5;padding:32px}
.foot{color:#66717c;font-size:12px;margin-top:18px}
code{background:#20282f;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>wb-ops 省量看板</h1>
<div class="sub">生成于 ${esc(meta.generatedAt || '')} · 数据 <code>${esc(meta.dir || '')}</code>${meta.serve ? ' · serve 模式：刷新即重读账本' : ' · 重跑 <code>node scripts/dashboard.mjs --open</code> 更新'}</div>
<div class="totals">
  <div class="t head">${head}</div>
  <div class="t"><b>${sessions.length}</b>记账会话</div>
  <div class="t"><b>${agg.calls}</b>压缩次数</div>
  <div class="t"><b>${fmtBytes(agg.before)}</b>原文字节</div>
  <div class="t"><b>${fmtBytes(agg.after)}</b>压缩后字节</div>
</div>
${body}
<div class="foot">口径：token 为估算（与宿主 TokenUtils 同公式 ceil(中文/1.8)+ceil(其余/4)），只计 wb-ops Mod 实际改写的工具输出；模型回复、用户输入、系统提示不在内。被裁原文在 <code>${esc((meta.dir || '').replace(/[\\/]stats$/, ''))}/spill/</code> 可回查。</div>
</body></html>`;
}

function page() {
  const dir = statsDir();
  return renderHtml(buildModel(collectRows(), sessionNames(dir)), { generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }), dir });
}

// ---------------- CLI（被 import 时不执行） ----------------
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const argv = process.argv.slice(2);
  const serveIdx = argv.indexOf('--serve');
  if (serveIdx >= 0) {
    const port = Number(argv[serveIdx + 1] || 8765) || 8765;
    const { createServer } = await import('node:http');
    createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page()); }).listen(port, '127.0.0.1', () => console.log(`wb-ops dashboard: http://127.0.0.1:${port}`));
  } else {
    const outIdx = argv.indexOf('--out');
    const out = outIdx >= 0 && argv[outIdx + 1] ? resolve(argv[outIdx + 1]) : join(homedir(), '.workbuddy', 'wb-ops', 'dashboard.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, page());
    console.log(out);
    if (argv.includes('--open')) spawn('cmd', ['/c', 'start', '', out], { stdio: 'ignore', detached: true }).unref();
  }
}
