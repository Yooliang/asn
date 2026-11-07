#!/usr/bin/env bash
# 實驗（#893）：Linux 沒有桌面（沒有 DISPLAY）的主機上，WezTerm 的 mux-server 能不能當「終端服務」用。
# 只做實驗，不碰產品程式。結果寫到 $GITHUB_STEP_SUMMARY（表格），細節 log 放在 $OUT 底下（workflow 會上傳）。
#   1. 下載固定版本的 Linux WezTerm，核對雜湊（版本與雜湊寫死在這裡，比照 relay/asn/scripts/fetch-wezterm.mjs）
#   2. 沒有 DISPLAY 的情況下起 wezterm-mux-server（由一個「啟動者」程序用 setsid 脫離後啟動）
#   3. spawn 一個窗格、送字、用 cli get-text 讀出內容
#   4. 殺掉「啟動者」程序，再讀一次：窗格還在不在
#   5. 對照組：再殺掉 mux-server 本身，窗格應該跟著沒了
set -u

WEZTERM_VERSION='20240203-110809-5046fc22'
TAR_NAME="wezterm-${WEZTERM_VERSION}.Ubuntu22.04.tar.xz"
TAR_SHA256='142cb46de648200b852cc4b1d932e6b8f2a9d3c55f6dc5af44b6d4eeb9385f5c'
TAR_URL="https://github.com/wezterm/wezterm/releases/download/${WEZTERM_VERSION}/${TAR_NAME}"

OUT="${PROBE_OUT:-${RUNNER_TEMP:-/tmp}/wezprobe}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
mkdir -p "$OUT"
cd "$OUT" || exit 1

rows=()
FAILED=0   # 有 ✖ 的項目數：任一關鍵步驟失敗，整個腳本以 exit 1 結束（job 會紅）
WARNED=0   # 有 △ 的項目數：不讓 job 變紅，但會在 summary 標出來
note() {
  rows+=("| $1 | $2 | $3 |"); echo "[probe] $1: $2 $3"
  case "$2" in ✖*) FAILED=$((FAILED + 1));; △*) WARNED=$((WARNED + 1));; esac
}
finish() {
  local rc=$?
  {
    echo "### WezTerm（${WEZTERM_VERSION}，${TAR_NAME}）在 $(. /etc/os-release && echo "$PRETTY_NAME")，沒有 DISPLAY"
    echo
    if [ "$FAILED" -gt 0 ] || [ "$rc" -ne 0 ]; then echo "**結果：失敗（$FAILED 項 ✖）**"
    elif [ "$WARNED" -gt 0 ]; then echo "**結果：通過，但有 $WARNED 項 △ 要看**"
    else echo "**結果：全部通過**"; fi
    echo
    echo "| 項目 | 結果 | 備註 |"
    echo "|---|---|---|"
    printf '%s\n' "${rows[@]}"
  } >> "$SUMMARY"
  # 在 EXIT 的處理裡 exit，可以改掉整個腳本的結束碼：有 ✖ 就讓 job 變紅
  if [ "$FAILED" -gt 0 ]; then exit 1; fi
  exit "$rc"
}
trap finish EXIT

# ---- 0. 環境 ----
unset DISPLAY WAYLAND_DISPLAY
note "環境" "DISPLAY=${DISPLAY:-未設定}" "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-未設定}；XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-未設定}"

# ---- 1. 下載＋雜湊 ----
if ! curl -fsSL --retry 3 -o "$TAR_NAME" "$TAR_URL"; then
  note "下載" "✖ 失敗" "$TAR_URL"
  exit 1
fi
if echo "${TAR_SHA256}  ${TAR_NAME}" | sha256sum -c - > sha.log 2>&1; then
  note "下載與雜湊" "✔" "$(stat -c %s "$TAR_NAME") 位元組，SHA-256 與寫死的值一致"
else
  note "下載與雜湊" "✖ 雜湊不符" "$(sha256sum "$TAR_NAME" | cut -d' ' -f1)"
  exit 1
