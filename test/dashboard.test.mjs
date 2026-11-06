// dashboard.mjs 单测：buildModel 聚合口径 + renderHtml 渲染与转义。
// 与 register.test.ts 分开跑：node --test test/dashboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildModel, renderHtml, sessionNames, timelineChart } from '../scripts/dashboard.mjs';

const row = (o) => ({ file: 'x.json', calls: 1, before: 0, after: 0, tokBefore: 0, tokAfter: 0, tool: 'shell', ts: '2026-11-05T10:00:00.000Z', kinds: {}, ...o });

test('buildModel：token 口径优先，按省量降序', () => {
  const m = buildModel([
    row({ file: 'a.json', calls: 13, before: 123335, after: 47032, tokBefore: 30143, tokAfter: 11420, kinds: { shell: { calls: 12, before: 92843, after: 41313, tokBefore: 22574, tokAfter: 10009 }, other: { calls: 1, before: 30492, after: 5719, tokBefore: 7569, tokAfter: 1411 } } }),
    row({ file: 'b.json', calls: 6, before: 166173, after: 16505, tokBefore: 41356, tokAfter: 4007 }),
  ]);
  assert.equal(m.sessions[0].sid, 'b'); // 省 37349 > 省 18723
  assert.equal(m.sessions[0].saved, 41356 - 4007);
  assert.equal(m.sessions[0].pct.toFixed(0), '90');
  assert.ok(m.totalSaved > 50000 && m.maxBase === 41356);
  assert.equal(m.sessions[0].useTok, true);
});

test('buildModel：老账本无 tok 字段回落字节口径', () => {
  const m = buildModel([row({ file: 'c.json', before: 10000, after: 4000 })]);
  assert.equal(m.sessions[0].useTok, false);
  assert.equal(m.sessions[0].saved, 6000);
  assert.equal(m.sessions[0].pct.toFixed(0), '60');
});

test('buildModel：kinds 按原文量降序排列', () => {
  const m = buildModel([row({ kinds: { glob: { calls: 1, before: 100, after: 50, tokBefore: 25, tokAfter: 12 }, shell: { calls: 2, before: 900, after: 300, tokBefore: 225, tokAfter: 75 } } })]);
  assert.deepEqual(m.sessions[0].kinds.map(([k]) => k), ['shell', 'glob']);
});

test('renderHtml：空账本给引导文案不崩', () => {
  const html = renderHtml(buildModel([]), { dir: 'C:/tmp/stats' });
  assert.match(html, /还没有记账数据/);
  assert.match(html, /wb-ops 省量看板/);
});

test('renderHtml：token 头行与卡片内容', () => {
  const html = renderHtml(buildModel([row({ file: 'b.json', calls: 6, before: 166173, after: 16505, tokBefore: 41356, tokAfter: 4007, tool: 'other' })]), { generatedAt: '2026-11-05 21:30:00', dir: 'C:/tmp/stats' });
  assert.match(html, /累计省 <b>≈37\.3k tok<\/b>（90\.3%）/);
  assert.match(html, /<b class="sid">b<\/b>/);
  assert.match(html, /6 次压缩 · 最后 other/);
  assert.match(html, /spill\//); // 回查指路
});

test('renderHtml：sid/tool/kind 全部 HTML 转义', () => {
  const evil = '<script>alert(1)</script>';
  const html = renderHtml(buildModel([row({ file: 'e<img>.json', tool: evil, kinds: { [evil]: { calls: 1, before: 5, after: 1 } } })]), {});
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.match(/class="sid">e<img>/));
});

test('buildModel：names 命中给会话名，未命中留空', () => {
  const m = buildModel([row({ file: 'aa112233.json', before: 100, after: 40 }), row({ file: 'bb445566.json', before: 90, after: 30 })], { aa112233: '重新验收已定位项目' });
  assert.equal(m.sessions.find((s) => s.sid === 'aa112233').name, '重新验收已定位项目');
  assert.equal(m.sessions.find((s) => s.sid === 'bb445566').name, '');
});

