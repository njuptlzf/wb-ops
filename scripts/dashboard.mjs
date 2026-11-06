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

/** 会话元信息解析：读宿主 workbuddy.db 的 sessions 表（id 前 8 位 ↔ stats 文件名）。
 *  返回 sid8 → { name, archived }。archived = status='archived' 或已删除（deleted_at 非空）。
 *  零依赖（node:sqlite，Node ≥22.5）；任何失败 → 空表，看板退化为纯 hash 展示 + 全部按未归档处理，不报错。 */
export function sessionNames(statsDirPath) {
  const out = {};
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(resolve(statsDirPath, '..', '..', 'workbuddy.db'), { readOnly: true });
    for (const r of db.prepare('select id, title, custom_title, status, deleted_at from sessions').all()) {
      const sid8 = String(r.id || '').slice(0, 8);
      if (!sid8) continue;
      const name = String(r.custom_title || r.title || '').trim();
      const archived = String(r.status || '') === 'archived' || r.deleted_at != null;
      out[sid8] = { name, archived };
    }
    db.close();
  } catch {}
  return out;
}

/** 会话行 → 展示模型：主口径优先 token，老账本（无 tok 字段）回落字节。
 *  names：sid8 → { name, archived }（宿主 sessions 表），缺了就纯 hash 展示、按未归档处理。
 *  v0.16：透传 events（逐压缩事件流，详情页时间轴）与 models（按模型累计，首页汇总）。 */
export function buildModel(rows, names = {}) {
  const agg = summarize(rows);
  const sessions = rows
    .map((r) => {
      const useTok = (r.tokBefore || 0) > 0;
      const base = useTok ? r.tokBefore : r.before;
      const kept = useTok ? r.tokAfter : r.after;
      const saved = base - kept;
      const sid = r.file.replace(/\.json$/, '');
      const meta = names[sid] || {};
      const events = Array.isArray(r.events)
        ? r.events.filter((e) => e && Number.isFinite(e.tb) && Number.isFinite(e.ta))
        : [];
      return {
        ...r,
        useTok,
        sid,
        name: meta.name || '',
        archived: !!meta.archived,
        base, kept, saved,
        pct: base ? (saved / base) * 100 : 0,
        kinds: Object.entries(r.kinds || {}).sort((a, b) => ((b[1].tokBefore || b[1].before) - (a[1].tokBefore || a[1].before))),
        events,
        models: r.models && typeof r.models === 'object' ? r.models : {},
      };
    })
    .sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || b.saved - a.saved || (b.ts || '').localeCompare(a.ts || '')); // 归档会话沉底
  const totalBase = agg.tokBefore || agg.before;
  const totalKept = agg.tokBefore ? agg.tokAfter : agg.after;
  const maxBase = Math.max(1, ...sessions.map((s) => s.base));
  // 首页按模型汇总：跨会话合并 models（v0.16 起才有；旧账本贡献为空）
  const mAgg = {};
  for (const s of sessions) {
    for (const [m, v] of Object.entries(s.models)) {
      const a = mAgg[m] = mAgg[m] || { model: m, calls: 0, before: 0, after: 0, tokBefore: 0, tokAfter: 0 };
      a.calls += v.calls || 0; a.before += v.before || 0; a.after += v.after || 0;
      a.tokBefore += v.tokBefore || 0; a.tokAfter += v.tokAfter || 0;
    }
  }
  const models = Object.values(mAgg)
    .map((a) => {
      const useTok = a.tokBefore > 0;
      const b = useTok ? a.tokBefore : a.before, k = useTok ? a.tokAfter : a.after;
      return { ...a, useTok, base: b, kept: k, saved: b - k, pct: b ? ((b - k) / b) * 100 : 0 };
    })
    .sort((a, b) => b.base - a.base);
  return { agg, sessions, models, totalBase, totalSaved: totalBase - totalKept, totalPct: totalBase ? ((totalBase - totalKept) / totalBase) * 100 : 0, maxBase };
}