fi
mkdir -p wz && tar -xJf "$TAR_NAME" -C wz
MUX="$OUT/wz/wezterm/usr/bin/wezterm-mux-server"
WEZ="$OUT/wz/wezterm/usr/bin/wezterm"
if [ ! -x "$MUX" ] || [ ! -x "$WEZ" ]; then
  note "解壓縮" "✖ 找不到 wezterm 或 wezterm-mux-server" "$(find wz -name 'wezterm*' -type f | head -5 | tr '\n' ' ')"
  exit 1
fi
note "版本" "✔" "$("$WEZ" --version 2>&1 | head -1)；$("$MUX" --version 2>&1 | head -1)"

# ---- 2. 缺的函式庫（沒有桌面的主機常缺這些） ----
for b in "$MUX" "$WEZ"; do
  miss=$(ldd "$b" 2>&1 | grep 'not found' | awk '{print $1}' | tr '\n' ' ')
  note "ldd $(basename "$b")" "${miss:+✖ 缺 }${miss:-✔ 沒有缺的}" ""
done
ldd "$MUX" > ldd-mux.log 2>&1

# ---- 3. 起 mux-server：設定檔與 socket ----
SOCK="$OUT/mux.sock"
cat > mux.lua <<LUA
local wezterm = require 'wezterm'
return {
  unix_domains = { { name = 'probe', socket_path = '$SOCK' } },
  default_domain = 'probe',
  enable_wayland = false,
}
LUA
# cli 要連到我們指定的 socket：用環境變數 WEZTERM_UNIX_SOCKET（只靠 --config-file 時，這個版本的 cli 會去連預設的 $XDG_RUNTIME_DIR/wezterm/sock）
cli() { WEZTERM_UNIX_SOCKET="$SOCK" "$WEZ" --config-file "$OUT/mux.lua" cli --no-auto-start --prefer-mux "$@"; }

# 「啟動者」：模擬 ASN——它用 setsid 讓 mux-server 脫離自己再啟動，之後自己繼續活著（我們會殺它）
# （pgrep 用 -f：行程名稱會被截成 15 個字，-x 比對不到 wezterm-mux-server）
# PROBE_MODE=setsid（預設）：啟動者用 setsid 起一個前景的 mux-server；PROBE_MODE=daemonize：啟動者呼叫 mux-server --daemonize（它自己 fork 到背景後啟動者的指令就結束），之後啟動者留著不動
MODE="${PROBE_MODE:-setsid}"
if [ "$MODE" = daemonize ]; then
  (
    "$MUX" --daemonize --config-file "$OUT/mux.lua" > mux.log 2>&1
    sleep 600
  ) &
  STARTER=$!
  for _ in $(seq 1 40); do pgrep -n -f wezterm-mux-server > mux.pid 2>/dev/null && [ -s mux.pid ] && break; sleep 0.25; done
else
  (
    setsid "$MUX" --config-file "$OUT/mux.lua" > mux.log 2>&1 &
    echo $! > mux.pid
    wait
  ) &
  STARTER=$!
  for _ in $(seq 1 40); do [ -s mux.pid ] && break; sleep 0.25; done
fi
MUXPID=$(cat mux.pid 2>/dev/null || echo 0)
note "啟動方式" "$MODE" "啟動者 pid $STARTER"
up=no
for _ in $(seq 1 60); do
  if cli list > list0.log 2>&1; then up=yes; break; fi
  sleep 0.5
done
if [ "$up" != yes ]; then
  note "起 mux-server（沒有 DISPLAY）" "✖ 連不上" "cli：$(head -c 300 list0.log | tr '
' ' ')"
  note "mux-server 程序在嗎" "$(pgrep -a wezterm-mux-server >/dev/null && echo 在 || echo 不在)" "pid $MUXPID；mux.log：$(head -c 300 mux.log | tr '
' ' ')"
  note "socket 檔" "$(ls -la "$SOCK" 2>&1 | head -1 | cut -c1-120)" "預設位置：$(ls -la /run/user/*/wezterm 2>&1 | tr '
' ' ' | cut -c1-200)"
  { pgrep -a wezterm; ls -laR "$OUT" /run/user 2>/dev/null | head -60; } > diag.log 2>&1
  exit 0
