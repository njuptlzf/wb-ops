// 安装后验收：以**宿主的启动方式**跑一遍已安装的 wb-ops MCP 服务器，走完整 JSON-RPC 握手。
//
// 覆盖单测覆盖不到的那一段：安装树里 ../lib/report-core.mjs 能不能解析、plugin.json 的
// version 能不能读到、声明的入口路径是否真实存在。
//
// 用法: node test/probe-installed-mcp.mjs [插件根目录]
//   默认 <home>/.workbuddy/plugins/cache/wb-ops-local/wb-ops/<version>
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.USERPROFILE || process.env.HOME || homedir();
const cacheBase = join(home, '.workbuddy', 'plugins', 'cache', 'wb-ops-local', 'wb-ops');

let root = process.argv[2];
if (!root) {
  // 没给参数就取缓存里最新的版本目录
  const { readdirSync } = await import('node:fs');
  const versions = readdirSync(cacheBase).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  root = join(cacheBase, versions[versions.length - 1] || '');
}

const entry = join(root, 'mcp', 'server.mjs');
if (!existsSync(entry)) {
  console.error(`[probe] 入口不存在：${entry}\n先跑 node scripts/install-gui.mjs`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(root, '.codebuddy-plugin', 'plugin.json'), 'utf8'));
const declared = manifest.mcpServers?.wb_ops;
console.log(`[probe] 插件 ${manifest.name}@${manifest.version}`);
console.log(`[probe] 清单声明: ${declared?.command} ${(declared?.args || []).join(' ')}`);

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, CODEBUDDY_PLUGIN_ROOT: root }, // 宿主就是把这个变量替换进 args 的
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
const stderrLines = [];
child.stderr.on('data', (d) => stderrLines.push(d.trim()));

let buf = '';
const pending = new Map();
const dirty = [];
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    } catch { dirty.push(line); }
  }
});

let seq = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout ' + method)); }, 8000).unref();
});

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
const list = await rpc('tools/list');
const call = await rpc('tools/call', { name: 'report', arguments: {} });

const toolNames = list.result.tools.map((t) => t.name);
const text = call.result.content?.[0]?.text ?? '';
const ok =
  init.result.serverInfo?.version === manifest.version &&
  toolNames.includes('report') &&
  call.result.isError === false &&
  text.includes('[wb-ops');
console.log(`[probe] protocolVersion 回显 : ${init.result.protocolVersion}`);
console.log(`[probe] tools/list         : ${toolNames.join(',')}`);
console.log(`[probe] tools/call         : isError=${call.result.isError} 首行=${String(text).split('\n')[0].slice(0, 110)}`);
console.log(`[probe] stderr             : ${stderrLines.join(' | ')}`);
console.log(`[probe] stdout 脏行        : ${dirty.length}`);
console.log(ok && !dirty.length ? '[probe] ✔ 安装态 MCP 服务器可用' : '[probe] ✘ 验收失败');
child.kill();
process.exit(ok && !dirty.length ? 0 : 1);
