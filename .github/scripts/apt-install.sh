#!/usr/bin/env bash
# CI 安裝 apt 套件：先照常用 runner 預設的 Azure 鏡像，下載卡住或失敗才改用官方站 archive.ubuntu.com 再試一次。
# 11-11 Azure 鏡像（azure.archive.ubuntu.com）整個抓不下套件，build 卡在這一步一小時以上。
# 每一段都用 timeout 包住：update 60 秒、install 240 秒，兩輪加起來 10 分鐘，step 的 timeout-minutes 給 15。
#
# 用法：apt-install.sh [apt-get install 的選項與套件…]（-y 已經帶了）
set -uo pipefail

APT=(sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

attempt() {
  timeout 60 "${APT[@]}" update && timeout 240 "${APT[@]}" install -y "$@"
}

if attempt "$@"; then
  exit 0
fi

echo "::warning::預設鏡像下載失敗或逾時，改用 archive.ubuntu.com 再試一次"
# 第一輪若在安裝中途被 timeout 切掉，先把 dpkg 收拾好，才不會卡在鎖或半套狀態
sudo dpkg --configure -a || true
for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
  [ -f "$f" ] || continue
  sudo sed -i -E \
    -e 's#mirror\+file:/etc/apt/apt-mirrors\.txt#http://archive.ubuntu.com/ubuntu/#g' \
    -e 's#https?://azure\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' \
    -e 's#https?://security\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' \
    "$f"
done
attempt "$@"
