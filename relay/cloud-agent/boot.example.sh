#!/usr/bin/env bash
# 放進雲端環境的 boot.sh（重置後會重跑）。可重複執行：Node 22 已有就跳過、recv 已在跑就跳過。
# 前提：程式放在 /workspace/irori-relay（見 README「取得程式」）；節點金鑰在秘密環境變數 IRORI_RELAY_KEY（本腳本不讀、不印它）。
set -u
WS="${IRORI_CLOUD_HOME:-/workspace}"
APP="${IRORI_CLOUD_APP:-$WS/irori-relay}"      # 裡面要有 relay/cloud-agent 與 relay/machine
NODE_DIR="$WS/.node"                            # Node 裝在 /workspace：重置後保留，不用每次重下載
mkdir -p "$WS/relay"

node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }

install_node() {
  # 官方來源 nodejs.org 的 tar.gz（免 root、不需要 xz），並用同目錄 SHASUMS256.txt 驗證 sha256
  local arch base file tmp
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "不支援的 CPU：$(uname -m)" >&2; return 1 ;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || return 1
  file="$(grep -o "node-v[0-9.]*-linux-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || { echo "找不到 $arch 的安裝檔" >&2; return 1; }
  curl -fsSL "$base/$file" -o "$tmp/$file" || return 1
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || { echo "sha256 驗證失敗" >&2; return 1; }
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR" && tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
}

export PATH="$NODE_DIR/bin:$PATH"
if ! node_ok; then
  echo "[irori] 安裝 Node 22…"
  install_node || { echo "[irori] Node 安裝失敗，收信常駐沒有啟動" >&2; exit 1; }
fi

# 已在跑就跳過（recv.mjs 自己也有 pid 檔鎖，這裡只是少開一個馬上退出的程序）
if pgrep -f "cloud-agent/recv.mjs" >/dev/null 2>&1; then
  echo "[irori] recv 已在執行"
else
  nohup setsid node "$APP/relay/cloud-agent/recv.mjs" >> "$WS/relay/recv.out" 2>&1 &
  echo "[irori] recv 已啟動（log：$WS/relay/recv.log）"
fi
