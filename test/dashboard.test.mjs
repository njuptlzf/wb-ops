// dashboard.mjs 单测：buildModel 聚合口径 + renderHtml 渲染与转义。
// 与 register.test.ts 分开跑：node --test test/dashboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, renderHtml } from '../scripts/dashboard.mjs';

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