fi
# daemonize 模式：一開始抓到的是 fork 之前的那個程序（會馬上結束），等服務真的連得上之後再找一次，才是常駐的那個
if [ "$MODE" = daemonize ]; then MUXPID=$(pgrep -n -f wezterm-mux-server || echo 0); fi
note "起 mux-server（沒有 DISPLAY）" "✔" "pid $MUXPID，啟動者 pid $STARTER"

# ---- 4. spawn 窗格、送字、讀出 ----
PANE=$(cli spawn --new-window -- bash --noprofile --norc -i 2> spawn.err | tr -d '[:space:]')
if [ -z "$PANE" ]; then
  note "spawn 窗格" "✖" "$(head -c 300 spawn.err | tr '\n' ' ')"
  exit 0
fi
note "spawn 窗格" "✔" "窗格 $PANE"
sleep 1
cli send-text --pane-id "$PANE" --no-paste $'echo PROBE_HELLO_$((6*7))\n' > send.log 2>&1
sleep 1
cli get-text --pane-id "$PANE" > text1.log 2>&1
if grep -q 'PROBE_HELLO_42' text1.log; then
  note "get-text 讀出窗格內容" "✔" "讀到 PROBE_HELLO_42（行數 $(wc -l < text1.log)）"
else
  note "get-text 讀出窗格內容" "✖" "沒讀到送進去的字；前 200 字：$(head -c 200 text1.log | tr '\n' ' ')"
fi
SHELLPID=$(pgrep -f 'bash --noprofile --norc -i' | head -1 || true)
note "窗格裡的程序" "pid ${SHELLPID:-?}" "父程序 $(ps -o ppid= -p "${SHELLPID:-0}" 2>/dev/null | tr -d ' ')，mux-server $MUXPID"

# ---- 5. 殺掉「啟動者」，窗格還在不在 ----
kill -9 "$STARTER" 2>/dev/null
sleep 2
if kill -0 "$MUXPID" 2>/dev/null; then alive=✔; else alive=✖; fi
note "殺掉啟動者後 mux-server 還活著" "$alive" "pid $MUXPID"
cli list > list1.log 2>&1
if grep -qE "^\s*[0-9]+\s+[0-9]+\s+$PANE\b" list1.log || grep -q "$PANE" list1.log; then
  cli get-text --pane-id "$PANE" > text2.log 2>&1
  if grep -q 'PROBE_HELLO_42' text2.log; then
    note "殺掉啟動者後窗格還在、內容還讀得到" "✔" "窗格 $PANE 仍列在 cli list，內容沒變"
  else
    note "殺掉啟動者後窗格" "△ 窗格還在但內容不對" "$(head -c 200 text2.log | tr '\n' ' ')"
  fi
  # 還能再送字、再讀
  cli send-text --pane-id "$PANE" --no-paste $'echo PROBE_AFTER_KILL\n' > /dev/null 2>&1
  sleep 1
  cli get-text --pane-id "$PANE" 2>&1 | grep -q PROBE_AFTER_KILL && note "殺掉啟動者後還能送字" "✔" "" || note "殺掉啟動者後還能送字" "✖" ""
else
  note "殺掉啟動者後窗格" "✖ 窗格不見了" "$(head -c 300 list1.log | tr '\n' ' ')"
fi

# ---- 6. 對照組：殺掉 mux-server 本身 ----
kill -9 "$MUXPID" 2>/dev/null
sleep 2
if cli list > list2.log 2>&1; then
  note "對照：殺掉 mux-server 本身" "△ 還連得上" "$(head -c 200 list2.log | tr '\n' ' ')"
else
  note "對照：殺掉 mux-server 本身" "✔ 連不上了（預期）" "窗格裡的 bash 還活著嗎：$(pgrep -f 'bash --noprofile --norc -i' >/dev/null && echo 活著 || echo 已結束)"
fi

# 收尾：只關自己起的程序
pkill -f "bash --noprofile --norc -i" 2>/dev/null || true
exit 0
