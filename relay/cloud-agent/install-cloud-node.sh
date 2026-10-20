#!/usr/bin/env bash
# 雲端收發室節點一鍵安裝（Linux／bash，可重複執行）。
# 用法：bash install-cloud-node.sh [選項]
#   --home <路徑>           ASN_CLOUD_HOME（預設 /workspace；亦接受舊名 IRORI_CLOUD_HOME）
#   --app <路徑>            ASN_CLOUD_APP（預設 <home>/asn-relay）
#   --node-id <代號>        ASN_RELAY_ID（預設 grok）
#   --repo <git 網址>       淺層 clone 來源
#   --use-checkout          不 clone，使用本腳本所在 repo 根目錄
#   --migrate-from <舊目錄>  複製 inbox／done／agents 與 dispatch seen/pending；可讀舊 relay.env（IRORI_*）
#   --hook-boot <boot.sh>   追加 source <app>/start.sh
#   --skip-preflight        略過結尾的 preflight
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_FROM_SCRIPT="$(cd "$SCRIPT_DIR/../.." && pwd)"

HOME_DIR="${ASN_CLOUD_HOME:-${IRORI_CLOUD_HOME:-/workspace}}"
APP_DIR=""
NODE_ID="${ASN_RELAY_ID:-${IRORI_RELAY_ID:-grok}}"
REPO_URL=""
USE_CHECKOUT=0
MIGRATE_FROM=""
HOOK_BOOT=""
SKIP_PREFLIGHT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --app) APP_DIR="$2"; shift 2 ;;
    --node-id) NODE_ID="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --use-checkout) USE_CHECKOUT=1; shift ;;
    --migrate-from) MIGRATE_FROM="$2"; shift 2 ;;
    --hook-boot) HOOK_BOOT="$2"; shift 2 ;;
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "不認得的參數：$1" >&2; exit 1 ;;
  esac
done

APP_DIR="${APP_DIR:-$HOME_DIR/asn-relay}"
MAIL_DIR="${ASN_CLOUD_MAIL_DIR:-${IRORI_CLOUD_MAIL_DIR:-$HOME_DIR/relay}}"
NODE_DIR="${ASN_NODE_DIR:-${IRORI_NODE_DIR:-$HOME_DIR/.node}}"
NODE_BIN="$NODE_DIR/bin/node"
RELAY_ENV="$APP_DIR/relay.env"
START_SH="$APP_DIR/start.sh"

log() { echo "[install] $*"; }

detect_repo_url() {
  if [ -n "$REPO_URL" ]; then echo "$REPO_URL"; return; fi
  if git -C "$REPO_FROM_SCRIPT" remote get-url origin >/dev/null 2>&1; then
    git -C "$REPO_FROM_SCRIPT" remote get-url origin
    return
  fi
  echo "https://github.com/Yooliang/asn.git"
}

install_node() {
  local arch base file tmp
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "不支援的 CPU：$(uname -m)" >&2; return 1 ;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v[0-9.]*-linux-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || { echo "找不到 $arch 的 Node 安裝檔" >&2; return 1; }
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
}

node_ok() {
  [ -x "$NODE_BIN" ] && "$NODE_BIN" -p 'Number(process.versions.node.split(".")[0]) >= 22' 2>/dev/null | grep -q true
}

ensure_code() {
  if [ "$USE_CHECKOUT" -eq 1 ]; then
    log "使用目前 checkout：$REPO_FROM_SCRIPT → $APP_DIR"
    mkdir -p "$APP_DIR"
    if [ "$(realpath "$REPO_FROM_SCRIPT")" != "$(realpath "$APP_DIR")" ]; then
      mkdir -p "$APP_DIR/relay/cloud-agent" "$APP_DIR/relay/machine"
      cp -a "$REPO_FROM_SCRIPT/relay/cloud-agent/." "$APP_DIR/relay/cloud-agent/"
      for f in relay-core.mjs safe-log.mjs register.mjs pull-retry.mjs attach-format.mjs attach-download.mjs; do
        cp -a "$REPO_FROM_SCRIPT/relay/machine/$f" "$APP_DIR/relay/machine/"
      done
    fi
    return
  fi
  if [ -f "$APP_DIR/relay/cloud-agent/recv.mjs" ]; then
    log "程式已存在：$APP_DIR（略過 clone）"
    return
  fi
  local url; url="$(detect_repo_url)"
  log "淺層 clone：$url → $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  if command -v gh >/dev/null 2>&1; then
    local slug="$url"
    slug="${slug#https://github.com/}"
    slug="${slug%.git}"
    gh repo clone "$slug" "$APP_DIR" -- --depth 1
  else
    git clone --depth 1 "$url" "$APP_DIR"
  fi
}

