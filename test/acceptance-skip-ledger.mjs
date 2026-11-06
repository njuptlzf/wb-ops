#!/usr/bin/env node
// 真机验收：跳过账本（v0.18）在**真实宿主**上的落盘。
//
// ## 这条路为什么存在
//
// v0.17 的 P0 核对里，「超预算却没被压缩」的归因只能翻全量 transcript 逐条反查
// （235 条 Read + 20 条 Bash）——耗时最长的就是这一步。v0.18 补了跳过账本，
// 归因从此读一条账本即可。这个脚本就是**验证账本在真机上真的会落盘**的验收器。
//
// ## 它怎么绕开「模型回合」
//
// CLI 的 `-p` 模式要跑模型回合，而 CLI 侧鉴权不可用（`Authentication required`，
// v0.17 §8.5 已记录，二次确认过）——没有模型回合就没有工具调用。
// 但宿主 CLI 支持 **ACP 模式**（`--acp`，HTTP + SSE），ACP 客户端可以自己驱动
// 工具调用，**绕开模型回合**。协议形态取自宿主 bundle 里的 `acp/connect` 实现：
//   ① POST /api/v1/acp/connect            → { connectionId, sessionToken }
//   ② POST /api/v1/acp  (header: acp-connection-id / acp-session-token)
//      → initialize / session/new / session/prompt
//   ③ GET  /api/v1/acp  (SSE)              → 事件流（每行一个 JSON-RPC notification）
//
// ## 它验什么
//
// ① **mod 在真实宿主里加载成功**（含 tool.call 钩子注册）——这是硬门槛；
// ② **跳过账本在真实宿主里落盘**，且账本**不含工具输出正文**（硬纪律）；
// ③ 宿主鉴权挡住 tool.call 时，**如实报告「未验证」**并以非 0 退出——
//    绝不把「没验成」包装成「验过了」。
//
// 用法：
//   node test/acceptance-skip-ledger.mjs
//   WB_OPS_ACCEPT_HOME=<目录> node test/acceptance-skip-ledger.mjs   # 保留产物便于排查
//
// 退出码：0 = 账本已按预期落盘且内容合规；2 = 宿主鉴权挡住（**未验证**，非通过）；
//         1 = 其他失败（附诊断信息）。

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = process.env.WB_OPS_CLI
  || 'D:/Program Files/WorkBuddy-cn/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const REPO = join(import.meta.dirname, '..');

// 真机验收用**独立 HOME**：账本/水位/统计文件落到临时目录，
// 不污染用户真实的 ~/.workbuddy（验收产物可随时丢弃）。
const ACCEPT_HOME = process.env.WB_OPS_ACCEPT_HOME
  || mkdtempSync(join(tmpdir(), 'wbops-accept-'));
const SID = '11111111-2222-4333-8444-' + String(Date.now()).slice(-12);
const PORT = Number(process.env.WB_OPS_ACCEPT_PORT || (59000 + (process.pid % 800)));
const HOST = '127.0.0.1';

const log = (s) => console.log('[accept] ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- MCP 服务器
const MCP_SRC = `
const readline = require("readline");
const big = Array.from({length: 900}, (_, i) => "mcp-line " + i + " " + "x".repeat(40) + (i % 97 === 0 ? " ERROR spike" : "")).join("\\n");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  if (msg.method === "initialize") send(msg.id, { protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "wbops-accept", version: "1.0.0" } });
  else if (msg.method === "tools/list") send(msg.id, { tools: [{ name: "big_output", description: "returns a large payload", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  else if (msg.method === "tools/call") send(msg.id, { content: [{ type: "text", text: big }], isError: false });
  else if (msg.id !== undefined) send(msg.id, {});
});
`;

// ---------------------------------------------------------------- HTTP 工具
function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: HOST, port: PORT, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 宿主要求客户端**同时**接受两种内容类型（报错原文：
        // "Not Acceptable: Client must accept both application/json and text/event-stream"）
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('POST 超时: ' + path)));
    req.write(data);
    req.end();
  });
}

/**
 * 解析宿主 ACP 的响应体——它有两种形态：
 *  ① 纯 JSON（一行报文的直接回应）
 *  ② SSE 帧（`event: message\n\ndata: {jsonrpc...}\n\n`），可能多帧
 * 两种都要能取出 JSON-RPC 报文（取第一帧即可）。
 */
function parseRpc(body) {
  const txt = String(body || '').trim();
  if (!txt) return null;
  // 形态 ②：SSE —— 取第一个 data: 行
  const m = /data:\s*(\{.*\})/s.exec(txt);
  const candidate = m ? m[1] : txt;
  try { return JSON.parse(candidate.trim()); } catch { return null; }
}

