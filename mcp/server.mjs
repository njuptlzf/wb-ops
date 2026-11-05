#!/usr/bin/env node
// wb-ops 报表 MCP 服务器（stdio / JSON-RPC 2.0，逐行）。
//
// 为什么是 MCP 而不是 mod 的 $.tool.register（v0.13.1 的教训）：
//   宿主有两条 core。应用级（hostBindings）的 registerTool 是真实现，但**会话级**
//   （createFunctionalHookBindings → createFunctionalHooks）把它硬绑成
//   `throw Error("Session tool registration is not bound")`。GUI 会话里 mod 的每个钩子
//   （session.start / prompt.submit / …）拿到的都是同一个会话级 core，所以「换时机重试」
//   不可能成功——能力差异不在时机，在 core。
//   插件清单的 mcpServers 由宿主 MCP 管理器起进程并注册工具，与 mod core 无关，
//   两条路径都通。工具名固定为 mcp__<serverKey>__<tool> = mcp__wb_ops__report。
//
// 纪律：stdout 只许出现 JSON-RPC 报文（任何多余字符都会让宿主解析失败），日志一律 stderr。
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRows, renderSummary } from '../lib/report-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_NAME = 'report';
const SERVER_NAME = 'wb-ops-report';
const FALLBACK_PROTOCOL = '2024-11-05';

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(join(HERE, '..', '.codebuddy-plugin', 'plugin.json'), 'utf8')).version || VERSION;
} catch {
  /* 清单读不到不影响工具本体 */
}

const TOOL = {
  name: TOOL_NAME,
  description: 'wb-ops 节省报表：各会话压缩次数、原文/压缩后字节与估算 token、节省比例。只读，无参数。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const HANDLERS = {
  initialize: (params) => ({
    // 回显客户端给的版本：宿主按自己支持的版本发，回显比硬编码更不容易被拒。
    protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: VERSION },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: [TOOL] }),
  'tools/call': (params) => {
    if (params?.name !== TOOL_NAME) throw new RpcError(-32602, `Unknown tool: ${String(params?.name)}`);
    // fail-open：读账本出错也要给模型一条可读文本，不能把工具调用变成异常。
    let text;
    try {
      text = renderSummary(collectRows());
    } catch (e) {
      text = `[wb-ops] 报表读取失败: ${String(e?.message ?? e)}`;
    }
    return { content: [{ type: 'text', text }], isError: false };
  },
  // 有些客户端会无条件探一遍这两类能力，给空列表比报错省事。
  'resources/list': () => ({ resources: [] }),
  'prompts/list': () => ({ prompts: [] }),
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // 非 JSON 行忽略（宿主不会发，但别让一行脏数据搞死服务器）
  }
  if (!msg || typeof msg.method !== 'string') return;
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) return; // notification（如 notifications/initialized）无需应答
  const handler = HANDLERS[msg.method];
  if (!handler) return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  try {
    reply(msg.id, handler(msg.params));
  } catch (e) {
    fail(msg.id, e?.code ?? -32603, String(e?.message ?? e));
  }
});

rl.on('close', () => process.exit(0));
// 宿主关管道时的兜底：静默退出，不留孤儿进程。
process.stdin.on('error', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));

process.stderr.write(`[wb-ops] report MCP 就绪（stdio, v${VERSION}）\n`);