write_relay_env() {
  cat > "$RELAY_ENV" <<EOF
# 路徑設定（不含秘密）。ASN_RELAY_KEY、ASN_RELAY_URL、ASN_RELAY_ANON_KEY 請在平台環境變數設定。
ASN_CLOUD_HOME=$HOME_DIR
ASN_CLOUD_APP=$APP_DIR
ASN_CLOUD_MAIL_DIR=$MAIL_DIR
ASN_NODE_DIR=$NODE_DIR
ASN_NODE_BIN=$NODE_BIN
ASN_RELAY_ID=$NODE_ID
ASN_RELAY_ENV_FILE=$RELAY_ENV
ASN_DISPATCH_STATE_DIR=$MAIL_DIR/dispatch-state
EOF
  chmod 600 "$RELAY_ENV"
  log "已寫入 $RELAY_ENV"
}

write_start_sh() {
  cat > "$START_SH" <<'STARTEOF'
#!/usr/bin/env bash
set -u
ENV_FILE="${ASN_RELAY_ENV_FILE:-${IRORI_RELAY_ENV_FILE:-__APP__/relay.env}}"
if [ -f "$ENV_FILE" ]; then set -a; # shellcheck source=/dev/null
  . "$ENV_FILE"; set +a; fi
WS="${ASN_CLOUD_HOME:-${IRORI_CLOUD_HOME:-/workspace}}"
APP="${ASN_CLOUD_APP:-${IRORI_CLOUD_APP:-__APP__}}"
MAIL="${ASN_CLOUD_MAIL_DIR:-${IRORI_CLOUD_MAIL_DIR:-__MAIL__}}"
NODE_BIN="${ASN_NODE_BIN:-${IRORI_NODE_BIN:-__NODE_BIN__}}"
mkdir -p "$MAIL"
log_msg() { echo "[start] $*" >&2; }
if [ -z "${ASN_RELAY_KEY:-}" ] && [ -z "${IRORI_RELAY_KEY:-}" ]; then
  log_msg "缺少 ASN_RELAY_KEY，拒絕啟動。請在平台設定秘密後開新 shell 再執行本腳本。"
  exit 1
fi
if [ ! -x "$NODE_BIN" ]; then log_msg "找不到 Node：$NODE_BIN"; exit 1; fi
recv_running() {
  local pf="$MAIL/recv.pid"; [ -f "$pf" ] || return 1
  local pid; pid="$(tr -d ' \n\r' < "$pf" 2>/dev/null)" || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'recv\.mjs'
}
if recv_running; then log_msg "recv 已在執行"; exit 0; fi
nohup setsid "$NODE_BIN" "$APP/relay/cloud-agent/recv.mjs" >> "$MAIL/recv.out" 2>&1 &
log_msg "recv 已啟動（log：$MAIL/recv.log）"
DISPATCH="$APP/relay/cloud-agent/dispatch-watch.mjs"
if [ -f "$DISPATCH" ]; then
  STATE="${ASN_DISPATCH_STATE_DIR:-${IRORI_DISPATCH_STATE_DIR:-$MAIL/dispatch-state}}"
  mkdir -p "$STATE"
  dp="$STATE/dispatch.pid"
  if [ -f "$dp" ] && kill -0 "$(tr -d ' \n\r' < "$dp" 2>/dev/null)" 2>/dev/null; then
    log_msg "dispatch-watch 已在執行"
  else
    nohup setsid "$NODE_BIN" "$DISPATCH" >> "$STATE/dispatch.out" 2>&1 < /dev/null &
    log_msg "dispatch-watch 已啟動"
  fi
fi
STARTEOF
  sed -i "s|__APP__|$APP_DIR|g; s|__MAIL__|$MAIL_DIR|g; s|__NODE_BIN__|$NODE_BIN|g" "$START_SH"
  chmod 755 "$START_SH"
  log "已寫入 $START_SH"
}

