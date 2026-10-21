#!/usr/bin/env bash
# 手動啟動 recv（與 install-cloud-node.sh 產生的 start.sh 相同邏輯）。可 source relay.env 帶入路徑。
# 秘密必須已在環境（ASN_RELAY_KEY 或舊名 IRORI_RELAY_KEY）；長期跑著的 boot 迴圈不會自動拿到新秘密。
set -u
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ASN_RELAY_ENV_FILE:-${IRORI_RELAY_ENV_FILE:-$APP_DIR/relay.env}}"
if [ -f "$ENV_FILE" ]; then set -a; # shellcheck source=/dev/null
  . "$ENV_FILE"; set +a; fi
WS="${ASN_CLOUD_HOME:-${IRORI_CLOUD_HOME:-/workspace}}"
APP="${ASN_CLOUD_APP:-${IRORI_CLOUD_APP:-$APP_DIR}}"
MAIL="${ASN_CLOUD_MAIL_DIR:-${IRORI_CLOUD_MAIL_DIR:-$WS/relay}}"
NODE_BIN="${ASN_NODE_BIN:-${IRORI_NODE_BIN:-${ASN_NODE_DIR:-${IRORI_NODE_DIR:-$WS/.node}}/bin/node}}"
mkdir -p "$MAIL"

log_msg() { echo "[start] $*" >&2; }

if [ -z "${ASN_RELAY_KEY:-}" ] && [ -z "${IRORI_RELAY_KEY:-}" ]; then
  log_msg "缺少 ASN_RELAY_KEY，拒絕啟動。請在平台設定秘密變數後，開新 shell 再跑本腳本。"
  exit 1
fi
if [ ! -x "$NODE_BIN" ]; then
  log_msg "找不到 Node：$NODE_BIN（請先跑 install-cloud-node.sh）"
  exit 1
fi
if [ ! -f "$APP/relay/cloud-agent/recv.mjs" ]; then
  log_msg "找不到 recv.mjs：$APP/relay/cloud-agent/recv.mjs"
  exit 1
fi

recv_running() {
  local pidfile="$MAIL/recv.pid"
  [ -f "$pidfile" ] || return 1
  local pid; pid="$(tr -d ' \n\r' < "$pidfile" 2>/dev/null)" || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'recv\.mjs'
}

if recv_running; then
  log_msg "recv 已在執行（$MAIL/recv.pid）"
else
  nohup setsid "$NODE_BIN" "$APP/relay/cloud-agent/recv.mjs" >> "$MAIL/recv.out" 2>&1 &
  log_msg "recv 已啟動（log：$MAIL/recv.log）"
fi

DISPATCH="$APP/relay/cloud-agent/dispatch-watch.mjs"
if [ -f "$DISPATCH" ]; then
  STATE="${ASN_DISPATCH_STATE_DIR:-${IRORI_DISPATCH_STATE_DIR:-$MAIL/dispatch-state}}"
  mkdir -p "$STATE"
  if [ -f "$STATE/dispatch.pid" ] && kill -0 "$(tr -d ' \n\r' < "$STATE/dispatch.pid" 2>/dev/null)" 2>/dev/null; then
    log_msg "dispatch-watch 已在執行"
  else
    nohup setsid "$NODE_BIN" "$DISPATCH" >> "$STATE/dispatch.out" 2>&1 < /dev/null &
    log_msg "dispatch-watch 已啟動（log：$STATE/dispatch.log）"
  fi
fi