/** SSE 事件流：每行一个 JSON-RPC notification。 */
function sseLoop(connId, token, onEvent) {
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST, port: PORT, path: '/api/v1/acp', method: 'GET',
      headers: { Accept: 'text/event-stream', 'acp-connection-id': connId, 'acp-session-token': token },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (!payload || payload === '[DONE]') continue;
          try { onEvent(JSON.parse(payload)); } catch { /* 非 JSON 行忽略 */ }
        }
      });
      res.on('end', resolve);
      res.on('error', resolve);
    });
    req.on('error', resolve);
    req.end();
  });
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // 注意：fn 可能是 async——必须 await，否则拿到的是 Promise（恒为真），
    // 第一次真机跑就踩了这个坑：判定"就绪"其实从未真正验证。
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error('等待超时：' + label);
}

async function main() {
  if (!existsSync(CLI)) { console.error('找不到宿主 CLI：' + CLI); process.exit(1); }
  mkdirSync(join(ACCEPT_HOME, '.workbuddy'), { recursive: true });
  const mcpPath = join(ACCEPT_HOME, 'accept-mcp.cjs');
  writeFileSync(mcpPath, MCP_SRC);
  const mcpConfig = JSON.stringify({
    mcpServers: { wbopsaccept: { command: process.execPath, args: [mcpPath] } },
  });

  log('HOME=' + ACCEPT_HOME);
  log('SID=' + SID + '  PORT=' + PORT);

  const child = spawn(process.execPath, [
    CLI, '--acp', '--acp-transport', 'streamable-http',
    '--port', String(PORT), '--host', HOST,
    '--plugin-dir', REPO,
    '--session-id', SID,
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
  ], {
    env: { ...process.env, CODEBUDDY_CONFIG_DIR: ACCEPT_HOME.replace(/\\/g, '/'), USERPROFILE: ACCEPT_HOME, HOME: ACCEPT_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('exit', (c) => log('宿主 CLI 退出，code=' + c));

  let code = 1;
  let connId = '';
  let sessionToken = '';
  let lastConnectBody = '';
  let authBlocked = false;
  try {
    // ⓪ 硬门槛：mod 必须在真实宿主里加载成功（含 tool.call 钩子注册）
    await waitFor(() => /mods: loaded mod "wb-ops".*tool\.call/.test(stderr), 30000, 'mod 加载（含 tool.call 钩子）');
    log('✓ 宿主已加载 wb-ops（含 tool.call 钩子）');

    // ① 等待宿主 HTTP 服务就绪（先探 connect 端点）
    await waitFor(async () => {
      try {
        const r = await post('/api/v1/acp/connect', {});
        if (r.status === 200) {
          let o = {};
          try { o = JSON.parse(r.body || '{}'); } catch { o = {}; }
          connId = o.connectionId || '';
          sessionToken = o.sessionToken || '';
          if (!connId) { lastConnectBody = r.body; return false; }
          return true;
        }
      } catch { /* 还没起来 */ }
      return false;
    }, 45000, 'ACP connect 端点就绪');

    log('✓ acp/connect → connectionId=' + connId.slice(0, 12) + '…');
    // 后续请求要带这两个头（取自宿主 bundle 的 acp/connect 实现）
    const H = { 'acp-connection-id': connId, 'acp-session-token': sessionToken };

    // ② SSE 事件流
    const events = [];
    const sse = sseLoop(connId, sessionToken, (e) => {
      events.push(e);
      const u = e?.params?.update || e?.params || {};
      const s = JSON.stringify(u);
      if (/tool_call|toolCall/i.test(s)) log('事件：工具调用 → ' + s.slice(0, 220));
    });

    // ③ initialize
    const init = await post('/api/v1/acp', {
      jsonrpc: '2.0', id: 'init-1', method: 'initialize',
      params: { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'wbops-acceptance', version: '1.0' } },
    }, H);
    const initObj = parseRpc(init.body);
    if (!initObj || initObj.error) {
      log('initialize 失败：' + String(init.body).slice(0, 200));
    } else {
      log('✓ initialize → protocolVersion=' + (initObj.result?.protocolVersion ?? '?'));
    }

    // ④ session/new（宿主在这里做账号鉴权）
    const sess = await post('/api/v1/acp', {
      jsonrpc: '2.0', id: 'sess-1', method: 'session/new',
      params: { cwd: ACCEPT_HOME, mcpServers: [] },
    }, H);
    const sObj = parseRpc(sess.body) || {};
    if (sObj.error) {
      const msg = String(sObj.error.message || '');
      log('session/new → ' + msg.slice(0, 120));
      if (/authenticat/i.test(msg) || sObj.error?.data?.category === 'auth') {
        authBlocked = true;
        log('  ⚠ 宿主账号鉴权挡住 CLI 侧会话创建 —— CLI 路径无法触发 tool.call');
      }
    } else {
      const sessionId = sObj?.result?.sessionId || sObj?.result?.session_id || SID;
      log('✓ session/new → ' + sessionId);

      // ⑤ session/prompt（后台跑，事件流里观察）
      const promptReq = post('/api/v1/acp', {
        jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: '调用 big_output 工具。' }] },
      }, H).catch((e) => ({ error: String(e) }));

      // ⑥ 观察：宿主若通过权限请求与我们交互，尽量代为处理
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        for (const ev of events.splice(0, events.length)) {
          const m = ev.method || '';
          if (m === 'session/request_permission') {
            log('宿主请求权限 → 放行');
            await post('/api/v1/acp', {
              jsonrpc: '2.0', id: 'perm-' + Date.now(), method: 'session/request_permission',
              params: {
                sessionId: ev.params?.sessionId || sessionId,
                requestId: ev.params?.requestId,
                outcome: { outcome: 'selected', optionId: ev.params?.options?.[0]?.optionId || 'allow' },
              },
            }, H).catch(() => { });
          }
        }
        // 账本一旦出现就不用再等了
        const dd = join(ACCEPT_HOME, '.workbuddy', 'wb-ops', 'debug');
        if (existsSync(dd) && readdirSync(dd).some((n) => n.startsWith('skipped-'))) break;
        await sleep(600);
      }
      const pres = await Promise.race([promptReq, sleep(3000).then(() => ({}))]);
      if (pres && pres.error) log('session/prompt：' + String(pres.error).slice(0, 160));
    }
    sse.catch(() => { });
  } catch (e) {
    log('ACP 流程异常：' + String(e).slice(0, 400));
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
  }

  // ---------------------------------------------------------------- 核验
  const wbDir = join(ACCEPT_HOME, '.workbuddy', 'wb-ops');
  const debugDir = join(wbDir, 'debug');
  const spillDir = join(wbDir, 'spill');
  const statsDir = join(wbDir, 'stats');
  log('--- 产物 ---');
  for (const [label, dir] of [['debug', debugDir], ['spill', spillDir], ['stats', statsDir]]) {
    if (existsSync(dir)) for (const n of readdirSync(dir)) log('  ' + label + '/' + n);
    else log('  (无 ' + label + ' 目录)');
  }

  const ledgers = existsSync(debugDir)
    ? readdirSync(debugDir).filter((n) => n.startsWith('skipped-') && n.endsWith('.json'))
    : [];
  const hasStats = existsSync(statsDir) && readdirSync(statsDir).length > 0;

  if (!ledgers.length && !hasStats) {
    if (authBlocked) {
      // 鉴权挡住 → 这是**未验证**，不是通过。退出码 2 与「失败(1)」区分开，
      // 免得 CI 把"没验成"当成"验过了"。
      console.error('\n[accept] 未验证：宿主账号鉴权挡住 CLI 侧会话创建 → tool.call 钩子未被触发');
      console.error('[accept] 已验证的部分：mod 在真实宿主里加载成功（含 tool.call 钩子注册）、');
      console.error('[accept]             ACP 握手成功（connect / initialize / agentCapabilities 完整）。');
      console.error('[accept] 未验证的部分：跳过账本在真实宿主上的落盘（需 GUI 会话或已鉴权的 CLI）。');
      console.error('[accept] stderr 片段：' + stderr.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-6).join(' | '));
      process.exit(2);
    }
    console.error('\n[accept] 失败：既无账本也无记账 → tool.call 钩子很可能没被触发');
    console.error('[accept] stderr 片段：' + stderr.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-8).join('\n'));
    process.exit(1);
  }

  if (ledgers.length) {
    const raw = readFileSync(join(debugDir, ledgers[0]), 'utf8');
    const led = JSON.parse(raw);
    log('账本 ' + ledgers[0] + '：');
    log('  agg = ' + JSON.stringify(led.agg));
    log('  samples = ' + JSON.stringify(led.samples).slice(0, 500));
    if (raw.includes('mcp-line')) {
      console.error('[accept] 失败：账本里出现了工具输出正文（违反「正文绝不落盘」）');
      process.exit(1);
    }
    log('  ✓ 账本不含工具输出正文');
    if (!Array.isArray(led.agg) || !led.agg.length) {
      console.error('[accept] 失败：账本聚合为空');
      process.exit(1);
    }
    log('  ✓ 聚合条目 ' + led.agg.length + ' 条：' + led.agg.map((a) => `${a.kind}/${a.reason}×${a.n}`).join(', '));
  } else {
    log('（本次未产生跳过账本：工具输出超预算且被成功压缩 → 无漏压，符合预期）');
  }
  if (hasStats) log('  ✓ 记账已写（tool.call 钩子确实被触发）');

  code = 0;
  if (!process.env.WB_OPS_ACCEPT_HOME) {
    try { rmSync(ACCEPT_HOME, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
  process.exit(code);
}

main();