test('renderHtml：有名卡片=名称主导+hash 弱化；无名卡片仍纯 hash；名称转义', () => {
  const html = renderHtml(buildModel([row({ file: 'aa112233.json', before: 100, after: 40 }), row({ file: 'cc<img>.json', before: 80, after: 30 })], { aa112233: '<b>坏名称</b>', cc: '不该命中' }), {});
  assert.match(html, /<b class="sname">&lt;b&gt;坏名称&lt;\/b&gt;<\/b><span class="sid dim">aa112233<\/span>/);
  assert.match(html, /<b class="sid">cc&lt;img&gt;<\/b>/); // 无名字段：走 sid 分支（转义在别处钉）
  assert.ok(!html.includes('<b class="sname">不该命中'));
});

test('sessionNames：真 sqlite 临时库解析；坏路径/缺表 → 空表不抛', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'wbops-names-'));
  const stats = join(dir, 'wb-ops', 'stats');
  mkdirSync(stats, { recursive: true });
  const db = new DatabaseSync(join(dir, 'workbuddy.db'));
  db.exec('create table sessions (id text, title text, custom_title text)');
  db.prepare('insert into sessions values (?,?,?)').run('aa112233-0000-0000-0000-000000000000', '自动标题', null);
  db.prepare('insert into sessions values (?,?,?)').run('bb224466-0000-0000-0000-000000000000', '自动标题', '用户改名');
  db.prepare('insert into sessions values (?,?,?)').run('cc335577-0000-0000-0000-000000000000', null, null);
  db.close();
  const names = sessionNames(stats);
  assert.deepEqual(names, { aa112233: '自动标题', bb224466: '用户改名' }); // custom_title 优先；空名丢弃
  assert.deepEqual(sessionNames(join(dir, 'nope', 'wb-ops', 'stats')), {}); // db 不存在 → 空表（../.. 必须落到没有 workbuddy.db 的目录）
  rmSync(dir, { recursive: true, force: true });
});

// ---------------- v0.16：模型维度 + 时间轴详情 ----------------

test('buildModel v0.16：events 透传过滤坏条目，models 跨会话聚合按 base 降序', () => {
  const m = buildModel([
    row({ file: 'a.json', tokBefore: 600, tokAfter: 150,
      models: { 'glm-4.6': { calls: 2, tokBefore: 500, tokAfter: 120 }, 'deepseek-v4': { calls: 1, tokBefore: 100, tokAfter: 30 } },
      events: [{ t: 1, k: 'shell', m: 'glm-4.6', tb: 400, ta: 90 }, { t: 2, k: 'read', m: 'deepseek-v4', tb: 100, ta: 30 }, { t: 3, k: 'bad' }] }),
    row({ file: 'b.json', tokBefore: 1000, tokAfter: 200,
      models: { 'glm-4.6': { calls: 1, tokBefore: 1000, tokAfter: 200 } },
      events: [{ t: 4, k: 'shell', m: 'glm-4.6', tb: 1000, ta: 200 }] }),
  ]);
  assert.equal(m.sessions[0].sid, 'b'); // 仍按省量降序
  assert.equal(m.sessions[0].events.length, 1);
  assert.equal(m.sessions.find((s) => s.sid === 'a').events.length, 2, '坏事件（缺 tb/ta）被过滤');
  assert.deepEqual(m.models.map((x) => x.model), ['glm-4.6', 'deepseek-v4']);
  assert.equal(m.models[0].calls, 3);
  assert.equal(m.models[0].base, 1500);
  assert.equal(Math.round(m.models[0].pct), 79);
});

test('timelineChart：<2 事件返回空串；SVG 折线 + 悬停 tooltip + 模型名转义', () => {
  assert.equal(timelineChart([]), '');
  assert.equal(timelineChart([{ t: 1, k: 'shell', m: 'x', tb: 100, ta: 10 }]), '');
  const svg = timelineChart([
    { t: 1730000000000, k: 'shell', m: 'a<b>', tb: 400, ta: 90 },
    { t: 1730000060000, k: 'read', m: 'glm', tb: 100, ta: 30 },
  ]);
  assert.match(svg, /<svg /);
  assert.match(svg, /polyline/g);
  assert.match(svg, /a&lt;b&gt;/, 'tooltip 里模型名转义');
  assert.match(svg, /<title>/);
});

