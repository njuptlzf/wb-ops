// wb-ops 报表核心：聚合 ~/.workbuddy/wb-ops/stats/*.json 并渲染成文本。
//
// 为什么单独一层：v0.14 起报表工具走**插件声明的 MCP 服务器**（mcp/server.mjs），
// 而 hooks/report.mjs 是同一份数据的 CLI 出口。两者必须是同一份口径，否则
// 「工具里看到的」和「命令行看到的」会漂——所以聚合与渲染只在这里实现一次。
//
// token 口径：与 register.ts 的标记行、宿主 TokenUtils 同公式
//   ceil(中文/1.8) + ceil(其余/4)，只计本 Mod 实际改写的输出。
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 记账目录：<home>/.workbuddy/wb-ops/stats（home 与 mod 侧 readCfg 同源：USERPROFILE 优先）。 */
export function statsDir(env = process.env) {
  const home = env.WB_OPS_HOME || env.USERPROFILE || env.HOME || homedir();
  return join(home, '.workbuddy', 'wb-ops', 'stats');
}

export function fmtBytes(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(2) + 'MB' : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B';
}

export function fmtTok(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

/**
 * 读目录 → 行。坏 JSON 单条跳过（记账文件是并发写的，可能被读到半截）。
 * 目录不存在返回 []（首次使用/记账关闭）。
 */
export function collectRows(dir = statsDir()) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files.slice(0, 500)) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      rows.push({
        file: f,
        calls: j.calls || 0,
        before: j.before || 0,
        after: j.after || 0,
        tokBefore: j.tokBefore || 0,
        tokAfter: j.tokAfter || 0,
        tool: j.tool || '?',
        ts: j.ts || '',
        kinds: j.kinds || {},
        // v0.16 看板消费字段——此处曾漏透传，导致时间轴/模型汇总整体退化为空态
        // （账本没坏，是读链路坏）。新增单测钉死这条真实读取路径。
        events: Array.isArray(j.events) ? j.events : [],
        models: j.models && typeof j.models === 'object' ? j.models : {},
      });
    } catch {
      /* 坏文件跳过 */
    }
  }
  return rows;
}

export function summarize(rows) {
  let calls = 0, before = 0, after = 0, tokBefore = 0, tokAfter = 0;
  const kinds = {};
  for (const r of rows) {
    calls += r.calls || 0;
    before += r.before || 0;
    after += r.after || 0;
    tokBefore += r.tokBefore || 0;
    tokAfter += r.tokAfter || 0;
    for (const [k, v] of Object.entries(r.kinds || {})) {
      const t = (kinds[k] = kinds[k] || { calls: 0, before: 0, after: 0, tokBefore: 0, tokAfter: 0 });
      t.calls += v.calls || 0;
      t.before += v.before || 0;
      t.after += v.after || 0;
      t.tokBefore += v.tokBefore || 0;
      t.tokAfter += v.tokAfter || 0;
    }
  }
  return { calls, before, after, tokBefore, tokAfter, kinds };
}

export const EMPTY_TEXT = '[wb-ops] 还没有记账数据（WB_OPS_STATS 默认开；需先发生过一次压缩）';

export function renderSummary(rows) {
  const agg = summarize(rows);
  if (!agg.calls) return EMPTY_TEXT;
  const saved = agg.before - agg.after;
  const pct = agg.before ? ((saved / agg.before) * 100).toFixed(1) : '0.0';
  const kb = fmtBytes;
  const kindList = Object.entries(agg.kinds).sort((a, b) => b[1].before - a[1].before);
  const kindFmt = ([k, v]) =>
    v.tokBefore
      ? `${k} ${v.calls}次 ≈${fmtTok(v.tokBefore)}→${fmtTok(v.tokAfter || 0)} tok`
      : `${k} ${v.calls}次 ${kb(v.before)}→${kb(v.after)}`;
  const lines = [
    agg.tokBefore > 0
      ? `[wb-ops 报表] 压缩 ${agg.calls} 次 · 省 ≈${fmtTok(agg.tokBefore - agg.tokAfter)} tok / ${kb(saved)} (${pct}%) · 原文 ${kb(agg.before)}≈${fmtTok(agg.tokBefore)} tok → 压缩后 ${kb(agg.after)}≈${fmtTok(agg.tokAfter)} tok · 记账会话 ${rows.length} 个`
      : `[wb-ops 报表] 压缩 ${agg.calls} 次 · 原文 ${kb(agg.before)} → 压缩后 ${kb(agg.after)} · 省 ${kb(saved)} (${pct}%) · 记账会话 ${rows.length} 个`,
    ...(kindList.length ? ['  分类：' + kindList.map(kindFmt).join(' · ')] : []),
    ...rows
      .slice()
      .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
      .slice(0, 12)
      .map((r) => `  ${r.file.replace(/\.json$/, '')}  ${r.calls} 次  ${kb(r.before)}→${kb(r.after)}  最后: ${r.tool || '?'} ${r.ts ? r.ts.slice(0, 10) : ''}`),
    '  口径：token 为估算（与宿主同公式 ceil(中文/1.8)+ceil(其余/4)）；只计本 Mod 实际改写的输出，被裁原文在 ~/.workbuddy/wb-ops/spill/ 可回查。',
  ];
  return lines.join('\n');
}
