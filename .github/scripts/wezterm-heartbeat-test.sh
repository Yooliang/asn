#!/usr/bin/env bash
# 心跳實測（#1897 補丁 0003）：用剛建好的 mux-server 驗證存活訊號。
# 用法：wezterm-heartbeat-test.sh <wezterm 執行檔> <wezterm-mux-server 執行檔> <工作資料夾> [--windows]
# 案例 A（有設 ASN_MUX_HEARTBEAT）：
#   1. 檔案出現，內容是一行 {"v":1,"pid":…,"started_ms":…,"seq":…,"at_ms":…}
#   2. pid 等於 mux-server 程序自己的 pid
#   3. seq 與 at_ms 隨時間增加
#   4. 窗格裡的環境沒有 ASN_MUX_HEARTBEAT（mux 讀完就移除，窗格不會繼承）
# 案例 B（沒設變數）：等超過兩個週期，不產生任何心跳檔。
# 「主執行緒卡住時 seq 停住」無法在 CI 裡凍結主執行緒，由 asn_heartbeat.rs 的單元測試（注入假排程器）負責。
# 結果寫到 $GITHUB_STEP_SUMMARY；任何一項不符就以非零結束。
set -u
WEZ="$1"; MUX="$2"; OUT="$3"; WIN="${4:-}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
mkdir -p "$OUT"; cd "$OUT" || exit 1
unset DISPLAY WAYLAND_DISPLAY

fails=()
note() { echo "[heartbeat] $*"; }
fail() { fails+=("$*"); note "FAIL: $*"; }

if [ "$WIN" = --windows ]; then
  native() { cygpath -m "$1"; }
  # 窗格裡的 cmd：變數存在印 HBENV_SET、不存在印 HBENV_ABSENT。指令列上的字用 %OS:~0,0%（展開成空字串）拆開，
  # 所以只有「真的被執行的輸出」才含完整的 HBENV_SET／HBENV_ABSENT，輸入回顯不會被誤判
  SHELL_CMD=(cmd.exe /d /q /k)
  SEND=$'if defined ASN_MUX_HEARTBEAT (echo HBENV_S%OS:~0,0%ET) else (echo HBENV_ABS%OS:~0,0%ENT)\r\n'
  mux_pid() { cat "/proc/$1/winpid" 2>/dev/null; }   # Git Bash 的 $! 不是 Windows pid
else
  native() { echo "$1"; }
  SHELL_CMD=(bash --noprofile --norc -i)
  SEND=$'if [ -n "${ASN_MUX_HEARTBEAT+x}" ]; then echo HBENV_S""ET; else echo HBENV_ABS""ENT; fi\n'
  mux_pid() { echo "$1"; }
fi

