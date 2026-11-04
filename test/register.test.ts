/**
 * wb-ops 离线单测：node --test test/
 * 用 mock 的 $（env/fs/session）驱动 register()，验证透传/压缩/落盘/并发/fail-open/分工具策略。
 * 不依赖 WorkBuddy——宿主真实行为另见 README「待在线验证」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register, compress, compressList, extractText, exitCodeOf, classifyRead, parseJsonList, byteLen, u8Prefix } from '../hooks/register.ts';

function harness(opts: { env?: Record<string, string>; writeFail?: boolean; readFail?: boolean } = {}) {
  const writes: { path: string; text: string }[] = [];
  const reads: string[] = [];
  const byTool: Record<string, ($: any, e: any, next: any) => Promise<any>> = {};
  register(((ev: string, m: any, h: any) => { byTool[m.tool] = h; }) as any);
  const $ = {
    env: { get: async (k: string) => opts.env?.[k] },
    fs: {
      write: async (p: string, t: string) => {
        if (opts.writeFail) throw new Error('disk on fire');
        writes.push({ path: p, text: t });
      },
      read: async (p: string) => {
        reads.push(p);
        if (opts.readFail) throw new Error('no such file');
        const hit = writes.find((w) => w.path === p);
        return hit ? hit.text : undefined;
      },
    },
    session: { id: async () => 'deadbeef-0000-1111' },
  };
  const call = async (tool: string, result: unknown, event: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const r = { result, ...extra };
    const out = await byTool[tool]($, { tool, callId: 'c1', ...event }, async () => r);
    return { r, out };
  };
  const bash = (result: unknown, event: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    call('Bash', result, { input: { command: 'npm test' }, ...event }, extra);
  return { $, writes, reads, call, bash, byTool };
}

const HOME = { USERPROFILE: 'C:/tmp-home' };

function bigText(n = 3000): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`ok ${i} ${'pad'.repeat(30)}`);
  lines[Math.floor(n / 2)] = 'ERROR: something exploded in module Y';
  return 'Command: npm test\n\nStdout:\n' + lines.join('\n') + '\n\nStderr:\nExit Code: 0';
}

function grepJson(n: number, width = 90): string {
  const items = Array.from({ length: n }, (_, i) => `C:\\repo\\src\\module${i}\\file${i}.ts:${i + 1}: const answer${i} = ${'x'.repeat(width)}`);
  return JSON.stringify(items);
}

// ---------------------------------------------------------------- 基础语义（v0.2 遗产）

test('低于预算透传（同一对象返回）', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.bash('Command: ls\n\na\nb\n\nExit Code: 0');
  assert.equal(out, r);
  assert.equal(h.writes.length, 0);
});

test('超预算：压缩 + 落盘 + 关键行保留', async () => {
  const h = harness({ env: HOME });
  const raw = bigText();
  const { out } = await h.bash(raw);
  const got = (out as any).result as string;
  assert.ok(got.includes('[wb-ops]'), '有标记');
  assert.ok(got.includes('Command: npm test'), '头部保留');
  assert.ok(got.includes('ERROR: something exploded in module Y'), '强关键词行保留');
  assert.ok(got.includes('Exit Code: 0'), '尾部退出码保留');
  assert.ok(got.length < raw.length / 2, '确实省了（>50%）');
  assert.ok(byteLen(got) <= 8000 + 1400, '预算上限内');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].text, raw, '落盘的是完整原文');
  assert.match(h.writes[0].path, /C:\/tmp-home\/\.workbuddy\/wb-ops\/spill\/deadbeef\/\d+-c1\.txt$/);
  assert.ok(got.includes(h.writes[0].path), '标记里给出回查路径');
});

test('非零退出码：完整透传，不落盘不压缩', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.bash(bigText().replace('Exit Code: 0', 'Exit Code: 2'));
  assert.equal(out, r);
  assert.equal(h.writes.length, 0, '错误输出白白落盘=磁盘垃圾，必须避免');
});

test('isError：透传', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.bash(bigText(), {}, { isError: true });
  assert.equal(out, r);
});

test('双压缩防护：已带自身或 sana35421/wb-ops 真实标记的文本透传', async () => {
  const h = harness({ env: HOME });
  const a = await h.bash('[wb-ops] 已省略 3 行\n' + bigText());
  assert.equal(a.out, a.r);
  const b = await h.bash('[wb-ops 省略 999 行，可回查]\n' + bigText()); // sana MARK_OMIT 实际前缀
  assert.equal(b.out, b.r);
});

test('落盘失败：仍压缩，但标记如实说明未保留', async () => {
  const h = harness({ env: HOME, writeFail: true });
  const { out } = await h.bash(bigText());
  const got = (out as any).result as string;
  assert.ok(got.includes('未落盘'), '不给假路径');
  assert.ok(got.includes('[wb-ops] 已省略'));
});

test('原文超过 4MB 落盘门槛：仍压缩但不写盘，标记如实说明', async () => {
  const h = harness({ env: HOME });
  const { out } = await h.bash(bigText(45000)); // ≈4.6MB
  assert.equal(h.writes.length, 0, '过大不写');
  assert.ok(((out as any).result as string).includes('未落盘（原文过大'), '仍压缩，且诚实标注原因');
});

test('WB_OPS=0：全局关闭', async () => {
  const h = harness({ env: { ...HOME, WB_OPS: '0' } });
  const { r, out } = await h.bash(bigText());
  assert.equal(out, r);
});

test('软超时 deadlineMs=0：放弃压缩，透传原文', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_DEADLINE_MS: '0' } });
  const { r, out } = await h.bash(bigText());
  assert.equal(out, r);
});

test('自定义预算生效', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_BUDGET: '2000' } });
  const { out } = await h.bash(bigText());
  assert.ok(byteLen(((out as any).result as string)) <= 2000 + 1400);
});

test('content 数组形状保持替换', async () => {
  const h = harness({ env: HOME });
  const shaped = { content: [{ type: 'text', text: bigText() }], other: 42 };
  const { out } = await h.bash(shaped);
  const got = (out as any).result;
  assert.equal(got.other, 42, '未触碰字段保留');
  assert.equal(got.content.length, 1);
  assert.equal(got.content[0].type, 'text');
  assert.ok(got.content[0].text.includes('[wb-ops]'));
});

test('并发 50 次：spill 路径互不覆盖', async () => {
  const writes: string[] = [];
  const byTool: Record<string, any> = {};
  register(((ev: string, m: any, h: any) => { byTool[m.tool] = h; }) as any);
  const $ = {
    env: { get: async (k: string) => k === 'USERPROFILE' ? 'C:/tmp-home' : undefined },
    fs: { write: async (p: string) => { writes.push(p); } },
    session: { id: async () => 'sess0001-aaaa' },
  };
  await Promise.all(Array.from({ length: 50 }, () =>
    byTool.Bash($, { tool: 'Bash', callId: 'same-call' }, async () => ({ result: bigText() }))
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

// ---------------------------------------------------------------- Batch B：字节测量与少行巨字节

test('中文输出按 UTF-8 字节计量：预算不再被多字节内容绕过', () => {
  const cn = ('错误：连接被拒绝，超时重试。\n').repeat(600); // 14 汉字 ×3B = 42B/行
  assert.equal(byteLen(cn), 43 * 600, '9000 字符 ≠ 真相，10800B 才是');
  const out = compress(cn, 8000, 100, null);
  assert.ok(out, '字节超预算必须压');
  assert.ok(byteLen(out!.text) <= 8000 + 1400);
});

test('字符数未超而字节超预算：包装器不许漏压（v0.2 按字符计量的窟窿）', async () => {
  const h = harness({ env: HOME });
  const leak = Array.from({ length: 320 }, (_, i) => `第${i}次尝试：连接失败，已拒绝。`).join('\n'); // 20 字×3B=60B/行 → 19.5KB；字符数 6432 < 8000
  assert.ok(leak.length < 8000 && byteLen(leak) > 8000, '构造校验');
  const { out } = await h.bash('Command: 跑测试\n' + leak + '\nExit Code: 0');
  const got = (out as any).result as string;
  assert.ok(got.includes('[wb-ops]'), '必须压，不许按字符数漏过');
});

test('少行巨字节：单行 200KB 走字节级首尾截（v0.2 的窟窿）', async () => {
  const h = harness({ env: HOME });
  const oneLine = 'A'.repeat(50000) + 'Connection refused at module Z' + 'B'.repeat(200000);
  const { out } = await h.bash('Command: build\n' + oneLine + '\nExit Code: 0');
  const got = (out as any).result as string;
  assert.ok(got.includes('少行巨字节'), '走字节分支');
  assert.ok(got.includes('Exit Code: 0'), '尾段仍在');
  assert.ok(byteLen(got) <= 8000 + 1400);
  assert.equal(h.writes.length, 1);
});

test('均匀撒点：关键行密集时不超过 40 条', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => i % 3 === 0 ? `line ${i} ERROR boom` : `line ${i} ok`);
  const out = compress(lines.join('\n'), 8000, 100, null)!;
  const m = /命中关键行 \((\d+)\)/.exec(out.text);
  assert.ok(m, '有关键行段');
  assert.ok(parseInt(m![1], 10) <= 40, `实际 ${m![1]} 条`);
});

// ---------------------------------------------------------------- Batch A：分工具策略

test('Grep JSON 数组：前 K 条 + 计数 + .json 落盘', async () => {
  const h = harness({ env: HOME });
  const raw = grepJson(400);
  const { out } = await h.call('Grep', raw, { input: { pattern: 'answer', path: 'C:/repo' } });
  const got = (out as any).result as string;
  assert.ok(got.includes('共 400 条'), '计数行');
  assert.ok(got.includes('已省略'), '省略标记');
  assert.ok(got.split('\n').length < 120, '远小于原 400 条');
  assert.ok(got.includes('module0'), '头部条目保留');
  assert.match(h.writes[0].path, /\.json$/);
  assert.ok(byteLen(got) <= 8000 + 1400);
});

test('非数组 JSON 或解析失败：回落通用压缩不炸', () => {
  assert.equal(parseJsonList('{"a":1}'), null);
  assert.equal(parseJsonList('[1,2,3]'), null, '非字符串数组透传');
  assert.equal(parseJsonList('not json ['), null);
});

test('Read 源码文件 1400 行不裁（读完要接着改，中段不能丢）', async () => {
  const h = harness({ env: HOME });
  const src = Array.from({ length: 1400 }, (_, i) => `  ${i + 1}→const x${i} = ${'pad'.repeat(20)}`).join('\n');
  assert.ok(byteLen(src) > 8000);
  const { r, out } = await h.call('Read', src, { input: { file_path: 'C:/repo/app.ts' } });
  assert.equal(out, r, '源码档：不足 1500 行一律透传');
  assert.equal(classifyRead('C:/repo/app.ts').minLines, 1500);
});

test('Read 数据文件 >200 行且超预算：裁剪 + 空洞指路 offset/limit', async () => {
  const h = harness({ env: HOME });
  const log = Array.from({ length: 3000 }, (_, i) => `  ${i + 1}→2026-11-04 INFO worker${i % 7} heartbeat`).join('\n');
  const { out } = await h.call('Read', log, { input: { file_path: 'C:/repo/run.log' } });
  const got = (out as any).result as string;
  assert.ok(got.includes('[wb-ops]'));
  assert.ok(/回看: Read offset=\d+ limit=\d+/.test(got), `缺指路：${got.slice(0, 200)}`);
  const off = /offset=(\d+)/.exec(got)![1];
  assert.ok(Number(off) > 1, '指到文件真实行号');
  assert.ok(byteLen(got) <= 8000 + 1400);
});

test('Read 宿主 <persisted-output>：透传（宿主自己已落盘）', async () => {
  const h = harness({ env: HOME });
  const persisted = '<persisted-output>\nOutput too large (65.7KB). Full output saved to: C:\\\\x\\\\y.txt\n\nPreview (first 2048 bytes):\n' + bigText(200);
  const { r, out } = await h.call('Read', persisted + '\n' + 'z'.repeat(20000), { input: { file_path: 'C:/repo/big.txt' } });
  assert.equal(out, r);
  assert.equal(h.writes.length, 0);
});

test('Read 判不出文件路径：保守透传', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.call('Read', bigText(), {}); // 无 input
  assert.equal(out, r);
});

test('Read .md 档：800 行门槛 + 标题行骨架捞回', async () => {
  const h = harness({ env: HOME });
  const md700 = Array.from({ length: 700 }, (_, i) => `  ${i + 1}→正文行 ${'中'.repeat(30)}`).join('\n');
  const a = await h.call('Read', md700, { input: { file_path: 'C:/repo/docs/spec.md' } });
  assert.equal(a.out, a.r, '700 行 md 不裁');
  const md = Array.from({ length: 2000 }, (_, i) => i % 97 === 0 ? `  ${i + 1}→## 章节 ${i / 97}` : `  ${i + 1}→正文 ${'y'.repeat(40)}`).join('\n');
  const b = await h.call('Read', md, { input: { file_path: 'C:/repo/docs/spec.md' } });
  const got = (b.out as any).result as string;
  assert.ok(got.includes('## 章节 10'), '标题行被捞回');
  assert.ok(byteLen(got) <= 8000 + 1400);
});

test('WebFetch/WebSearch：标题与链接行保留', async () => {
  const h = harness({ env: HOME });
  const page = ['# 大标题', ...Array.from({ length: 3000 }, (_, i) => `正文段落 ${i} ${'z'.repeat(60)}`), '[链接锚文本](https://example.com/a)'].join('\n');
  const { out } = await h.call('WebSearch', page);
  const got = (out as any).result as string;
  assert.ok(got.includes('# 大标题'), '标题保留');
  assert.ok(got.includes('[链接锚文本]'), '链接行保留');
});

test('PowerShell/TaskOutput 与 Bash 同策略；无退出码行也照压', async () => {
  const h = harness({ env: HOME });
  const pwsh = Array.from({ length: 2000 }, (_, i) => `VERBOSE ${i} ${'w'.repeat(40)}`).join('\n') + '\nProcess terminated. Exit Code: 0';
  const { out } = await h.call('PowerShell', pwsh, { input: { command: 'Get-Log' } });
  assert.ok(((out as any).result as string).includes('[wb-ops]'));
  const bad = pwsh.replace('Exit Code: 0', 'Exit Code: 1');
  const r2 = await h.call('PowerShell', bad, { input: { command: 'Get-Log' } });
  assert.equal(r2.out, r2.r, '非零退出透传');
});

// ---------------------------------------------------------------- Batch C：记账

test('WB_OPS_STATS 未设：热路径零统计 IO', async () => {
  const h = harness({ env: HOME });
  await h.bash(bigText());
  assert.equal(h.writes.length, 1, '只有 spill');
  assert.equal(h.reads.length, 0);
});

test('WB_OPS_STATS=1：写会话计数器，省量可查', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_STATS: '1' } });
  await h.bash(bigText());
  const stat = h.writes.find((w) => w.path.includes('/stats/'));
  assert.ok(stat, '计数器落盘 ' + h.writes.map((w) => w.path).join());
  const j = JSON.parse(stat!.text);
  assert.equal(j.calls, 1);
  assert.ok(j.before > 100000 && j.after < 9500 && j.before > 3 * j.after, `before=${j.before} after=${j.after}`);
  assert.equal(j.tool, 'shell');
});

test('记账读失败不影响压缩（fail-open）', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_STATS: '1' }, writeFail: false });
  h.$.fs.read = async () => { throw new Error('boom'); };
  const { out } = await h.bash(bigText());
  assert.ok(((out as any).result as string).includes('[wb-ops]'), 'stats 挂了压缩照常');
});

// ---------------------------------------------------------------- 适配器单元

test('u8Prefix 不劈代理对', () => {
  const s = '😀abc'; // 😀=4B, a/b/c 各 1B
  assert.equal(u8Prefix(s, 5), '😀a');
  assert.equal(u8Prefix(s, 4), '😀');
  assert.equal(u8Prefix(s, 3), '', 'emoji 进不下就整体不切，绝不留半个代理对');
});

test('compressList 至少保 1 条', () => {
  const out = compressList(['x'.repeat(50000), 'b'], 8000, null, 60000);
  assert.ok(out.text.startsWith('x'.repeat(1000)), '首条按单行上限截断展示');
  assert.ok(out.text.includes('共 2 条'));
});