test('renderHtml v0.16：首页按模型累计块；旧账本 → 空态提示不报错', () => {
  const html = renderHtml(buildModel([
    row({ file: 'a.json', tokBefore: 500, tokAfter: 120,
      models: { 'glm-4.6': { calls: 2, tokBefore: 500, tokAfter: 120 } },
      events: [{ t: 1, k: 'shell', m: 'glm-4.6', tb: 400, ta: 90 }, { t: 2, k: 'read', m: 'glm-4.6', tb: 100, ta: 30 }] }),
  ]));
  assert.match(html, /按模型累计（全史）/);
  assert.match(html, /glm-4\.6/);
  assert.match(html, /<svg /, '会话详情内时间轴图');
  assert.match(html, /时间轴详情/);
  const old = renderHtml(buildModel([row({ file: 'b.json', tokBefore: 300, tokAfter: 100 })]));
  assert.match(old, /按模型汇总暂无数据/, '无 models 维度 → 如实说明');
  assert.match(old, /账本没有事件数据/, '无 events → 如实说明');
});

// ---------------- 回归钉：collectRows 必须透传 events/models ----------------
// 上面所有 buildModel 测试都是手工喂 row() 对象——恰好绕过了真实读取路径。
// v0.16 起看板消费 events/models，但 collectRows 从未透传过这两个字段
// （时间轴与模型汇总在真实数据上一直是坏的，单测全绿掩盖了它）。
// 这个测试从**临时目录里的真实 JSON 文件**读，钉死 文件 → collectRows → buildModel 全链路。

test('collectRows → buildModel 全链路：账本文件里的 events/models 必须到达看板（回归钉）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'wbops-rows-'));
  writeFileSync(join(dir, 'aa112233.json'), JSON.stringify({
    calls: 2, before: 9000, after: 2000, tokBefore: 2200, tokAfter: 500,
    tool: 'shell', ts: '2026-11-06T08:00:00.000Z',
    kinds: { shell: { calls: 2, before: 9000, after: 2000, tokBefore: 2200, tokAfter: 500 } },
    models: { 'glm-5.3-flash': { calls: 2, before: 9000, after: 2000, tokBefore: 2200, tokAfter: 500 } },
    events: [
      { t: 1730000000000, k: 'shell', m: 'glm-5.3-flash', tb: 1200, ta: 300 },
      { t: 1730000060000, k: 'read', m: 'glm-5.3-flash', tb: 1000, ta: 200 },
    ],
  }));
  const { collectRows } = await import('../lib/report-core.mjs');
  const rows = collectRows(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].events.length, 2, 'collectRows 必须透传 events');
  assert.equal(rows[0].models['glm-5.3-flash'].calls, 2, 'collectRows 必须透传 models');
  const m = buildModel(rows);
  assert.equal(m.sessions[0].events.length, 2, '时间轴数据必须到达展示模型');
  assert.deepEqual(m.models.map((x) => x.model), ['glm-5.3-flash'], '模型汇总必须非空');
  const html = renderHtml(m, { dir });
  assert.match(html, /<svg /, '真实账本必须渲染出时间轴图');
  assert.ok(!html.includes('按模型汇总暂无数据'), '有 models 数据时不得出现空态文案');
  assert.ok(!html.includes('账本没有事件数据'), '有 events 数据时不得出现空态文案');
  rmSync(dir, { recursive: true, force: true });
});

test('collectRows：老账本无 events/models 字段 → 空数组/空对象，看板走空态不崩', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'wbops-old-'));
  writeFileSync(join(dir, 'old00001.json'), JSON.stringify({
    calls: 1, before: 500, after: 300, tool: 'shell', ts: '2026-11-05T10:00:00.000Z', kinds: {},
  }));
  const { collectRows } = await import('../lib/report-core.mjs');
  const rows = collectRows(dir);
  assert.deepEqual(rows[0].events, []);
  assert.deepEqual(rows[0].models, {});
  const html = renderHtml(buildModel(rows), { dir });
  assert.match(html, /账本没有事件数据/); // 如实空态
  rmSync(dir, { recursive: true, force: true });
});
