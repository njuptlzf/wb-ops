/**
 * wb-bash-ops — WorkBuddy Mod：Bash 输出治理（进程内，确定性，fail-open）
 *
 * 设计规则（源自 sana35421/wb-ops 的 UserPromptSubmit 5s 超时事故分析，见 README）：
 *  1. 零子进程：只做 Mods 的 tool.call 中间件，不注册任何 shell hook。
 *  2. fail-open：未知形状、任何异常、超预算(时间) —— 一律原样返回工具结果。
 *  3. 错误透传：isError 或 Exit Code 非零的输出不压缩（遏制报错重试循环，保完整现场）。
 *  4. 确定性策略：head/tail + 强关键词行 + 原文落盘（spill）带回查路径，热路径无 LLM。
 *  5. 并发安全：无共享可变状态文件；spill 文件名含 session/callId/序号，互不覆盖。
 *  6. 双压缩防护：已带本插件或 wb-ops 标记的文本不再处理。
 *
 * 沙箱约束：mods 内禁止 node:require/process/global —— 本文件零运行时 import；
 * 文件系统走 $.fs，环境变量走 $.env，会话走 $.session。
 */

import type { On } from 'codebuddy-code';

const MARKER = '[wb-bash-ops]';
const FOREIGN_MARKER = '[wb-ops]';           // sana35421/wb-ops 的标记，共存防双压

const DEFAULT_BUDGET = 8000;                 // 最终文本长度上限（字符≈ASCII字节）
const DEFAULT_DEADLINE_MS = 100;             // 压缩自设软超时；超时放弃，返回原文
const HEAD_MAX_LINES = 12;
const STRONG_MAX_LINES = 40;
const LINE_MAX_CHARS = 300;
const SECTION_FRAC = { head: 0.3, strong: 0.3, tail: 0.35 };
const STRONG = /(error|fatal|exception|traceback|panic|failed|failure|cannot|denied|not found|undefined reference|segmentation|core dumped|abort(ed|ing)?|assert|✗|✖|×|\bexited with code\b)/i;

/** 已解析的配置；null = 尚未读 */
interface Cfg { enabled: boolean; budget: number; deadlineMs: number; home: string; }

type Sink = { put: (s: string) => unknown };

export interface Compression { text: string; dropped: number; }

// ---------------------------------------------------------------- text shape

