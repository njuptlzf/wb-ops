#!/usr/bin/env node
// wb-ops 节省报表 CLI 版：聚合 ~/.workbuddy/wb-ops/stats/*.json。
// 会话内请用 mcp__wb_ops__report 工具——同一个 lib/report-core.mjs，口径不会漂。
// v0.13：token 口径与宿主同公式估算 ceil(中文/1.8)+ceil(其余/4)，与 [wb-ops] 标记行同源。
// 用法: node hooks/report.mjs   （只读，无需 WorkBuddy 运行）
import { collectRows, renderSummary } from '../lib/report-core.mjs';

console.log(renderSummary(collectRows()));
