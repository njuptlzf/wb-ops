#!/usr/bin/env node
// ④ GUI 安装助手：把本仓库以「directory marketplace + 已安装插件 + 启用声明」的宿主落盘格式写入
// ~/.workbuddy/plugins/{known_marketplaces.json,installed_plugins.json} 与 ~/.workbuddy/settings.json，
// 并把 payload 复制到 marketplaces/ 与 cache/——形状取自本机宿主为其他插件写下的真实文件（含 sana wb-ops 的 local@ 记录）。
//
// 宿主加载一个 mod 需要三处同时成立（对照宿主 bundle 的 collectModDirsWithSources /
// getInstalledPluginsForWorkspaceState 与官方文档「插件市场」页的 runtime 投影公式）：
//   1) 市场根目录有 .codebuddy-plugin/marketplace.json（列出插件，source 为相对路径）
//   2) installed_plugins.json 有 <plugin>@<marketplace> 条目（指向 cache 快照）
//   3) settings.json 的 enabledPlugins 有 "<plugin>@<marketplace>": true（期望启用态）
// 只写 2) 时插件不会出现在 /plugin 的「已安装」里，mod 也不会被加载（status=disabled）。
//
// 用法：node scripts/install-gui.mjs [--uninstall]
// 测试钩子：WB_OPS_INSTALL_HOME 覆盖家目录（单测用临时目录，不碰真实 ~/.workbuddy）。
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, cpSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = process.env.WB_OPS_INSTALL_HOME || homedir();
const ROOT = process.env.WB_OPS_GUI_ROOT || HOME + '/.workbuddy/plugins';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MKT = 'wb-ops-local';
const PID = 'wb-ops'; // 注意：与 sana 的同名插件互斥——GUI 侧只保留一个 wb-ops
const NOW = () => new Date().toISOString();

const manifest = JSON.parse(readFileSync(join(REPO, '.codebuddy-plugin', 'plugin.json'), 'utf8'));
const version = manifest.version;
const mkPath = join(ROOT, 'marketplaces', MKT);
const cachePath = join(ROOT, 'cache', MKT, PID, version);
const knownFile = join(ROOT, 'known_marketplaces.json');
const instFile = join(ROOT, 'installed_plugins.json');
const mkManifestFile = join(mkPath, '.codebuddy-plugin', 'marketplace.json');
const settingsFile = join(dirname(ROOT), 'settings.json'); // ~/.workbuddy/settings.json
const PLUGIN_ID = `${PID}@${MKT}`;

function atomicWrite(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

// 载荷目录：清单 + mod + 报表 MCP 服务器 + 共用渲染核心。
// v0.14 起 mcp/ 与 lib/ 是**运行时必需**（plugin.json 的 mcpServers 指向 mcp/server.mjs，
// 后者 import ../lib/report-core.mjs）——漏拷任何一个，工具都会在宿主侧起不来。
const PAYLOAD_DIRS = ['.codebuddy-plugin', 'hooks', 'lib', 'mcp'];

function copyDir(from, to) {
  if (!existsSync(join(REPO, from))) return;
  cpSync(join(REPO, from), join(to, from), { recursive: true });
}

function copyPayload() {
  // 市场目录：marketplaces/<MKT>/wb-ops/<payload>
  const mktPlugin = join(mkPath, PID);
  rmSync(mktPlugin, { recursive: true, force: true });
  mkdirSync(mktPlugin, { recursive: true });
  for (const d of PAYLOAD_DIRS) copyDir(d, mktPlugin);
  // 缓存目录：cache/<MKT>/wb-ops/<version>/ 同 payload（宿主把「已安装版本」冻结在 cache）
  rmSync(cachePath, { recursive: true, force: true });
  mkdirSync(cachePath, { recursive: true });
  for (const d of PAYLOAD_DIRS) copyDir(d, cachePath);
}

// 市场清单：市场根目录下 .codebuddy-plugin/marketplace.json（官方文档要求；缺了宿主列不出该市场）
function writeMarketplaceManifest() {
  mkdirSync(dirname(mkManifestFile), { recursive: true });
  atomicWrite(mkManifestFile, {
    name: MKT,
    description: 'wb-ops 本地目录市场（scripts/install-gui.mjs 写入）',
    owner: { name: 'wb-ops' },
    metadata: { version },
    plugins: [
      {
        name: PID,
        source: './' + PID,
        description: manifest.description,
        version,
        category: '工具',
      },
    ],
  });
}

// 启用声明：settings.json 的 enabledPlugins（期望态；宿主投影时与 registry + cache 一起才算数）
function setEnabledState(enabled) {
  if (!existsSync(settingsFile)) return false;
  const settings = readJson(settingsFile, {});
  const map = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? { ...settings.enabledPlugins } : {};
  if (enabled) map[PLUGIN_ID] = true;
  else delete map[PLUGIN_ID];
  if (JSON.stringify(map) === JSON.stringify(settings.enabledPlugins || {})) return false;
  // 备份原文件再改，避免破坏宿主其他设置
  try { copyFileSync(settingsFile, settingsFile + '.bak-wbops-' + NOW().slice(0, 10)); } catch { /* 备份失败不阻断安装 */ }
  settings.enabledPlugins = map;
  atomicWrite(settingsFile, settings);
  return true;
}

function uninstall() {
  const known = readJson(knownFile, {});
  delete known[MKT];
  atomicWrite(knownFile, known);
  const inst = readJson(instFile, { version: 2, plugins: {} });
  delete (inst.plugins || {})[PLUGIN_ID];
  atomicWrite(instFile, inst);
  rmSync(join(mkPath, PID), { recursive: true, force: true });
  rmSync(mkPath, { recursive: true, force: true });
  rmSync(join(ROOT, 'cache', MKT), { recursive: true, force: true });
  const unset = setEnabledState(false);
  console.log('[install-gui] 已移除 ' + MKT + ' 登记（其他市场未触碰）' + (unset ? '，并撤销 enabledPlugins 声明' : ''));
}

function install() {
  copyPayload();
  writeMarketplaceManifest();
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
  const prev = (inst.plugins[PLUGIN_ID] || [{}])[0];
  inst.plugins[PLUGIN_ID] = [{
    scope: 'user',
    installPath: cachePath,
    version,
    installedAt: prev.installedAt || NOW(),
    lastUpdated: NOW(),
  }];
  atomicWrite(instFile, inst);
  const enabled = setEnabledState(true);
  console.log(`[install-gui] wb-ops@${MKT} v${version} 已登记`);
  console.log('  marketplaces: ' + mkPath + '\\' + PID);
  console.log('  manifest:     ' + mkManifestFile);
  console.log('  cache:        ' + cachePath);
  console.log('  enabledPlugins: ' + (enabled ? PLUGIN_ID + ' = true（已写入 settings.json）' : 'settings.json 无 enabledPlugins 或已为 true'));
  console.log('  生效：GUI 里执行 /reload-plugins（或重启 GUI）；CLI 里 /plugin install ' + PLUGIN_ID);
  console.log('  卸载：node scripts/install-gui.mjs --uninstall');
}

if (process.argv.includes('--uninstall')) uninstall(); else install();
