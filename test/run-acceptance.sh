#!/usr/bin/env bash
# wb-ops 真机验收脚本（Mod 加载 / 水位守卫 / 大文件降级 的确定性触发器）
#
# 原理：CLI 鉴权门在 AgentService.run() 之前，而 mod 的 prompt.submit 在鉴权之前就已执行
# ——所以无需登录即可真机验证 mod 的 guard/watermark 链路（详见 VERIFICATION.md）。
#
# 用法: bash test/run-acceptance.sh <session-id必须是合法UUID> <prompt> [KEY=VAL ...]
# 示例:
#   bash test/run-acceptance.sh 11111111-2222-4333-8444-555555555555 "验收" WB_OPS_GUARD_PCT=10
# 产物:
#   ~/.workbuddy/wb-ops/debug/{fsprobe,usage}-<sid8>.json
#   ~/.workbuddy/wb-ops/watermark/<sid8>.num
set -uo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,12p' "$0"; exit 1
fi
SID="$1"; shift
PROMPT="$1"; shift

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # 仓库根（本脚本在任何机器上都能跑）
HOME_DIR="${WB_OPS_TEST_HOME:-$USERPROFILE}"                 # 宿主配置目录（默认真实 HOME）
HOME_WIN=$(cygpath -m "$HOME_DIR" 2>/dev/null || echo "$HOME_DIR")
CLI_CANDIDATES=(
  "${WORKBUDDY_HOME:-}/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs"
  "/d/Program Files/WorkBuddy-cn/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs"
  "/c/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs"
)
CLI=""
for c in "${CLI_CANDIDATES[@]}"; do [ -n "$c" ] && [ -f "$c" ] && { CLI="$c"; break; }; done
[ -z "$CLI" ] && { echo "[wb-ops] 找不到 codebuddy-lite-wb.mjs，请设 WORKBUDDY_HOME=<WorkBuddy安装目录>"; exit 1; }

PORT="${WB_OPS_TEST_PORT:-57997}"

env CODEBUDDY_CONFIG_DIR="$HOME_WIN" \
    SERVER__PORT="$PORT" \
    "$@" \
    node "$CLI" --plugin-dir "$ROOT" \
    --session-id "$SID" -p "$PROMPT" 2>&1 \
  | grep -a -v "^[[:space:]]*at \|fetch config failed"