copy_if_newer() {
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  if [ -f "$dst" ] && [ "$dst" -nt "$src" ]; then
    log "略過（目的地較新）：$(basename "$dst")"
    return 0
  fi
  cp -a "$src" "$dst"
  log "已複製 $(basename "$src")"
}

migrate_from_old() {
  local old="$1"
  [ -n "$old" ] || return 0
  [ -d "$old" ] || { echo "找不到舊目錄：$old" >&2; exit 1; }
  mkdir -p "$MAIL_DIR"
  local old_mail=""
  if [ -f "$old/relay.env" ]; then
    # shellcheck disable=SC1090
    set -a; . "$old/relay.env"; set +a
    old_mail="${ASN_CLOUD_MAIL_DIR:-${IRORI_CLOUD_MAIL_DIR:-}}"
  fi
  old_mail="${old_mail:-$old/relay}"
  copy_if_newer "$old_mail/inbox.jsonl" "$MAIL_DIR/inbox.jsonl"
  copy_if_newer "$old_mail/done.jsonl" "$MAIL_DIR/done.jsonl"
  copy_if_newer "$old_mail/agents.json" "$MAIL_DIR/agents.json"
  local old_dispatch="$old_mail/dispatch-state"
  local new_dispatch="$MAIL_DIR/dispatch-state"
  mkdir -p "$new_dispatch"
  copy_if_newer "$old_dispatch/seen.jsonl" "$new_dispatch/seen.jsonl"
  copy_if_newer "$old_dispatch/pending.jsonl" "$new_dispatch/pending.jsonl"
}

hook_boot_script() {
  local boot="$1"
  [ -n "$boot" ] || return 0
  [ -f "$boot" ] || { echo "找不到 boot 腳本：$boot" >&2; exit 1; }
  local marker="# asn-cloud-agent-start"
  if grep -qF "$marker" "$boot" 2>/dev/null; then
    log "boot 已掛載 start：$boot"
    return 0
  fi
  {
    echo ""
    echo "$marker"
    echo "if [ -x \"$START_SH\" ]; then . \"$START_SH\" || true; fi"
  } >> "$boot"
  log "已在 $boot 追加 start 呼叫"
}

mkdir -p "$HOME_DIR" "$MAIL_DIR"
ensure_code

if ! node_ok; then
  log "安裝 Node 22 到 $NODE_DIR …"
  install_node
fi
"$NODE_BIN" -v | sed 's/^/[install] Node /'

write_relay_env
write_start_sh
migrate_from_old "$MIGRATE_FROM"
hook_boot_script "$HOOK_BOOT"

if [ "$SKIP_PREFLIGHT" -eq 0 ]; then
  log "執行事前檢查（preflight，只讀）…"
  set +e
  ASN_CLOUD_HOME="$HOME_DIR" ASN_CLOUD_APP="$APP_DIR" ASN_CLOUD_MAIL_DIR="$MAIL_DIR" \
    ASN_NODE_BIN="$NODE_BIN" ASN_RELAY_ID="$NODE_ID" \
    "$NODE_BIN" "$APP_DIR/relay/cloud-agent/preflight.mjs"
  pf=$?
  set -e
  if [ "$pf" -eq 2 ]; then
    log "preflight：尚未設定 ASN_RELAY_KEY（在平台設好後，開新 shell 再跑 preflight 或 start.sh）"
  elif [ "$pf" -ne 0 ]; then
    log "preflight 結束碼 $pf（請核對 ASN_RELAY_URL 是否與金鑰同一後台）"
  fi
else
  log "略過 preflight"
fi

log "完成。啟動：$START_SH（或把 boot.example.sh 放進平台 boot）"
log "例行任務路徑：$NODE_BIN $APP_DIR/relay/cloud-agent/env.mjs print recv"
