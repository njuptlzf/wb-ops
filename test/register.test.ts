/**
 * wb-ops 离线单测：node --test test/
 * 用 mock 的 $（env/fs/session）驱动 register()，验证透传/压缩/落盘/并发/fail-open/分工具策略。
 * 不依赖 WorkBuddy——宿主真实行为另见 README「待在线验证」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register, compress, compressList, trimList, extractText, exitCodeOf, classifyRead, parseJsonList, byteLen, u8Prefix, hintFor, HINT_PREFIX, summarizeStats, renderSummary, estTokens, pickWatermark, pickWindow, projectSlug, lastInputTokens, probeTranscript, watermarkLine, guardNote, describeShape, hasLongString, toolNameOf, probeUsage, COMPACT_RETENTION } from '../hooks/register.ts';

function harness(opts: { env?: Record<string, string>; writeFail?: boolean; readFail?: boolean; listFail?: boolean; list?: unknown[]; files?: Record<string, string>; usage?: unknown; usageFail?: boolean; cwd?: string } = {}) {
  const writes: { path: string; text: string }[] = [];
  const reads: string[] = [];
  const byTool: Record<string, ($: any, e: any, next: any) => Promise<any>> = {};
  const hooks: Array<{ ev: string; matcher: any; h: any }> = [];
  const regCalls: any[] = [];
  register(((ev: string, m: any, h: any) => {
    if (typeof m === 'function') { hooks.push({ ev, matcher: {}, h: m }); return; } // 2 参形态
    byTool[m.tool] = h;
    hooks.push({ ev, matcher: m, h });
  }) as any);
  const usageCalls: number[] = [];
  // 测试默认关记账（老用例只关心 spill 写数）；要测记账的用例显式给 WB_OPS_STATS；
  // 测"未设=默认开"的用例传 WB_OPS_STATS: undefined。
  const ENV: Record<string, string | undefined> = { WB_OPS_STATS: '0', ...(opts.env ?? {}) };
  const $ = {
    env: { get: async (k: string) => ENV[k] },
    tool: { register: async (spec: any) => { regCalls.push(spec); return { tool: 'mcp__wb_ops__report' }; } },
    fs: {
      write: async (p: string, t: string) => {
        if (opts.writeFail) throw new Error('disk on fire');
        writes.push({ path: p, text: t });
      },
      list: async (p: string) => {
        if (opts.listFail) throw new Error('no such dir');
        return opts.list ?? Object.keys(opts.files ?? {}).filter(f => f.startsWith(p + '/')).map(f => f.slice(p.length + 1));
      },
      read: async (p: string) => {
        reads.push(p);
        if (opts.readFail) throw new Error('no such file');
        if (opts.files?.[p] !== undefined) return opts.files[p];
        const hit = writes.find((w) => w.path === p);
        return hit ? hit.text : undefined;
      },
      stat: async (p: string) => {
        if (opts.readFail) throw new Error('no such file');
        const t = opts.files?.[p];
        if (t === undefined) throw new Error('no such file');
        return { kind: 'file', size: Buffer.byteLength(t, 'utf8'), mtimeMs: 0, isLink: false };
      },
    },
    session: {
      id: async () => 'deadbeef-0000-1111',
      cwd: async () => opts.cwd ?? 'C:\\Users\\kingdee\\work\\wb-ops',
      usage: async () => {
        usageCalls.push(1);
        if (opts.usageFail) throw new Error('usage unavailable');
        return opts.usage;
      },
    },
  };
  const firePrompt = async (text = '继续') => {
    const hk = hooks.find((k) => k.ev === 'prompt.submit');
    if (!hk) throw new Error('prompt.submit handler not registered');
    return hk.h($, { text }, async (e: any) => ({ text: e.text }));
  };
  const fireCompact = async (e: Record<string, unknown> = { trigger: 'auto' }) => {
    const hk = hooks.find((k) => k.ev === 'session.compact');
    if (!hk) throw new Error('session.compact handler not registered');
    return hk.h($, e, async (e2: any) => ({ passed: e2 }));
  };
  const fireSessionStart = async () => {
    const hk = hooks.find((k) => k.ev === 'session.start');
    return hk ? hk.h($, {}, async (e: any) => ({ passed: e })) : null;
  };
  const fnHooks = (toolName: string) =>
    hooks.filter((k) => k.ev === 'tool.call' && typeof k.matcher.tool === 'function' && k.matcher.tool(toolName));
  const callReport = async () => {
    const name = 'mcp__wb_ops__report';
    const hks = fnHooks(name);
    if (hks.length !== 1) throw new Error(`report predicate should match own tool exactly once, got ${hks.length}`);
    const out = await hks[0].h($, { tool: name }, async () => { throw new Error('next must not run for own tool'); });
    return { skipped: false as const, out };
  };
  const callUnknown = async (toolName: string, result: unknown, event: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const hks = fnHooks(toolName);
    if (hks.length !== 1) throw new Error(`fallback predicate should match unknown tool exactly once, got ${hks.length}`);
    const r = { result, ...extra };
    const out = await hks[0].h($, { tool: toolName, callId: 'cf1', ...event }, async () => r);
    return { r, out };
  };
  const call = async (tool: string, result: unknown, event: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const r = { result, ...extra };
    const out = await byTool[tool]($, { tool, callId: 'c1', ...event }, async () => r);
    return { r, out };
  };
  const bash = (result: unknown, event: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    call('Bash', result, { input: { command: 'npm test' }, ...event }, extra);
  return { $, writes, reads, call, bash, byTool, regCalls, fireSessionStart, callReport, callUnknown, fnHooks, firePrompt, fireCompact, usageCalls };
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

// ---------------------------------------------------------------- Batch #2：错误 nextAction 提示

test('已知错误+非零退出：现场原样 + 追加一行提示（小失败也提示——提示门在预算门之前）', async () => {
  const h = harness({ env: HOME });
  const raw = 'Command: xyz-cmd\n\nStdout:\n\nStderr:\nbash: xyz-cmd: command not found\n\nExit Code: 127';
  const { r, out } = await h.bash(raw);
  const got = (out as any).result as string;
  assert.ok(got.startsWith(raw), '错误现场一字不动');
  assert.ok(got.length > raw.length, '有提示');
  assert.equal(got.split(HINT_PREFIX).length, 2, '至多一行');
  assert.match(got, /命令不存在/);
  assert.equal(h.writes.length, 0, '提示路径不落盘');
});

test('EADDRINUSE → 端口提示；中文「拒绝访问」→ 权限提示', async () => {
  const h = harness({ env: HOME });
  const { out: o1 } = await h.bash('Command: serve\nStderr:\nError: listen EADDRINUSE: address already in use :::3000\nExit Code: 1');
  assert.match((o1 as any).result, /端口被占/);
  const { out: o2 } = await h.call('PowerShell', 'Command: Remove-Item x\nStderr:\n访问路径拒绝访问。\nExit Code: 1', { input: { command: 'Remove-Item x' } });
  assert.match((o2 as any).result, /权限不足/);
});

test('未知错误模式：恒等透传（宁缺毋滥，提示只在有把握时出现）', async () => {
  const h = harness({ env: HOME });
  const raw = 'Command: make\nStderr:\nsomething arcane went wrong\nExit Code: 2';
  const { r, out } = await h.bash(raw);
  assert.equal(out, r);
});

test('WB_OPS_HINTS=0：失败现场纯透传无提示', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_HINTS: '0' } });
  const raw = 'Command: xyz\nStderr:\nbash: xyz: command not found\nExit Code: 127';
  const { r, out } = await h.bash(raw);
  assert.equal(out, r);
});

test('巨量失败输出：提示只扫头尾 4KB，中段埋雷不误报', async () => {
  const h = harness({ env: HOME });
  const raw = 'Command: big\n' + 'a'.repeat(4500) + '\ncommand not found (buried)\n' + 'b'.repeat(90000) + '\nExit Code: 1';
  const { r, out } = await h.bash(raw);
  assert.equal(out, r, '模式不在扫描窗内 → 不加提示也不压缩');
});

test('双压缩防护覆盖提示路径：已带标记的失败输出不再提示', async () => {
  const h = harness({ env: HOME });
  const raw = 'Command: xyz\nStderr:\nbash: xyz: command not found\n[wb-ops] 已省略 3 行\nExit Code: 127';
  const { r, out } = await h.bash(raw);
  assert.equal(out, r);
});

test('hintFor 单元：中英模式命中与未命中', () => {
  assert.match(hintFor('fatal: not a git repository (or any of the parent directories): .git')!, /git/);
  assert.match(hintFor('python: No module named requests')!, /pip install/);
  assert.equal(hintFor('all quiet on the western front'), null);
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
  // 4.6MB 输入本身就可能撞上默认 100ms 软超时（机器忙时压缩自弃）→ 放大 deadline 隔离时间变量，
  // 本用例只验证「过大不落盘 + 诚实标注」，不测超时。
  const h = harness({ env: { ...HOME, WB_OPS_DEADLINE_MS: '10000' } });
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
    env: { get: async (k: string) => k === 'USERPROFILE' ? 'C:/tmp-home' : k === 'WB_OPS_STATS' ? '0' : undefined },
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

test('WB_OPS_STATS=0：热路径零统计 IO', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_STATS: '0' } });
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
  assert.deepEqual(j.kinds.shell, { calls: 1, before: j.before, after: j.after, tokBefore: j.tokBefore, tokAfter: j.tokAfter }, '① by-kind 细分同口径');
  assert.ok(j.tokBefore > 20000 && j.tokBefore > 3 * j.tokAfter, `tokBefore=${j.tokBefore} tokAfter=${j.tokAfter}`);
});

test('WB_OPS_STATS 未设（v0.13 默认开）：写计数并带 token 口径，标记行内联省量', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_STATS: undefined } });
  const { out } = await h.bash(bigText());
  const stat = h.writes.find((w) => w.path.includes('/stats/'));
  assert.ok(stat, '默认开：计数器落盘 ' + h.writes.map((w) => w.path).join());
  const j = JSON.parse(stat!.text);
  assert.ok(j.tokBefore > 20000 && j.tokBefore > 3 * j.tokAfter, `tokBefore=${j.tokBefore} tokAfter=${j.tokAfter}`);
  assert.ok(j.kinds.shell.tokBefore > 0, '按类也带 token');
  const txt = (out as any).result as string;
  assert.match(txt, /≈[\d.]+k? tok → ≈[\d.]+k? tok（省 \d+%）/, '标记行内联 token 与省比');
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

test('estTokens 与宿主同公式（ceil 中文/1.8 + ceil 其余/4）', () => {
  assert.equal(estTokens(''), 0);
  assert.equal(estTokens('abcd'), 1);
  assert.equal(estTokens('中文'), 2, 'ceil(2/1.8)=2');
  assert.equal(estTokens('中文ab'), Math.ceil(2 / 1.8) + Math.ceil(2 / 4));
  assert.equal(estTokens('😀a'), 1, 'emoji 不是 CJK，按 4 字符/4 计');
});

test('renderSummary token 口径（有 tok 字段走 tok，分类行同源）', () => {
  const txt = renderSummary([{ file: 'a.json', calls: 1, before: 4096, after: 1024, tokBefore: 1000, tokAfter: 250, kinds: { shell: { calls: 1, before: 4096, after: 1024, tokBefore: 1000, tokAfter: 250 } } }]);
  assert.match(txt, /省 ≈750 tok \/ 3\.0KB \(75\.0%\)/);
  assert.match(txt, /原文 4\.0KB≈1\.0k tok → 压缩后 1\.0KB≈250 tok/);
  assert.match(txt, /分类：shell 1次 ≈1\.0k→250 tok/);
});

// ---------------------------------------------------------------- report (#3)

test('renderSummary 空账本', () => {
  assert.equal(summarizeStats([]).calls, 0);
  assert.match(renderSummary([]), /还没有记账数据/);
  assert.match(renderSummary([{ file: 'a.json', calls: 0, before: 0, after: 0 }]), /还没有记账数据/);
});

test('renderSummary 汇总行', () => {
  const txt = renderSummary([
    { file: 'aaaa1111.json', calls: 5, before: 40960, after: 8192, tool: 'shell', ts: '2026-11-04T10:00:00.000Z' },
    { file: 'bbbb2222.json', calls: 2, before: 2048, after: 1024, tool: 'read', ts: '2026-11-03T10:00:00.000Z' },
  ]);
  assert.ok(txt.includes('压缩 7 次'));
  assert.ok(txt.includes('42.0KB'), '合计原文 43008B');
  assert.ok(txt.includes('(78.6%)'), 'saved 33792/43008');
  assert.ok(txt.includes('aaaa1111  5 次'));
  assert.ok(txt.indexOf('aaaa1111') < txt.indexOf('bbbb2222'), '按 ts 新→旧排');
});

test('stats 开启：session.start 注册 report 工具', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_STATS: '1' } });
  const res = await h.fireSessionStart();
  assert.deepEqual(res, { passed: {} }, '必须透传 next');
  assert.equal(h.regCalls.length, 1);
  assert.equal(h.regCalls[0].name, 'report');
  assert.equal(typeof h.regCalls[0].description, 'string');
  assert.equal(h.regCalls[0].inputSchema.type, 'object');
});

test('report 工具：读目录聚合渲染（谓词命中、next 不可达）', async () => {
  const dir = 'C:/tmp-home/.workbuddy/wb-ops/stats';
  const h = harness({
    env: { ...HOME, WB_OPS_STATS: '1' },
    list: ['aaaa1111.json', 'bad.json', 'notes.txt'],
    files: { [`${dir}/aaaa1111.json`]: JSON.stringify({ calls: 3, before: 30000, after: 5000, tool: 'jsonlist', ts: '2026-11-04T09:00:00.000Z', kinds: { jsonlist: { calls: 2, before: 24000, after: 3200 }, shell: { calls: 1, before: 6000, after: 1800 } } }) },
  });
  await h.fireSessionStart(); // 注册 report → 谓词命中自己、兜底排除
  const { out } = await h.callReport();
  assert.ok(out.result.includes('压缩 3 次'));
  assert.match(out.result, /分类：jsonlist 2次 23\.4KB→3\.1KB · shell 1次 5\.9KB→1\.8KB/);
  assert.ok(out.result.includes('jsonlist'), '最后 tool 字段透出');
  assert.ok(!out.result.includes('bad'), '坏 JSON 行被跳过');
});

test('report 工具：fs.list 抛错 → 空账本文案（fail-open）', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_STATS: '1' }, listFail: true });
  await h.fireSessionStart();
  const { out } = await h.callReport();
  assert.match(out.result, /还没有记账数据/);
});

test('report 工具：stats 未开 → 提示文案', async () => {
  const reg = harness({ env: { ...HOME, WB_OPS_STATS: '1' } });
  await reg.fireSessionStart(); // 本会话注册过（设置 reportToolName），随后 stats 关掉 → 防御分支
  const h = harness({ env: HOME });
  const { out } = await h.callReport();
  assert.match(out.result, /报表未启用/);
});

// ---------------------------------------------------------------- fallback (③)

const bigMcp = () => Array.from({ length: 3000 }, (_, i) => `row ${i} payload ${'x'.repeat(30)}`).join('\n');

test('③ 兜底：未知工具超预算 → 压缩+落盘+标记', async () => {
  const h = harness({ env: HOME });
  const body = bigMcp();
  const { out } = await h.callUnknown('mcp__notion__search', body);
  const txt = out.result as string;
  assert.notEqual(out, undefined);
  assert.equal(h.writes.length, 1, '落盘一次');
  assert.ok(h.writes[0].path.includes('/wb-ops/spill/deadbeef/'), h.writes[0].path);
  assert.ok(h.writes[0].text === body, '原文完整');
  assert.ok(txt.includes('[wb-ops]'), '有标记');
  assert.ok(txt.includes('row 0 payload'), '头部保留');
  assert.ok(byteLen(txt) <= 8000 + 1400, `预算内: ${byteLen(txt)}`);
});

test('③ 兜底：预算内原样透传（Edit/小结果零影响）', async () => {
  const h = harness({ env: HOME });
  const { r, out } = await h.callUnknown('mcp__small__tool', 'tiny output');
  assert.equal(out, r, '必须是原对象');
  assert.equal(h.writes.length, 0);
});

test('③ 兜底：非零 Exit Code → 完整透传不提示', async () => {
  const h = harness({ env: HOME });
  const body = bigMcp() + '\nExit Code: 3';
  const { r, out } = await h.callUnknown('mcp__runner__exec', body);
  assert.equal(out, r, '失败现场保持原样');
  assert.equal(h.writes.length, 0);
});

test('③ 兜底：WB_OPS_FALLBACK=0 → 未知工具透传，白名单不受影响', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_FALLBACK: '0' } });
  const { r, out } = await h.callUnknown('mcp__anything', bigMcp());
  assert.equal(out, r);
  assert.equal(h.writes.length, 0);
  const b = await h.bash(bigMcp());
  assert.ok((b.out.result as string).includes('[wb-ops]'), '白名单照常压缩');
});

test('③ 兜底：谓词互斥——已知工具与自家报表工具不被兜底双命中', async () => {
  const reg = harness({ env: { ...HOME, WB_OPS_STATS: '1' } });
  await reg.fireSessionStart();
  assert.equal(reg.fnHooks('Bash').length, 0, 'Bash 只走字面 matcher');
  assert.equal(reg.fnHooks('mcp__wb_ops__report').length, 1, 'report 名只命中自家 handler');
});

// ---------------------------------------------------------------- guard (#4/#5)

test('② 水位数值文件：每轮 guard 开时写余量小文件（未越线也写，不发提醒）', async () => {
  const h = harness({ env: HOME, usage: { used: 1000, size: 20000 } });
  const res = await h.firePrompt();
  assert.equal(res.text, '继续');
  assert.ok(!((res.context || []).length), '5% 不越线不发提醒');
  const wm = h.writes.find((w) => w.path.endsWith('/wb-ops/watermark/deadbeef.num'));
  assert.ok(wm, '水位文件已写');
  assert.ok(wm.text.startsWith('19000'), '首行=剩余');
  assert.ok(h.writes.some((w) => w.path.includes('/wb-ops/debug/usage-')), 'usage 形状诊断也落盘');
});

test('② 水位数值文件：越线提醒附带 Read 路径', async () => {
  const h = harness({ env: HOME, usage: { used: 18000, size: 20000 } });
  const res = await h.firePrompt();
  const note = res.context[res.context.length - 1];
  assert.match(note, /wb-ops 水位/);
  assert.match(note, /余量速查：Read C:\/tmp-home\/\.workbuddy\/wb-ops\/watermark\/deadbeef\.num/);
});

test('② 水位数值文件：写失败 → 提醒仍在但无路径，不炸', async () => {
  const h = harness({ env: HOME, usage: { used: 90, size: 100 }, writeFail: true });
  const res = await h.firePrompt();
  const note = res.context[res.context.length - 1];
  assert.match(note, /wb-ops 水位/);
  assert.ok(!note.includes('余量速查'), '路径未承诺');
});

test('② 记账未开启 → 水位文件仍写（跟 guard 走），但不产生记账 IO', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_STATS: '0' }, usage: { used: 1000, size: 20000 } });
  const res = await h.firePrompt();
  assert.ok(h.writes.some((w) => w.path.endsWith('/wb-ops/watermark/deadbeef.num')), '水位文件跟 guard 走');
  assert.ok(!h.writes.some((w) => w.path.includes('/stats/')) && !h.reads.some((r) => r.includes('/stats/')), 'stats 关则零记账 IO');
  assert.ok(!((res.context || []).length), '5% 不越线不发提醒');
});

test('④ install-gui.mjs：临时 HOME 装+卸，known/installed/marketplace.json/enabledPlugins 形状正确', async () => {
  const { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'wbops-gui-'));
  try {
    // 预置一个别的市场条目，验证合并不覆盖
    const pluginsDir = join(home, '.workbuddy', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({ other: { manifestName: 'other', type: 'directory', source: { source: 'directory', path: 'X:\\keep' }, installLocation: 'X:\\keep', autoUpdate: true } }, null, 2));
    // 预置 settings.json（含别的 enabledPlugins 键），验证合并不丢别人的声明
    writeFileSync(join(home, '.workbuddy', 'settings.json'), JSON.stringify({ enabledPlugins: { 'other@workbuddy-builtin': true }, sandbox: { x: 1 } }, null, 2));
    const script = join(import.meta.dirname!, '..', 'scripts', 'install-gui.mjs');
    const r1 = spawnSync(process.execPath, [script], { env: { ...process.env, WB_OPS_INSTALL_HOME: home.replace(/\\/g, '/') } });
    assert.equal(r1.status, 0, r1.stderr?.toString());
    const known = JSON.parse(readFileSync(join(pluginsDir, 'known_marketplaces.json'), 'utf8'));
    assert.ok(known.other, '既有市场保留');
    assert.equal(known['wb-ops-local'].type, 'directory');
    const inst = JSON.parse(readFileSync(join(pluginsDir, 'installed_plugins.json'), 'utf8'));
    const entry = inst.plugins['wb-ops@wb-ops-local'][0];
    assert.equal(entry.scope, 'user');
    assert.ok(entry.version && /^\d+\.\d+\.\d+/.test(entry.version), entry.version);
    assert.ok(existsSync(join(entry.installPath.replace(/\\\\/g, '\\'), 'hooks', 'register.ts')), 'cache 里有 payload');
    assert.ok(existsSync(join(pluginsDir, 'marketplaces', 'wb-ops-local', 'wb-ops', '.codebuddy-plugin', 'plugin.json')), 'marketplaces 目录结构');
    // 市场清单：市场根目录 .codebuddy-plugin/marketplace.json（官方规范，宿主据此枚举市场）
    const mkManifestPath = join(pluginsDir, 'marketplaces', 'wb-ops-local', '.codebuddy-plugin', 'marketplace.json');
    assert.ok(existsSync(mkManifestPath), '市场清单存在');
    const mk = JSON.parse(readFileSync(mkManifestPath, 'utf8'));
    assert.equal(mk.name, 'wb-ops-local');
    assert.ok(Array.isArray(mk.plugins) && mk.plugins[0].name === 'wb-ops', '市场清单列出 wb-ops');
    assert.equal(mk.plugins[0].source, './wb-ops', 'source 为相对市场根的路径');
    // 启用声明：settings.json 的 enabledPlugins（缺它宿主 status=disabled，mod 不加载）
    const st1 = JSON.parse(readFileSync(join(home, '.workbuddy', 'settings.json'), 'utf8'));
    assert.equal(st1.enabledPlugins['wb-ops@wb-ops-local'], true, 'enabledPlugins 声明为 true');
    assert.equal(st1.enabledPlugins['other@workbuddy-builtin'], true, '既有 enabledPlugins 保留');
    assert.deepEqual(st1.sandbox, { x: 1 }, 'settings 其他键保留');
    const r2 = spawnSync(process.execPath, [script, '--uninstall'], { env: { ...process.env, WB_OPS_INSTALL_HOME: home.replace(/\\/g, '/') } });
    assert.equal(r2.status, 0, r2.stderr?.toString());
    const known2 = JSON.parse(readFileSync(join(pluginsDir, 'known_marketplaces.json'), 'utf8'));
    assert.ok(known2.other && !known2['wb-ops-local'], '卸载只摘自己');
    const inst2 = JSON.parse(readFileSync(join(pluginsDir, 'installed_plugins.json'), 'utf8'));
    assert.ok(!inst2.plugins['wb-ops@wb-ops-local']);
    assert.ok(!existsSync(join(pluginsDir, 'marketplaces', 'wb-ops-local')), '卸载摘掉市场目录');
    const st2 = JSON.parse(readFileSync(join(home, '.workbuddy', 'settings.json'), 'utf8'));
    assert.ok(!('wb-ops@wb-ops-local' in (st2.enabledPlugins || {})), '卸载撤销 enabledPlugins 声明');
    assert.equal(st2.enabledPlugins['other@workbuddy-builtin'], true, '卸载不动别人的声明');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pickWatermark 候选形状与拒判', () => {
  assert.deepEqual(pickWatermark({ used: 500, size: 1000 }), { used: 500, size: 1000 });
  assert.deepEqual(pickWatermark({ inputTokens: 900, contextWindow: 1000 }), { used: 900, size: 1000 });
  assert.deepEqual(pickWatermark({ promptTokens: 100, maxInputTokens: 200 }), { used: 100, size: 200 });
  assert.equal(pickWatermark({ totalTokens: 300, size: 0 }), null);
  assert.equal(pickWatermark(null), null);
  assert.equal(pickWatermark(42), null);
  assert.equal(pickWatermark({ used: '500', size: 1000 }), null, '字符串数字不收');
  assert.equal(pickWatermark({ used: -1, size: 1000 }), null);
});

test('guardNote 阈值边界', () => {
  assert.equal(guardNote({ used: 849, size: 1000 }, 85), null);
  const n = guardNote({ used: 851, size: 1000 }, 85);
  assert.ok(n && n.includes('[wb-ops 水位]') && n.includes('85%'));
});

test('prompt.submit 高水位 → text 保留 + context 附注', async () => {
  const h = harness({ env: HOME, usage: { used: 90000, size: 100000 } });
  const r = await h.firePrompt('继续');
  assert.equal(r.text, '继续');
  assert.equal(r.context.length, 1);
  assert.match(r.context[0], /wb-ops 水位/);
});

test('prompt.submit 低水位 / 未知形状 / usage 抛错 → 恒等透传', async () => {
  const h1 = harness({ env: HOME, usage: { used: 100, size: 100000 } });
  assert.deepEqual(await h1.firePrompt('hi'), { text: 'hi' }, '低水位不得调 next 之外的改写');
  const h2 = harness({ env: HOME, usage: { mystery: true } });
  assert.deepEqual(await h2.firePrompt('hi'), { text: 'hi' });
  const h3 = harness({ env: HOME, usageFail: true });
  assert.deepEqual(await h3.firePrompt('hi'), { text: 'hi' }, 'usage 抛错 fail-open');
});

test('prompt.submit WB_OPS_GUARD=0 → 不调 usage', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_GUARD: '0' }, usage: { used: 99999, size: 100000 } });
  assert.deepEqual(await h.firePrompt('hi'), { text: 'hi' });
  assert.equal(h.usageCalls.length, 0, '关闭时连 usage() 都不碰');
});

test('prompt.submit 阈值可配 WB_OPS_GUARD_PCT=50', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_GUARD_PCT: '50' }, usage: { used: 60, size: 100 } });
  const r = await h.firePrompt('hi');
  assert.ok(Array.isArray(r.context) && r.context.length === 1, '60% 在 50% 阈值下必须提醒');
});

test('session.compact → instructions 追加保留优先级', async () => {
  const h = harness({ env: HOME });
  const r = await h.fireCompact({ trigger: 'auto', instructions: '宿主原始指示' });
  assert.match(r.passed.instructions, /^宿主原始指示\n/);
  assert.ok(r.passed.instructions.includes(COMPACT_RETENTION.slice(0, 12)));
  const r2 = await h.fireCompact({ trigger: 'manual' });
  assert.ok(!String(r2.passed.instructions).startsWith('\n'), '无原 instructions 时不带前导换行');
});

test('session.compact guard 关闭 → 原样', async () => {
  const h = harness({ env: { ...HOME, WB_OPS_GUARD: 'off' } });
  const e = { trigger: 'auto', instructions: 'keep' };
  const r = await h.fireCompact(e);
  assert.deepEqual(r.passed, e);
});

test('report.mjs CLI：真实目录聚合', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'wbops-cli-'));
  try {
    mkdirSync(join(home, '.workbuddy', 'wb-ops', 'stats'), { recursive: true });
    writeFileSync(join(home, '.workbuddy', 'wb-ops', 'stats', 'sid1.json'), JSON.stringify({ calls: 2, before: 10000, after: 1500, tool: 'shell', ts: '2026-11-04T08:00:00.000Z' }));
    writeFileSync(join(home, '.workbuddy', 'wb-ops', 'stats', 'sid2.json'), '{broken');
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'hooks', 'report.mjs')], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('压缩 2 次'), r.stdout);
    assert.ok(r.stdout.includes('sid1'), r.stdout);
    // 空目录场景
    rmSync(join(home, '.workbuddy', 'wb-ops', 'stats', 'sid1.json'));
    const r2 = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'hooks', 'report.mjs')], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /还没有记账数据|无记账目录/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------- v0.11：宿主形状适配（Grep 原生数组）+ 诊断通道 + 预算

test('Grep 原生数组：content 是 string[] → 裁条目 + 单行说明，保持数组形态', async () => {
  const h = harness({ env: HOME });
  const items = Array.from({ length: 400 }, (_, i) => `C://repo//src//file${i}.ts:${i}: const value = ${'y'.repeat(80)}`);
  const { out } = await h.call('Grep', { title: 'Found 400 files', content: items });
  const res = (out as any).result;
  assert.ok(Array.isArray(res.content), '回写仍是数组（宿主按数组渲染/序列化）');
  assert.ok(res.content.length < items.length, '条目被裁');
  assert.ok(res.content.length >= 2, '至少保留 1 条 + 说明');
  const note = res.content[res.content.length - 1];
  assert.match(note, /\[wb-ops\] 共 400 条，已省略 \d+ 条/);
  assert.ok(h.writes.some((w) => w.path.endsWith('.json')), '原文落盘 .json');
});

test('Grep 原生数组：预算内 → 零影响透传（不裁不改）', async () => {
  const h = harness({ env: HOME });
  const items = ['C://a.ts', 'C://b.ts'];
  const { out } = await h.call('Grep', { title: 'Found 2 files', content: items });
  assert.deepEqual((out as any).result.content, items);
  assert.equal(h.writes.length, 0, '预算内零 IO');
});

test('extractText：content 为纯字符串数组 → 返回 items/isArray，raw 是其 JSON 形态', () => {
  const t = extractText({ title: 'Found 2 files', content: ['C://a.ts', 'C://b.ts'] });
  assert.ok(t);
  assert.deepEqual(t!.items, ['C://a.ts', 'C://b.ts']);
  assert.equal(t!.isArray, true);
  assert.deepEqual(JSON.parse(t!.raw), ['C://a.ts', 'C://b.ts']);
});

test('extractText：混合类型数组 → 仍判不出（fail-open 不变）', () => {
  assert.equal(extractText({ content: ['a.ts', { path: 'b.ts' }] }), null);
});

test('trimList：按字节预算裁条目 + 单行说明（无换行，宿主 JSON 序列化不炸）', () => {
  const items = Array.from({ length: 100 }, (_, i) => `path${i}-${'z'.repeat(50)}`);
  const { kept, note, dropped } = trimList(items, 4500, 'C:/spill/x.json', 12345);
  assert.ok(kept.length < items.length);
  assert.ok(kept.length >= 1);
  assert.equal(dropped, items.length - kept.length);
  assert.ok(!note.includes('\n'), '说明是单行');
  assert.match(note, /共 100 条，已省略 \d+ 条/);
  assert.ok(note.includes('C:/spill/x.json'));
});

test('默认预算下调到 4500：3KB 透传、6KB 压缩（宿主落盘阈值 ~8KB 之下留余量）', async () => {
  const h = harness({ env: HOME });
  const small = 'Command: x\n' + 'a'.repeat(2000) + '\nExit Code: 0';
  const { r: r1 } = await h.bash(small);
  assert.equal(r1.result, small, '预算内透传');
  const big = 'Command: x\n' + 'a'.repeat(6000) + '\nExit Code: 0';
  const { out: o2 } = await h.bash(big);
  assert.ok(String((o2 as any).result).includes('[wb-ops]'), '超 4500 即压缩');
});

test('形状诊断：describeShape 只出键名/类型/长度，绝不吐正文', () => {
  const secret = 'SECRET-PAYLOAD-9f3a';
  const s = describeShape({ content: [{ path: secret }], meta: { n: 3 }, flag: true });
  const text = JSON.stringify(s);
  assert.ok(text.includes('content') && text.includes('meta'), '键名在');
  assert.ok(!text.includes(secret), '正文不落盘');
  assert.ok(text.includes('"n"'), '嵌套键名在');
});

test('形状诊断：hasLongString 能识别大字符串与大字符串数组', () => {
  assert.equal(hasLongString(describeShape({ a: 'x'.repeat(5000) }), 4500), true);
  assert.equal(hasLongString(describeShape({ a: 'x'.repeat(100) }), 4500), false);
  assert.equal(hasLongString(describeShape({ a: Array.from({ length: 100 }, () => 'y'.repeat(100)) }), 4500), true);
  assert.equal(hasLongString(describeShape({ a: ['y'] }), 4500), false);
});

test('形状诊断：判不出形状且内容大 → 落盘 debug（只记结构）；内容小 → 不落盘', async () => {
  const h = harness({ env: HOME });
  const big = { payload: { body: 'z'.repeat(9000) } };      // 字段名不认识 + 内容大
  await h.callUnknown('McpX', big);
  const dbg = h.writes.find((w) => w.path.includes('/wb-ops/debug/shape-'));
  assert.ok(dbg, '形状诊断落盘');
  assert.ok(dbg.text.includes('payload'), '记键名');
  assert.ok(!dbg.text.includes('zzzz'), '不记正文');
  const h2 = harness({ env: HOME });
  await h2.callUnknown('McpY', { payload: { body: 'z'.repeat(100) } });
  assert.ok(!h2.writes.some((w) => w.path.includes('/wb-ops/debug/')), '小输出不打扰');
});

test('toolNameOf：多候选取第一个字符串', () => {
  assert.equal(toolNameOf({ tool: 'Bash' }), 'Bash');
  assert.equal(toolNameOf({ toolName: 'Grep' }), 'Grep');
  assert.equal(toolNameOf({}), '?');
});

test('usage 探测：函数不存在 → err 记述、不炸', async () => {
  const p = await probeUsage({ session: {} });
  assert.match(String(p.err), /not a function/);
  assert.equal(p.shape, undefined);
});

test('usage 探测：抛错 → err 记述、不炸', async () => {
  const p = await probeUsage({ session: { usage: async () => { throw new Error('usage unavailable'); } } });
  assert.match(String(p.err), /usage unavailable/);
});

test('usage 探测：deny 形态被识别（宿主未接线该能力）', async () => {
  const p = await probeUsage({ session: { usage: async () => ({ deny: '$.session.usage is unavailable: the host did not wire this capability' }) } });
  assert.match(String(p.deny), /not wire this capability/);
  assert.ok(p.shape);
});

test('usage 探测：值形状被记录（{value:…} 包装看得见）', async () => {
  const p = await probeUsage({ session: { usage: async () => ({ value: { used: 100, size: 200 } }) } });
  const text = JSON.stringify(p.shape);
  assert.ok(text.includes('value'), '包装层键名在');
  assert.ok(text.includes('used') && text.includes('size'), '内层键名在');
});

test('usage 探测：形状未变不重复落盘（热路径纪律）', async () => {
  const h = harness({ env: HOME, usage: { used: 1000, size: 20000 } });
  await h.firePrompt();
  const first = h.writes.filter((w) => w.path.includes('/wb-ops/debug/usage-')).length;
  await h.firePrompt();
  const second = h.writes.filter((w) => w.path.includes('/wb-ops/debug/usage-')).length;
  assert.equal(first, second, '形状没变不重复写');
});

// ---------------------------------------------------------------- v0.12 水位数据源

const SID = 'deadbeef-0000-1111';
const SLUG = 'c-Users-kingdee-work-wb-ops';
const TX_PATH = `C:/tmp-home/.workbuddy/projects/${SLUG}/${SID}.jsonl`;
const ZERO_USAGE = { context: { tokens: 0, window: 300000, percent: 0 }, rateLimits: [] };

/** 造一份最小 transcript：尾部一条模型响应带真实 inputTokens（含 cache_read 子集，不另加）。 */
function transcript(last = 71198): string {
  const rows = [
    { providerData: { usage: { requests: 1, inputTokens: 31737, outputTokens: 836, inputTokensDetails: [{ cached_tokens: 13120 }] } } },
    { type: 'function_call_result', result: 'noise with inputTokens text but no numbers' },
    { providerData: { usage: { requests: 1, inputTokens: last, outputTokens: 1024 } }, message: { usage: { input_tokens: last, cache_read_input_tokens: 69376 } } },
  ];
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

test('v0.12 pickWatermark：宿主嵌套 context.{tokens,window} 形状 + tokens=0 视为无数据', () => {
  assert.deepEqual(pickWatermark({ context: { tokens: 71198, window: 300000, percent: 24 }, rateLimits: [] }), { used: 71198, size: 300000 });
  assert.equal(pickWatermark(ZERO_USAGE), null, '宿主 binding 恒 0 时不假报水位');
  assert.equal(pickWatermark({ context: { tokens: -1, window: 300000 } }), null);
  assert.equal(pickWatermark({ context: { tokens: 100, window: 0 } }), null);
  assert.equal(pickWindow(ZERO_USAGE), 300000, 'window 是真算的，恒 0 时也要能取出来');
  assert.equal(pickWindow({ size: 20000 }), 20000, '老形状兼容');
  assert.equal(pickWindow({ mystery: true }), 0);
});

test('v0.12 projectSlug：Windows / Git Bash 路径都归一到宿主目录名', () => {
  assert.equal(projectSlug('C:\\Users\\kingdee\\work\\wb-ops'), SLUG);
  assert.equal(projectSlug('C:/Users/kingdee/work/wb-ops/'), SLUG);
  assert.equal(projectSlug('/c/Users/kingdee/work/wb-ops'), SLUG);
  assert.equal(projectSlug(''), '');
});

test('v0.12 lastInputTokens：尾部逆扫 / 坏行跳过 / 40 行封顶 / 不重复叠加 cache_read', () => {
  assert.equal(lastInputTokens(transcript()), 71198);
  assert.equal(lastInputTokens(transcript(120000)), 120000);
  assert.equal(lastInputTokens('{"x":1}\nnot json {inputTokens: 5}\n'), undefined, '坏行不误判');
  assert.equal(lastInputTokens(''), undefined);
  const far = Array.from({ length: 3 }, (_, i) => JSON.stringify({ providerData: { usage: { inputTokens: i + 1 } } }))
    .concat(Array.from({ length: 45 }, () => '{"noise":1}')).join('\n');
  assert.equal(lastInputTokens(far), undefined, '回看封顶 40 行，不整篇扫描');
});

test('v0.12 读权限探测：直接命中 slug 路径 + 只回传结构不回传正文', async () => {
  const h = harness({ env: HOME, files: { [TX_PATH]: transcript() } });
  const p = await probeTranscript(h.$, 'C:/tmp-home', SID, 'C:\\Users\\kingdee\\work\\wb-ops');
  assert.equal(p.used, 71198);
  assert.equal(p.path, TX_PATH);
  assert.ok(p.bytes && p.bytes > 0);
  assert.equal(p.err, undefined);
});

test('v0.12 读权限探测：slug 猜不中 → 列目录找 <sid>.jsonl（自定义 cwd 场景）', async () => {
  const p2 = `C:/tmp-home/.workbuddy/projects/custom-dir/${SID}.jsonl`;
  const h = harness({ env: HOME, cwd: '', list: ['custom-dir'], files: { [p2]: transcript(90000) } });
  const p = await probeTranscript(h.$, 'C:/tmp-home', SID, '');
  assert.equal(p.used, 90000);
  assert.equal(p.path, p2);
});

test('v0.12 读权限探测：沙箱拒绝读 → 有 err 不抛；projects 目录可用 WB_OPS_PROJECTS 覆盖', async () => {
  const h1 = harness({ env: HOME, readFail: true });
  const p1 = await probeTranscript(h1.$, 'C:/tmp-home', SID, 'C:\\Users\\kingdee\\work\\wb-ops');
  assert.ok(p1.err && !p1.used, '读失败只回 err');
  const p3 = `C:/custom/${SLUG}/${SID}.jsonl`;
  const h2 = harness({ env: { ...HOME, WB_OPS_PROJECTS: 'C:/custom' }, files: { [p3]: transcript(50000) } });
  const p2 = await probeTranscript(h2.$, 'C:/tmp-home', SID, 'C:\\Users\\kingdee\\work\\wb-ops', 'C:/custom');
  assert.equal(p2.used, 50000);
  assert.equal(p2.path, p3);
});

// v0.12.1：宿主 transcript 只增不减，长会话实测 20MB+（见 MEMORY「遗留」）。
// 旧实现对 >8MB 直接判 'transcript too big' → 长会话 fallback 永久失效，
// 而 usage 恰好在 pre-message-auto compact 后会短暂归零 → 那个窗口正好撞上体积上限。
// 新行为：仍读全文，但只解析尾部；truncated 标记进 debug。
test('v0.12.1 超大 transcript：不再整体拒绝，尾部采样仍能取到水位', async () => {
  // 造一个 >8MB 的 transcript：前面 9MB 噪音，末尾是带 inputTokens 的行
  const noise = 'x'.repeat(9_000_000);
  const big = `${noise}\n${JSON.stringify({ providerData: { usage: { inputTokens: 410003 } } })}\n`;
  assert.ok(Buffer.byteLength(big, 'utf8') > 8_000_000, '样本确实超 8MB');
  const h = harness({ env: HOME, files: { [TX_PATH]: big } });
  const p = await probeTranscript(h.$, 'C:/tmp-home', SID, 'C:\\Users\\kingdee\\work\\wb-ops');
  assert.equal(p.used, 410003, '超大文件仍能提取水位');
  assert.equal(p.truncated, true, '标记为已截断');
  assert.equal(p.err, undefined, '不再因为体积整条链路失守');
  assert.ok((p.bytes ?? 0) > 8_000_000, '字节数取自 fs.stat');
});

test('v0.12.1 正常体积 transcript：truncated=false，不受影响', async () => {
  const h = harness({ env: HOME, files: { [TX_PATH]: transcript() } });
  const p = await probeTranscript(h.$, 'C:/tmp-home', SID, 'C:\\Users\\kingdee\\work\\wb-ops');
  assert.equal(p.used, 71198);
  assert.equal(p.truncated, false);
});

test('v0.12.1 lastInputTokens 支持分段起点：from 之前的行不参与扫描', () => {
  const txt = `${JSON.stringify({ providerData: { usage: { inputTokens: 111 } } })}\n${JSON.stringify({ providerData: { usage: { inputTokens: 222 } } })}\n`;
  assert.equal(lastInputTokens(txt), 222, '默认取最后一条');
  const from = txt.indexOf('\n') + 1;
  assert.equal(lastInputTokens(txt, from), 222, 'from 落在两条中间时仍取最后一条');
  const from2 = txt.length;   // 分段起点在文末 → 无可扫行
  assert.equal(lastInputTokens(txt, from2), undefined, '分段内没有完整行时判不出');
});

test('v0.12 水位守卫：宿主 usage 恒 0 → transcript fallback 点亮提醒与余量文件', async () => {
  const h = harness({
    env: { ...HOME, WB_OPS_GUARD_PCT: '10' }, usage: ZERO_USAGE,
    files: { [TX_PATH]: transcript() },
  });
  const res = await h.firePrompt('继续');
  assert.equal(res.text, '继续');
  assert.equal(res.context.length, 1, '71198/300000≈24% 越 10% 阈值必须提醒');
  assert.match(res.context[0], /wb-ops 水位/);
  const wm = h.writes.find((w) => w.path.endsWith('/wb-ops/watermark/deadbeef.num'));
  assert.ok(wm, '余量文件已写');
  assert.ok(wm.text.includes('来源 transcript'), '数值行标明数据源');
  assert.ok(h.writes.some((w) => w.path.includes('/wb-ops/debug/fsprobe-')), '沙箱读权限探测落盘');
  const dbg = h.writes.find((w) => w.path.includes('/wb-ops/debug/fsprobe-'));
  assert.ok(!dbg.text.includes('noise') && !dbg.text.includes('function_call_result'), 'debug 不含正文');
});

test('v0.12 水位守卫：transcript 读不到/读抛错 → 静默，恒等透传（fail-open）', async () => {
  const h1 = harness({ env: HOME, usage: ZERO_USAGE });
  assert.deepEqual(await h1.firePrompt('hi'), { text: 'hi' });
  assert.ok(h1.writes.some((w) => w.path.includes('/wb-ops/debug/fsprobe-')), '失败也记一条探测');
  const h2 = harness({ env: HOME, usage: ZERO_USAGE, readFail: true });
  assert.deepEqual(await h2.firePrompt('hi'), { text: 'hi' });
});

test('v0.12 WB_OPS_GUARD_FS=0 → 零 transcript IO；宿主自己出数时不走 fallback', async () => {
  const h1 = harness({ env: { ...HOME, WB_OPS_GUARD_FS: '0' }, usage: ZERO_USAGE, files: { [TX_PATH]: transcript() } });
  assert.deepEqual(await h1.firePrompt('hi'), { text: 'hi' });
  assert.ok(!h1.reads.some((r) => r.includes('/projects/')), '关掉后不碰 transcript');
  const h2 = harness({ env: HOME, usage: { used: 500, size: 1000 }, files: { [TX_PATH]: transcript() } });
  await h2.firePrompt('hi');
  assert.ok(!h2.reads.some((r) => r.includes('/projects/')), 'usage 自己有数时不读 transcript');
});

test('v0.12 watermarkLine 数据源标注（老调用不传参保持兼容）', () => {
  assert.match(watermarkLine({ used: 100, size: 200 }), /已用 100\/200 tok/);
  assert.match(watermarkLine({ used: 100, size: 200 }, 'transcript'), /来源 transcript/);
  assert.ok(!watermarkLine({ used: 100, size: 200 }).includes('来源'), '默认不加标注');
});
