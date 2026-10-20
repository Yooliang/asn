#!/usr/bin/env bash
# 啟動「新信即時分派」守望程式（可重複執行：已在跑就跳過）。不讀、不印金鑰；秘密由啟動 shell 的環境帶入。
# 請在 start.sh／boot.sh 裡 recv 啟動之後 source 或呼叫本段（見 README「即時分派」）。
set -u
WS="${IRORI_CLOUD_HOME:-/workspace}"
APP="${IRORI_CLOUD_APP:-$WS/irori-relay}"
export IRORI_DISPATCH_STATE_DIR="${IRORI_DISPATCH_STATE_DIR:-$WS/relay/dispatch-state}"
# 若 relay.env 在 APP 目錄，啟動 recv 前通常已 set -a; . relay.env; set +a
export PATH="${WS}/.node/bin:${PATH}"
DISPATCH="$APP/relay/cloud-agent/dispatch-watch.mjs"
if pgrep -f "cloud-agent/dispatch-watch.mjs" >/dev/null 2>&1; then
  echo "[dispatch] 已在執行"
else
  mkdir -p "$IRORI_DISPATCH_STATE_DIR"
  nohup setsid node "$DISPATCH" >> "$IRORI_DISPATCH_STATE_DIR/dispatch.out" 2>&1 < /dev/null &
  echo "[dispatch] 已啟動（log：$IRORI_DISPATCH_STATE_DIR/dispatch.log）"
fi