# 讀一行 JSON 裡的數字欄位
field() { sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p" "$1" | head -1; }

# 起一個 mux-server：start_mux <子資料夾> [心跳檔路徑]；設 MUXPID、CFG、SOCK
start_mux() {
  local dir="$OUT/$1" hb="${2:-}"
  mkdir -p "$dir"
  SOCK="$(native "$dir")/mux.sock"; CFG="$(native "$dir")/mux.lua"
  cat > "$dir/mux.lua" <<LUA
local wezterm = require 'wezterm'
return {
  unix_domains = { { name = 'hb', socket_path = '$SOCK' } },
  default_domain = 'hb',
  enable_wayland = false,
}
LUA
  if [ -n "$hb" ]; then
    ASN_MUX_HEARTBEAT="$hb" "$MUX" --config-file "$CFG" > "$dir/mux.log" 2>&1 &
  else
    env -u ASN_MUX_HEARTBEAT "$MUX" --config-file "$CFG" > "$dir/mux.log" 2>&1 &
  fi
  MUXPID=$!
}
cli() { WEZTERM_UNIX_SOCKET="$SOCK" "$WEZ" --config-file "$CFG" cli --no-auto-start --prefer-mux "$@"; }
wait_cli() { for _ in $(seq 1 60); do cli list > /dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }

# ---------- 案例 A：有設變數 ----------
note "案例 A：有設 ASN_MUX_HEARTBEAT"
mkdir -p "$OUT/a-hb"
HB_FILE="$OUT/a-hb/heartbeat.json"
start_mux a "$(native "$HB_FILE")"
A_PID=$MUXPID
# 1. 檔案出現（第一個任務一進主執行緒就寫，約 1 秒）
for _ in $(seq 1 60); do [ -s "$HB_FILE" ] && break; sleep 0.5; done
if [ ! -s "$HB_FILE" ]; then
  fail "A1 心跳檔沒有出現（mux.log：$(head -c 300 "$OUT/a/mux.log" | tr '\r\n' '  ')）"
else
  line="$(tr -d '\r' < "$HB_FILE")"
  note "第一次內容：$line"
  if [ "$(printf '%s\n' "$line" | wc -l)" != 1 ] || ! printf '%s' "$line" | grep -Eq '^\{"v":1,"pid":[0-9]+,"started_ms":[0-9]+,"seq":[0-9]+,"at_ms":[0-9]+\}$'; then
    fail "A1 內容格式不對：$line"
  fi
  # 2. pid 正確
  want_pid="$(mux_pid "$A_PID")"; got_pid="$(field "$HB_FILE" pid)"
  if [ -z "$want_pid" ] || [ "$got_pid" != "$want_pid" ]; then fail "A2 pid 不符：檔案 $got_pid，mux-server $want_pid"; fi
  # 3. seq 與 at_ms 增加（每 5 秒一次，最多等 30 秒）
  seq1="$(field "$HB_FILE" seq)"; at1="$(field "$HB_FILE" at_ms)"; seq2="$seq1"; at2="$at1"
  for _ in $(seq 1 60); do
    sleep 0.5
    seq2="$(field "$HB_FILE" seq)"; at2="$(field "$HB_FILE" at_ms)"
    [ -n "$seq2" ] && [ "$seq2" -gt "$seq1" ] 2>/dev/null && break
  done
  if ! { [ -n "$seq2" ] && [ "$seq2" -gt "$seq1" ] 2>/dev/null; }; then fail "A3 seq 沒有增加（$seq1 -> $seq2）"; fi
  if ! { [ -n "$at2" ] && [ "$at2" -gt "$at1" ] 2>/dev/null; }; then fail "A3 at_ms 沒有增加（$at1 -> $at2）"; fi
  note "seq $seq1 -> $seq2、at_ms $at1 -> $at2"
fi
# 4. 窗格環境沒有該變數
if wait_cli; then
  PANE="$(cli spawn --new-window -- "${SHELL_CMD[@]}" 2> "$OUT/a/spawn.err" | tr -d '[:space:]')"
  if [ -z "$PANE" ]; then
    fail "A4 spawn 失敗：$(head -c 300 "$OUT/a/spawn.err" | tr '\r\n' '  ')"
  else
    sleep 1
    cli send-text --pane-id "$PANE" --no-paste "$SEND" > /dev/null 2>&1
    sleep 2
    cli get-text --pane-id "$PANE" > "$OUT/a/text.log" 2>&1
    if grep -q 'HBENV_SET' "$OUT/a/text.log"; then
      fail "A4 窗格繼承到了 ASN_MUX_HEARTBEAT"
    elif ! grep -q 'HBENV_ABSENT' "$OUT/a/text.log"; then
      fail "A4 窗格沒印出判斷結果（指令沒被執行）：$(head -c 300 "$OUT/a/text.log" | tr '\r\n' '  ')"
    else
      note "窗格環境沒有 ASN_MUX_HEARTBEAT"
    fi
  fi
else
  fail "A4 連不上 mux-server"
fi
kill "$A_PID" 2>/dev/null || true

# ---------- 案例 B：沒設變數 ----------
note "案例 B：沒設 ASN_MUX_HEARTBEAT"
start_mux b
B_PID=$MUXPID
if wait_cli; then
  sleep 12   # 超過兩個週期（5 秒）
  if [ -n "$(find "$OUT/b" -iname '*heartbeat*' 2>/dev/null)" ]; then
    fail "B 沒設變數卻產生了心跳檔：$(find "$OUT/b" -iname '*heartbeat*' | tr '\n' ' ')"
  else
    note "沒設變數：沒有任何心跳檔"
  fi
else
  fail "B 連不上 mux-server（log：$(head -c 300 "$OUT/b/mux.log" | tr '\r\n' '  ')）"
fi
kill "$B_PID" 2>/dev/null || true

if [ "${#fails[@]}" -eq 0 ]; then result=PASS; detail='檔案出現、格式與 pid 正確、seq 增加、窗格環境無該變數；沒設變數時不產生檔案'; else result=FAIL; detail="$(printf '%s；' "${fails[@]}")"; fi
{
  echo "#### 心跳實測：$result"
  echo
  echo "$detail"
  echo
} >> "$SUMMARY"
echo "[heartbeat] $result $detail"
[ "$result" = PASS ]
