#!/usr/bin/env node
// ④ GUI 安装助手：把本仓库以「directory marketplace + 已安装插件」的宿主落盘格式写入
// ~/.workbuddy/plugins/{known_marketplaces.json,installed_plugins.json}，
// 并把 payload 复制到 marketplaces/ 与 cache/——形状取自本机宿主为其他插件写下的真实文件（含 sana wb-ops 的 local@ 记录）。
// GUI 点击流本身仍需用户在界面确认；本脚本只保证登记数据与宿主自写的一致。
// 用法：node scripts/install-gui.mjs [--uninstall]
// 测试钩子：WB_OPS_INSTALL_HOME 覆盖家目录（单测用临时目录，不碰真实 ~/.workbuddy）。
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = process.env.WB_OPS_INSTALL_HOME || homedir();
const ROOT = process.env.WB_OPS_GUI_ROOT || HOME + '/.workbuddy/plugins';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MKT = 'wb-ops-local';
const PID = 'wb-ops'; // 注意：与 sana 的同名插件互斥——GUI 侧只保留一个 wb-ops
const NOW = () => new Date().toISOString();

const version = JSON.parse(readFileSync(join(REPO, '.codebuddy-plugin', 'plugin.json'), 'utf8')).version;
const mkPath = join(ROOT, 'marketplaces', MKT);
const cachePath = join(ROOT, 'cache', MKT, PID, version);
const knownFile = join(ROOT, 'known_marketplaces.json');
const instFile = join(ROOT, 'installed_plugins.json');

function atomicWrite(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function copyPayload() {
  // 市场目录：marketplaces/<MKT>/wb-ops/{.codebuddy-plugin,hooks}
  const mktPlugin = join(mkPath, PID);
  rmSync(mktPlugin, { recursive: true, force: true });
  mkdirSync(mktPlugin, { recursive: true });
  for (const d of ['.codebuddy-plugin', 'hooks']) cpSync(join(REPO, d), join(mktPlugin, d), { recursive: true });
  // 缓存目录：cache/<MKT>/wb-ops/<version>/ 同 payload（宿主把「已安装版本」冻结在 cache）
  rmSync(cachePath, { recursive: true, force: true });
  mkdirSync(cachePath, { recursive: true });
  for (const d of ['.codebuddy-plugin', 'hooks']) cpSync(join(REPO, d), join(cachePath, d), { recursive: true });
}

function uninstall() {
  const known = readJson(knownFile, {});
  delete known[MKT];
  atomicWrite(knownFile, known);
  const inst = readJson(instFile, { version: 2, plugins: {} });
  delete (inst.plugins || {})[`${PID}@${MKT}`];
  atomicWrite(instFile, inst);
  rmSync(join(mkPath, PID), { recursive: true, force: true });
  rmSync(join(ROOT, 'cache', MKT), { recursive: true, force: true });
  console.log('[install-gui] 已移除 ' + MKT + ' 登记（其他市场未触碰）');
}

function install() {
  copyPayload();
  const known = readJson(knownFile, {});
  if (existsSync(knownFile)) {
    for (const k of Object.keys(known)) if (k !== MKT && known[k].isBuiltIn === undefined && known[k].type === 'directory' && /wb-ops/i.test(k)) {
      // 同机若已有别的 wb-ops 本地市场，提示但不删除
      console.log('[install-gui] 注意：已存在本地市场 ' + k + '，GUI 里可能出现两个 wb-ops');
    }
  }
  known[MKT] = {
    manifestName: MKT,
    type: 'directory',
    source: { source: 'directory', path: mkPath },
    installLocation: mkPath,
    description: 'wb-ops 本地目录市场（scripts/install-gui.mjs 写入）',
    lastUpdated: NOW(),
    autoUpdate: false,
  };
  atomicWrite(knownFile, known);
  const inst = readJson(instFile, { version: 2, plugins: {} });
  inst.plugins = inst.plugins || {};
  const prev = (inst.plugins[`${PID}@${MKT}`] || [{}])[0];
  inst.plugins[`${PID}@${MKT}`] = [{
    scope: 'user',
    installPath: cachePath,
    version,
    installedAt: prev.installedAt || NOW(),
    lastUpdated: NOW(),
  }];
  atomicWrite(instFile, inst);
  console.log(`[install-gui] wb-ops@${MKT} v${version} 已登记`);
  console.log('  marketplaces: ' + mkPath + '\\' + PID);
  console.log('  cache:        ' + cachePath);
  console.log('  重启 WorkBuddy GUI，在插件管理里确认 wb-ops 出现并启用（这一步需人工点击）。');
  console.log('  卸载：node scripts/install-gui.mjs --uninstall');
}

if (process.argv.includes('--uninstall')) uninstall(); else install();
