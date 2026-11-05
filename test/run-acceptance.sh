#!/usr/bin/env bash
# wb-ops v0.12.0 真机验收脚本
# 用法: bash test/run-acceptance.sh <session-id> <prompt> [extra env assignments...]
set -uo pipefail

SID="$1"; shift
PROMPT="$1"; shift

CLI="/d/Program Files/WorkBuddy-cn/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs"
PORT="${WB_OPS_TEST_PORT:-57997}"

cd /c/Users/kingdee/work/wb-ops || exit 1

env CODEBUDDY_CONFIG_DIR=C:/Users/kingdee/.workbuddy \
    SERVER__PORT="$PORT" \
    "$@" \
    node "$CLI" --plugin-dir C:/Users/kingdee/work/wb-ops \
    --session-id "$SID" -p "$PROMPT" 2>&1 \
  | grep -a -v "^[[:space:]]*at \|fetch config failed"
