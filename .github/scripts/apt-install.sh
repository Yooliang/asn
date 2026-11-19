#!/usr/bin/env bash
# CI 安裝 apt 套件：.deb 快取 + 最多 3 輪重試（換鏡像）+ 每輪都有 timeout。
#
# 背景：#1796 build 的「安裝系統依賴」常卡在下載（要抓約 95 MB／203 個套件，鏡像慢時 240 秒切掉，exit 124）。
# 11-11 另有 Azure 鏡像整個抓不下的事故，所以保留「換官方站」的退路。
#
# 三道防線：
#  1. 快取：設了 APT_DEB_CACHE（目錄）就先把裡面的 .deb 放進 /var/cache/apt/archives，apt 發現已有就不再下載；
#     安裝成功後把 archives 的 .deb 複製回該目錄，讓 workflow 的 actions/cache 存起來。
#     APT_LISTS_CACHE（目錄）同理存 /var/lib/apt/lists：.deb 與索引都命中時先試「不 update、不下載」直接裝（只在命中快取時發生；
#     快取每週重建，安全更新最多晚一週進來），失敗就退回下面的正常流程。
#  2. 重試：Acquire::Retries=3＋連線 timeout 15 秒；整段失敗最多 3 輪，鏡像依序為預設 → azure.archive.ubuntu.com → archive.ubuntu.com。
#     被 timeout 切掉的那輪已下載完的 .deb 會留在 archives，下一輪接著用，不重抓。
#  3. 逾時：每輪 update 90 秒、install 150／300／300 秒，3 輪最多約 15 分鐘；workflow step 的 timeout-minutes 給 20 當總上限。
#     正常（快取命中或鏡像正常）整步在 1～2 分鐘內完成。
#
# 用法：apt-install.sh [apt-get install 的選項與套件…]（-y 已經帶了）
set -uo pipefail

ARCHIVES=/var/cache/apt/archives
UPDATE_TIMEOUT=90
# 每輪 install 的上限與換用的鏡像（空字串＝runner 預設的 mirrorlist）。
# 11-19 實測：預設鏡像（ec2 us-east-2）每個套件卡 40 秒、archive.ubuntu.com 也很慢，所以第 1 輪給短上限盡快放棄，
# 後兩輪換 Azure 鏡像（runner 同區，平常最快）與官方站；每輪已下載完的 .deb 都留著，下一輪接著用。
INSTALL_TIMEOUTS=(150 300 300)
MIRRORS=("" "http://azure.archive.ubuntu.com/ubuntu/" "http://archive.ubuntu.com/ubuntu/")
ROUNDS=3

APT=(sudo apt-get
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  -o Dpkg::Lock::Timeout=60
  -o APT::Keep-Downloaded-Packages=true)

start=$(date +%s)
log() { echo "[apt-install +$(( $(date +%s) - start ))s] $*"; }

restore_cache() {
  [ -n "${APT_DEB_CACHE:-}" ] && [ -d "$APT_DEB_CACHE" ] || return 0
  local n
  n=$(find "$APT_DEB_CACHE" -maxdepth 1 -name '*.deb' | wc -l)
  [ "$n" -gt 0 ] || { log "快取是空的，全部從鏡像下載"; return 0; }
  sudo cp -n "$APT_DEB_CACHE"/*.deb "$ARCHIVES"/ 2>/dev/null || true
  log "從快取放入 $n 個 .deb"
}

save_cache() {
  [ -n "${APT_DEB_CACHE:-}" ] || return 0
  mkdir -p "$APT_DEB_CACHE"
  touch "$APT_DEB_CACHE/.keep"
  sudo cp -n "$ARCHIVES"/*.deb "$APT_DEB_CACHE"/ 2>/dev/null || true
  sudo chown -R "$(id -u):$(id -g)" "$APT_DEB_CACHE" || true
  log "快取目錄現有 $(find "$APT_DEB_CACHE" -maxdepth 1 -name '*.deb' | wc -l) 個 .deb"
}

attempt() {
  timeout "$UPDATE_TIMEOUT" "${APT[@]}" update && timeout "$1" "${APT[@]}" install -y "${@:2}"
}

use_mirror() {
  local url=$1 f
  for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
    [ -f "$f" ] || continue
    sudo sed -i -E       -e "s#mirror\+file:/etc/apt/apt-mirrors\.txt#$url#g"       -e "s#https?://[A-Za-z0-9.-]*ubuntu\.com/ubuntu/?#$url#g"       "$f"
  done
}

restore_lists() {
  [ -n "${APT_LISTS_CACHE:-}" ] && [ -d "$APT_LISTS_CACHE/lists" ] || return 1
  [ -n "$(ls -A "$APT_LISTS_CACHE/lists" 2>/dev/null)" ] || return 1
  sudo cp -a "$APT_LISTS_CACHE/lists/." /var/lib/apt/lists/ && log "索引已從快取還原"
}

save_lists() {
  [ -n "${APT_LISTS_CACHE:-}" ] && [ "$mirror_swapped" = 0 ] || return 0
  mkdir -p "$APT_LISTS_CACHE/lists"
  sudo cp -a /var/lib/apt/lists/. "$APT_LISTS_CACHE/lists/" || true
  sudo rm -f "$APT_LISTS_CACHE/lists/lock"
  sudo chown -R "$(id -u):$(id -g)" "$APT_LISTS_CACHE" || true
}

mirror_swapped=0
restore_cache

# 快速路徑：.deb 與索引都來自快取才試；不 update、不下載，缺任何東西就失敗並退回正常流程
if restore_lists && timeout 180 "${APT[@]}" install -y --no-download "$@"; then
  log "快取命中，已跳過 apt update 與下載"
  exit 0
fi
log "快取沒命中或不完整，走正常流程"

for round in $(seq 1 "$ROUNDS"); do
  log "第 $round/$ROUNDS 輪（install 上限 ${INSTALL_TIMEOUTS[$((round - 1))]} 秒，鏡像 ${MIRRORS[$((round - 1))]:-預設}）"
  if [ -n "${MIRRORS[$((round - 1))]}" ]; then
    use_mirror "${MIRRORS[$((round - 1))]}"
    mirror_swapped=1
  fi
  if attempt "${INSTALL_TIMEOUTS[$((round - 1))]}" "$@"; then
    log "安裝完成"
    save_cache
    save_lists
    exit 0
  fi
  echo "::warning::第 $round 輪 apt 下載失敗或逾時"
  # 這輪若在安裝中途被 timeout 切掉，先把 dpkg 收拾好，才不會卡在鎖或半套狀態
  sudo dpkg --configure -a || true
done

echo "::error::apt 安裝 $ROUNDS 輪都失敗"
exit 1
