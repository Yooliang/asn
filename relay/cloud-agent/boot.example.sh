#!/usr/bin/env bash
# 放進雲端環境的 boot.sh（重置後會重跑）。可重複執行：Node 裝在 ASN_NODE_DIR、recv 已在跑就跳過。
# 前提：已用 install-cloud-node.sh 或手動放好程式；節點金鑰在 ASN_RELAY_KEY（或舊名 IRORI_RELAY_KEY，本腳本不讀、不印值）。
set -u
WS="${ASN_CLOUD_HOME:-${IRORI_CLOUD_HOME:-/workspace}}"
APP="${ASN_CLOUD_APP:-${IRORI_CLOUD_APP:-$WS/asn-relay}}"
MAIL="${ASN_CLOUD_MAIL_DIR:-${IRORI_CLOUD_MAIL_DIR:-$WS/relay}}"
NODE_DIR="${ASN_NODE_DIR:-${IRORI_NODE_DIR:-$WS/.node}}"
NODE_BIN="${ASN_NODE_BIN:-${IRORI_NODE_BIN:-$NODE_DIR/bin/node}}"
mkdir -p "$MAIL"

node_ok_at() {
  [ -x "$1" ] && "$1" -p 'Number(process.versions.node.split(".")[0]) >= 22' 2>/dev/null | grep -q true
}

safe_rm_node_dir() {
  local target="$1" home_root="$2"
  if [ -z "$target" ]; then echo "拒絕刪除：NODE_DIR 為空" >&2; return 1; fi
  case "$target" in /|"$HOME") echo "拒絕刪除危險路徑：$target" >&2; return 1 ;; esac
  local real_home real_target
  real_home="$(realpath -m "$home_root")"
  real_target="$(realpath -m "$target")"
  case "$real_target" in
    "$real_home"|"$real_home"/*) rm -rf "$target" ;;
    *) echo "拒絕刪除：$target 不在 $home_root 底下" >&2; return 1 ;;
  esac
}

install_node() {
  local arch base file tmp
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "不支援的 CPU：$(uname -m)" >&2; return 1 ;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || return 1
  file="$(grep -o "node-v[0-9.]*-linux-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || { echo "找不到 $arch 的安裝檔" >&2; return 1; }
  curl -fsSL "$base/$file" -o "$tmp/$file" || return 1
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || { echo "sha256 驗證失敗" >&2; return 1; }
  safe_rm_node_dir "$NODE_DIR" "$WS" && mkdir -p "$NODE_DIR" && tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
}

if ! node_ok_at "$NODE_BIN"; then
  echo "[asn] 安裝 Node 22 到 $NODE_DIR …"
  install_node || { echo "[asn] Node 安裝失敗，收信常駐沒有啟動" >&2; exit 1; }
fi
export PATH="$NODE_DIR/bin:$PATH"

if [ -z "${ASN_RELAY_KEY:-}" ] && [ -z "${IRORI_RELAY_KEY:-}" ]; then
  echo "[asn] 缺少 ASN_RELAY_KEY，拒絕啟動 recv（請在平台秘密變數設定後重開 shell 再跑 boot）" >&2
  exit 1
fi

recv_running() {
  local pidfile="$MAIL/recv.pid"
  [ -f "$pidfile" ] || return 1
  local pid
  pid="$(tr -d ' \n\r' < "$pidfile" 2>/dev/null)" || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'recv\.mjs' || return 1
  fi
  return 0
}

if recv_running; then
  echo "[asn] recv 已在執行（pid 檔：$MAIL/recv.pid）"
else
  nohup setsid "$NODE_BIN" "$APP/relay/cloud-agent/recv.mjs" >> "$MAIL/recv.out" 2>&1 &
  echo "[asn] recv 已啟動（log：$MAIL/recv.log，當機堆疊：$MAIL/recv.out）"
fi

DISPATCH="$APP/relay/cloud-agent/dispatch-watch.mjs"
if [ -f "$DISPATCH" ]; then
  STATE="${ASN_DISPATCH_STATE_DIR:-${IRORI_DISPATCH_STATE_DIR:-$MAIL/dispatch-state}}"
  dispatch_running() {
    local pf="$STATE/dispatch.pid"
    [ -f "$pf" ] || return 1
    local pid; pid="$(tr -d ' \n\r' < "$pf" 2>/dev/null)" || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'dispatch-watch\.mjs'
  }
  if dispatch_running; then
    echo "[asn] dispatch-watch 已在執行"
  else
    mkdir -p "$STATE"
    nohup setsid "$NODE_BIN" "$DISPATCH" >> "$STATE/dispatch.out" 2>&1 < /dev/null &
    echo "[asn] dispatch-watch 已啟動（log：$STATE/dispatch.log）"
  fi
fi
