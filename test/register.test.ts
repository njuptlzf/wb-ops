/**
 * wb-bash-ops 离线单测：node --test test/
 * 用 mock 的 $（env/fs/session）驱动 register()，验证透传/压缩/落盘/并发/fail-open。
 * 不依赖 WorkBuddy——宿主真实行为另见 README「待在线验证」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register, compress, extractText, exitCodeOf } from '../hooks/register.ts';

function harness(opts: { env?: Record<string, string>; writeFail?: boolean } = {}) {
  const writes: { path: string; text: string }[] = [];
  const handlers: Array<($: any, e: any, next: any) => Promise<any>> = [];
  register(((_ev: string, _m: any, h: any) => { handlers.push(h); }) as any);
  const $ = {
    env: { get: async (k: string) => opts.env?.[k] },
    fs: {
      write: async (p: string, t: string) => {
        if (opts.writeFail) throw new Error('disk on fire');
        writes.push({ path: p, text: t });
      },
    },
    session: { id: async () => 'deadbeef-0000-1111' },
  };
  const call = async (result: unknown, event: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const r = { result, ...extra };
    const out = await handlers[0]($, { tool: 'Bash', input: { command: 'npm test' }, callId: 'c1', ...event }, async () => r);
    return { r, out };
  };
  return { $, writes, call };
}

const HOME = { USERPROFILE: 'C:/tmp-home' };

function bigText(n = 3000): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`ok ${i} ${'pad'.repeat(30)}`);
  lines[Math.floor(n / 2)] = 'ERROR: something exploded in module Y';
  return 'Command: npm test\n\nStdout:\n' + lines.join('\n') + '\n\nStderr:\nExit Code: 0';
}

test('低于预算透传（同一对象返回）', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.call('Command: ls\n\na\nb\n\nExit Code: 0');
  assert.equal(out, r);
  assert.equal(h.writes.length, 0);
});

test('超预算：压缩 + 落盘 + 关键行保留', async () => {
  const h = harness({ env: HOME });
  const raw = bigText();
  const { out } = await h.call(raw);
  const got = (out as any).result as string;
  assert.ok(got.includes('[wb-bash-ops]'), '有标记');
  assert.ok(got.includes('Command: npm test'), '头部保留');
  assert.ok(got.includes('ERROR: something exploded in module Y'), '强关键词行保留');
  assert.ok(got.includes('Exit Code: 0'), '尾部退出码保留');
  assert.ok(got.length < raw.length / 2, '确实省了（>50%）');
  assert.ok(got.length <= 8000 + 600 + 100, '预算上限内');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].text, raw, '落盘的是完整原文');
  assert.match(h.writes[0].path, /C:\/tmp-home\/\.workbuddy\/wb-bash-ops\/spill\/deadbeef\/\d+-c1\.txt$/);
  assert.ok(got.includes(h.writes[0].path), '标记里给出回查路径');
});

test('非零退出码：完整透传，不落盘不压缩', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.call(bigText().replace('Exit Code: 0', 'Exit Code: 2'));
  assert.equal(out, r);
  assert.equal(h.writes.length, 0, '错误输出白白落盘=磁盘垃圾，必须避免');
});

test('isError：透传', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.call(bigText(), {}, { isError: true });
  assert.equal(out, r);
});

test('双压缩防护：已带自身或 wb-ops 标记的文本透传', async () => {
  const h = harness({ env: HOME });
  const a = await h.call('[wb-bash-ops] 已省略 3 行\n' + bigText());
  assert.equal(a.out, a.r);
  const b = await h.call('[wb-ops] trimmed\n' + bigText());
  assert.equal(b.out, b.r);
});

test('落盘失败：仍压缩，但标记如实说明未保留', async () => {
  const h = harness({ env: HOME, writeFail: true });
  const { out } = await h.call(bigText());
  const got = (out as any).result as string;
  assert.ok(got.includes('未落盘'), '不给假路径');
  assert.ok(got.includes('[wb-bash-ops] 已省略'));
});

test('WB_BASH_OPS=0：全局关闭', async () => {
  const h = harness({ env: { ...HOME, WB_BASH_OPS: '0' } });
  const { r, out } = await h.call(bigText());
  assert.equal(out, r);
});

test('软超时 deadlineMs=0：放弃压缩，透传原文', async () => {
  const h = harness({ env: { ...HOME, WB_BASH_OPS_DEADLINE_MS: '0' } });
  const { r, out } = await h.call(bigText());
  assert.equal(out, r);
});

test('自定义预算生效', async () => {
  const h = harness({ env: { ...HOME, WB_BASH_OPS_BUDGET: '2000' } });
  const { out } = await h.call(bigText());
  assert.ok(((out as any).result as string).length <= 2000 + 700);
});

test('content 数组形状保持替换', async () => {
  const h = harness({ env: HOME });
  const shaped = { content: [{ type: 'text', text: bigText() }], other: 42 };
  const { out } = await h.call(shaped);
  const got = (out as any).result;
  assert.equal(got.other, 42, '未触碰字段保留');
  assert.equal(got.content.length, 1);
  assert.equal(got.content[0].type, 'text');
  assert.ok(got.content[0].text.includes('[wb-bash-ops]'));
});

test('并发 50 次：spill 路径互不覆盖', async () => {
  const writes: string[] = [];
  const handlers: any[] = [];
  register(((_ev: unknown, _m: unknown, h: any) => { handlers.push(h); }) as any);
  const $ = {
    env: { get: async (k: string) => k === 'USERPROFILE' ? 'C:/tmp-home' : undefined },
    fs: { write: async (p: string) => { writes.push(p); } },
    session: { id: async () => 'sess0001-aaaa' },
  };
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    handlers[0]($, { tool: 'Bash', callId: 'same-call' }, async () => ({ result: bigText() }))
  ));
  assert.equal(new Set(writes).size, 50, '同名 callId 也靠序号去重');
});

test('核心纯函数边界', () => {
  assert.equal(exitCodeOf(['a', 'Exit Code: 7']), 7);
  assert.equal(exitCodeOf(['a']), null);
  assert.equal(compress('short', 8000, 100, null), null, '低于预算不压');
  assert.equal(compress(bigText(), 8000, 100, null)!.text.includes('未落盘'), true);
  assert.equal(extractText({ content: [{ text: 'a' }, { text: 'b' }] }), null, '多 text 块=未知形状透传');
  assert.equal(extractText(42), null);
});