const fmtNum = (n, tok) => (tok ? '≈' + fmtTok(n) + ' tok' : fmtBytes(n));

const MODEL_COLORS = ['#6fd08c', '#e5c07b', '#61afef', '#c678dd', '#e06c75', '#56b6c2', '#98c379', '#d19a66'];
const modelColor = (i) => MODEL_COLORS[i % MODEL_COLORS.length];

/** 详情页时间轴图：x=压缩次序（时间），y=tok。两条折线（原文/压缩后），逐点 tooltip 带时刻+模型。
 *  纯 SVG 字符串（零依赖、快照/serve 通吃）。events < 2 时不出图，如实说明。
 *  v0.18.2：横向滚动模式——每个事件固定占 STEP 宽，事件多时 SVG 变宽、
 *  外层 div 出横向滚动条，页面纵向不再被拉长的同时点也看得清（不再挤成一团）。
 *  事件数由账本封顶 300，SVG 最宽 ≈5.4k px，浏览器无压力。 */
const TL_STEP = 18;
export function timelineChart(events) {
  if (!Array.isArray(events) || events.length < 2) return '';
  const sorted = events.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const H = 220, PAD = { l: 46, r: 14, t: 10, b: 22 };
  const need = PAD.l + PAD.r + TL_STEP * (sorted.length - 1);
  const W = Math.max(760, need); // 事件少铺满窗口；多则加宽横向滚
  const scroll = W > 760;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const max = Math.max(...sorted.map((e) => Math.max(e.tb, e.ta)), 1);
  const x = (i) => PAD.l + (sorted.length === 1 ? iw / 2 : (i / (sorted.length - 1)) * iw);
  const y = (v) => PAD.t + ih - (v / max) * ih;
  const line = (key, color, dash) =>
    `<polyline fill="none" stroke="${color}" stroke-width="1.6"${dash ? ' stroke-dasharray="4 3"' : ''} points="${sorted.map((e, i) => `${x(i).toFixed(1)},${y(e[key]).toFixed(1)}`).join(' ')}"/>`;
  const dots = sorted.map((e, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(e.tb).toFixed(1)}" r="2.4" fill="${colorFor(sorted, e)}"><title>${esc(fmtTs(e.t ? new Date(e.t).toISOString() : ''))} · ${esc(e.k || '?')} · ${esc(e.m || 'unknown')} · ≈${fmtTok(e.tb)}→≈${fmtTok(e.ta)} tok</title></circle>`).join('');
  const grid = [0, 0.5, 1].map((f) => {
    const v = Math.round(max * f);
    return `<line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${y(v).toFixed(1)}" stroke="#232c36"/><text x="${PAD.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#66717c">${fmtTok(v)}</text>`;
  }).join('');
  // 时间刻度：横向滚时每隔几个点标一次（≈最多 8 个标签，避免重叠）；不滚时保持首尾两个。
  const every = scroll ? Math.max(2, Math.ceil(sorted.length / 8)) : sorted.length - 1;
  const xs = sorted
    .map((e, i) => (i % every === 0 || i === sorted.length - 1)
      ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#66717c">${esc(fmtTs(e.t ? new Date(e.t).toISOString() : ''))}</text>`
      : '')
    .join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" ${scroll ? `width="${W}" height="${H}" style="display:block"` : 'width="100%" style="max-width:760px"'} role="img" aria-label="时间轴省量图">
${grid}${line('tb', '#8a97a5', true)}${line('ta', '#6fd08c', false)}${dots}${xs}
<text x="${PAD.l}" y="${PAD.t + 10}" font-size="10" fill="#8a97a5">— 虚线=原文 tok ─ 实线=压缩后 tok（悬停圆点看时刻/工具/模型）</text></svg>`;
  return scroll
    ? `<div class="tlscroll">${svg}</div><div class="legend">横向滚动查看全部 ${sorted.length} 次压缩（每次占 ${TL_STEP}px，不压缩纵向高度）</div>`
    : svg;
}

function colorFor(sorted, e) {
  const models = [...new Set(sorted.map((x) => x.m || 'unknown'))];
  return modelColor(models.indexOf(e.m || 'unknown'));
}

/** 会话详情（卡片内 <details> 展开）：时间轴图 + 按模型小表 + 封顶说明。 */
function sessionDetail(s) {
  if (!s.events.length) {
    return `<div class="legend">逐事件时间轴与模型维度自 v0.16 起记录——这个会话的账本没有事件数据（升级后新发生的压缩才会出现）。</div>`;
  }
  const rows = Object.entries(s.models)
    .map(([m, v]) => {
      const vt = (v.tokBefore || 0) > 0;
      const b = vt ? v.tokBefore : v.before, a = vt ? v.tokAfter : v.after;
      return `<tr><td>${esc(m)}</td><td>${v.calls || 0}</td><td>${fmtNum(b, vt)}</td><td>${fmtNum(a, vt)}</td><td>${b ? Math.round(((b - a) / b) * 100) : 0}%</td></tr>`;
    })
    .join('');
  const capped = s.events.length >= 300 ? '（事件流封顶最近 300 次，更早的只进累计）' : '';
  return `${timelineChart(s.events)}
<table class="mt"><tr><th>模型</th><th>次数</th><th>原文</th><th>压缩后</th><th>省</th></tr>${rows}</table>
<div class="legend">上图按事件时刻排序${capped}；上表是该会话的模型累计（全史）。</div>`;
}

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
  const head = `<div class="row">${s.name ? `<b class="sname">${esc(s.name)}</b><span class="sid dim">${esc(s.sid)}</span>` : `<b class="sid">${esc(s.sid)}</b>`}${s.archived ? '<span class="tag">已归档</span>' : ''}<span class="meta">${fmtTs(s.ts)} · ${s.calls} 次压缩 · 最后 ${esc(s.tool)}</span>
    <span class="saved">省 <b>${fmtNum(s.saved, s.useTok)}</b> (${s.pct.toFixed(0)}%)</span></div>`;
  // 归档会话：整卡折叠成一行摘要（details 默认收起），展开才看完整卡片。
  if (s.archived) {
    return `<details class="card arch"><summary>${head}</summary>
  <div class="bar"><div class="seg all" style="width:${wBase.toFixed(1)}%" title="原文 ${fmtNum(s.base, s.useTok)}"><div class="seg kept" style="width:${(s.base ? (s.kept / s.base) * 100 : 0).toFixed(1)}%" title="压缩后 ${fmtNum(s.kept, s.useTok)}"></div></div></div>
  <div class="legend">原文 ${fmtNum(s.base, s.useTok)} → 压缩后 ${fmtNum(s.kept, s.useTok)}（深色=留在上下文，浅色=省掉）${s.useTok ? '' : ' · 旧账本无 tok 字段，按字节'}</div>
  <div class="chips">${chips}</div>
  <details class="dt"><summary>时间轴详情（v0.16）</summary>${sessionDetail(s)}</details>
</details>`;
  }
  return `<div class="card">
  ${head}
  <div class="bar"><div class="seg all" style="width:${wBase.toFixed(1)}%" title="原文 ${fmtNum(s.base, s.useTok)}"><div class="seg kept" style="width:${(s.base ? (s.kept / s.base) * 100 : 0).toFixed(1)}%" title="压缩后 ${fmtNum(s.kept, s.useTok)}"></div></div></div>
  <div class="legend">原文 ${fmtNum(s.base, s.useTok)} → 压缩后 ${fmtNum(s.kept, s.useTok)}（深色=留在上下文，浅色=省掉）${s.useTok ? '' : ' · 旧账本无 tok 字段，按字节'}</div>
  <div class="chips">${chips}</div>
  <details class="dt"><summary>时间轴详情（v0.16）</summary>${sessionDetail(s)}</details>
</div>`;
}

export function renderHtml(model, meta = {}) {
  const { agg, sessions, models, totalSaved, totalPct, maxBase } = model;
  const tokFirst = agg.tokBefore > 0;
  const head = tokFirst
    ? `累计省 <b>≈${fmtTok(totalSaved)} tok</b>（${totalPct.toFixed(1)}%） · 原文 ≈${fmtTok(agg.tokBefore)} tok → 压缩后 ≈${fmtTok(agg.tokAfter)} tok`
    : `累计省 <b>${fmtBytes(totalSaved)}</b>（${totalPct.toFixed(1)}%） · 原文 ${fmtBytes(agg.before)} → 压缩后 ${fmtBytes(agg.after)}`;
  const body = sessions.length
    ? (() => {
        const active = sessions.filter((s) => !s.archived);
        const arch = sessions.filter((s) => s.archived);
        const parts = active.map((s) => sessionCard(s, maxBase));
        if (arch.length) {
          parts.push(`<div class="archhead">已归档会话（${arch.length} 个，默认折叠）</div>`);
          parts.push(...arch.map((s) => sessionCard(s, maxBase)));
        }
        return parts.join('\n');
      })()
    : `<div class="card empty">还没有记账数据。WB_OPS_STATS 默认开（设 0/off 关）；先让 wb 里发生一次超预算的工具输出，再刷新本页。</div>`;
  // 首页按模型汇总（v0.16）：数据来自各会话 stats 的 models 累计；旧账本没有该维度，如实说明。
  const modelsBlock = models.length
    ? `<div class="card"><div class="row"><b>按模型累计（全史）</b><span class="meta">跨 ${sessions.length} 个会话；与顶部累计的差异 = 旧账本未记模型的量</span></div>
<table class="mt"><tr><th>模型</th><th>次数</th><th>原文</th><th>压缩后</th><th>省</th></tr>${models.map((m) => `<tr><td><span class="dot" style="background:${modelColor(models.indexOf(m))}"></span>${esc(m.model)}</td><td>${m.calls}</td><td>${fmtNum(m.base, m.useTok)}</td><td>${fmtNum(m.kept, m.useTok)}</td><td><b>${m.pct.toFixed(0)}%</b></td></tr>`).join('')}</table></div>`
    : (sessions.length ? `<div class="card empty">按模型汇总暂无数据——模型维度自 v0.16 起记录，现有账本都是旧格式；新会话压缩后刷新即出现。</div>` : '');
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
.mt{border-collapse:collapse;margin:8px 0;font-size:13px}
.mt th,.mt td{border:1px solid #2c3742;padding:3px 10px;text-align:right}
.mt th{background:#20282f;color:#b7c2cd;font-weight:600}
.mt td:first-child{text-align:left}
.mt .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
details.dt{margin-top:10px;border-top:1px dashed #2c3742;padding-top:8px}
details.dt summary{cursor:pointer;color:#61afef;font-size:13px;user-select:none}
details.dt[open] summary{margin-bottom:8px}
.tlscroll{overflow-x:auto;overflow-y:hidden;margin:8px 0;border:1px solid #232c36;border-radius:6px}
.tlscroll::-webkit-scrollbar{height:8px}
.tlscroll::-webkit-scrollbar-thumb{background:#2c3742;border-radius:4px}
.tag{background:#20282f;border:1px solid #2c3742;border-radius:4px;padding:1px 8px;font-size:11px;color:#8a97a5;white-space:nowrap}
details.card.arch{padding:0}
details.card.arch>summary{padding:12px 16px;cursor:pointer;list-style:none}
details.card.arch>summary::-webkit-details-marker{display:none}
details.card.arch>summary::before{content:'▸ ';color:#66717c}
details.card.arch[open]>summary::before{content:'▾ '}
details.card.arch[open]>summary{border-bottom:1px dashed #2c3742}
details.card.arch>div,details.card.arch>details{padding:0 16px}
details.card.arch>details.dt{margin:0 16px 12px}
details.card.arch .bar,details.card.arch .legend,details.card.arch .chips{margin-bottom:8px}
.archhead{color:#66717c;font-size:13px;margin:22px 0 10px;padding-top:12px;border-top:1px dashed #232c36}
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
${modelsBlock}
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