/** 从未知形状的 ToolResult 中提取可安全替换的纯文本；未知形状返回 null（透传）。 */
export function extractText(res: unknown): { raw: string; sink: Sink } | null {
  if (typeof res === 'string') return { raw: res, sink: { put: (s) => s } };
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    if (typeof o.text === 'string') return { raw: o.text, sink: { put: (s) => ({ ...o, text: s }) } };
    if (typeof o.content === 'string') return { raw: o.content, sink: { put: (s) => ({ ...o, content: s }) } };
    if (Array.isArray(o.content)) {
      const texts = o.content.filter((b) => b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string');
      if (texts.length === 1 && texts[0].text.length > 0) {
        const i = o.content.indexOf(texts[0]);
        return {
          raw: texts[0].text,
          sink: { put: (s) => { const c = o.content.slice(); c[i] = { ...c[i], text: s }; return { ...o, content: c }; } },
        };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ policy

/** 提取尾部 Exit Code；非零（或含外部标记/过小）时返回 null 表示不压缩。 */
export function exitCodeOf(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /Exit Code:\s*(-?\d+)\s*$/i.exec(lines[i]);
    if (m) return parseInt(m[1], 10);
  }
  return null; // 没有退出码行（例如非 Bash 包装格式）：由调用方决定
}

/**
 * 纯函数压缩核心。返回 null = 放弃（调用方透传原文）。
 * budget：最终文本字符上限；deadlineMs：自设软超时（Date.now 检查，超时=放弃）。
 * 已知上限：按字符近似字节（对非 ASCII 输出偏保守）；整段 split 是一次性成本，
 * 超大输入由调用方的 hard-skip 兜底（本核心不做增量扫描）。
 */
export function compress(raw: string, budget: number, deadlineMs: number, spillPath: string | null): Compression | null {
  if (raw.length <= budget) return null;
  if (raw.indexOf(MARKER) >= 0 || raw.indexOf(FOREIGN_MARKER) >= 0) return null;
  const start = Date.now();
  const lines = raw.split('\n');
  const code = exitCodeOf(lines);
  if (code !== null && code !== 0) return null; // 错误现场：完整透传

  const head = lines.slice(0, HEAD_MAX_LINES);
  // 尾部：最后 8 行保底（含 Exit Code / Stderr 段尾），直到预算
  const tailN = Math.min(lines.length - head.length, 10);
  const tail = lines.slice(lines.length - tailN);
  const strong: string[] = [];
  let dropped = 0;

  const fit = (arr: string[], cap: number) => {
    let n = 0, k = 0;
    for (const l of arr) { n += Math.min(l.length, LINE_MAX_CHARS) + 1; if (n > cap) break; k++; }
    return k;
  };
  const headKeep = fit(head, budget * SECTION_FRAC.head);
  const tailKeep = fit(tail.slice().reverse(), budget * SECTION_FRAC.tail);
  const tailFinal = tail.slice(tail.length - tailKeep);

  for (let i = headKeep; i < lines.length - tailKeep; i++) {
    if ((i & 511) === 0 && Date.now() - start >= deadlineMs) return null; // 软超时
    const l = lines[i];
    if (l.length > 0 && STRONG.test(l)) {
      strong.push(l.length > LINE_MAX_CHARS ? l.slice(0, LINE_MAX_CHARS) + `…[+${l.length - LINE_MAX_CHARS}字符]` : l);
      if (strong.length >= STRONG_MAX_LINES || strong.join('\n').length > budget * SECTION_FRAC.strong) { strong.pop(); break; }
    }
  }
  dropped = lines.length - headKeep - tailFinal.length - strong.length;
  if (dropped < 0) dropped = 0;

  const note = `${MARKER} 已省略 ${dropped} 行 · 原文 ${raw.length}B → ${spillPath ? '落盘 ' + spillPath : '未落盘（写入失败，可重跑命令）'}`;
  const parts = [head.slice(0, headKeep).join('\n'), note];
  if (strong.length) parts.push(`--- 命中标记行 (${strong.length}) ---`, strong.join('\n'));
  parts.push('--- 尾部 ---', tailFinal.join('\n'));
  let text = parts.filter(Boolean).join('\n');
  if (text.length > budget + 600) { // 兜底硬截（极端长行）
    text = text.slice(0, budget + 600) + `\n${MARKER} …截断`;
  }
  return { text, dropped };
}

// ------------------------------------------------------------------ config

async function readCfg($: any): Promise<Cfg> {
  const g = async (k: string): Promise<string> => {
    try { return String((await $.env.get(k)) ?? ''); } catch { return ''; }
  };
  const off = /^(0|off|false|no)$/i.test((await g('WB_BASH_OPS')).trim());
  const budget = parseInt(await g('WB_BASH_OPS_BUDGET'), 10);
  const deadline = parseInt(await g('WB_BASH_OPS_DEADLINE_MS'), 10);
  const home = (await g('USERPROFILE')) || (await g('HOME')) || '';
  return {
    enabled: !off,
    budget: budget > 512 ? budget : DEFAULT_BUDGET,
    deadlineMs: deadline >= 0 ? deadline : DEFAULT_DEADLINE_MS,
    home,
  };
}

let seq = 0;

async function spillRaw($: any, e: any, text: string, home: string): Promise<string | null> {
  if (!home) return null;
  try {
    let sid = 'nosid';
    try { sid = String(await $.session.id()).slice(0, 8); } catch { /* 默认 */ }
    const call = String(e?.callId ?? e?.call_id ?? Date.now()).replace(/[^\w.-]/g, '_').slice(0, 40);
    const name = `${(++seq) % 10000}-${call}.txt`;
    const path = `${home.replace(/\\/g, '/')}/.workbuddy/wb-bash-ops/spill/${sid}/${name}`;
    await $.fs.write(path, text);
    return path;
  } catch {
    return null; // 落盘失败：仍压缩，但标记如实说明原文未保留
  }
}

// ------------------------------------------------------------------ entry

export function register(on: On, _options?: unknown): void {
  let cfgP: Promise<Cfg> | null = null;

  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    const r = await next(e);                 // 工具照常执行一次
    try {
      if (!r || typeof r !== 'object' || r.isError) return r;
      if (!cfgP) cfgP = readCfg($);
      const cfg = await cfgP;
      if (!cfg.enabled) return r;
      const t = extractText(r.result);
      if (!t || t.raw.length <= cfg.budget) return r;
      // 压缩前廉价预判（避免为注定透传的输出白白 split/落盘）：
      if (t.raw.indexOf(MARKER) >= 0 || t.raw.indexOf(FOREIGN_MARKER) >= 0) return r;
      const tail = t.raw.slice(-2000);
      const codes = tail.match(/Exit Code:\s*(-?\d+)/gi);
      if (codes && codes.length) {
        const last = parseInt(codes[codes.length - 1].replace(/.*?:\s*/, ''), 10);
        if (Number.isFinite(last) && last !== 0) return r; // 错误现场完整透传
      }

      const path = await spillRaw($, e, t.raw, cfg.home); // 先落盘，再按路径写标记
      const out = compress(t.raw, cfg.budget, cfg.deadlineMs, path);
      if (!out) return r;                    // 放弃压缩（含透传条件/软超时）
      return { ...r, result: t.sink.put(out.text) };
    } catch {
      return r;                              // fail-open：任何问题都不影响工具结果
    }
  });
}
