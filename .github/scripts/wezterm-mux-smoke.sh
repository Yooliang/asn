#!/usr/bin/env bash
# 冒煙測試：起 wezterm-mux-server（沒有桌面也行）、spawn 一個窗格、送字、用 cli get-text 讀回來。
# 用法：wezterm-mux-smoke.sh <wezterm 執行檔> <wezterm-mux-server 執行檔> <工作資料夾> [--windows]
# 做法參考 linux-wezterm-probe.sh。結果寫到 $GITHUB_STEP_SUMMARY；沒讀到送進去的字就以非零結束。
set -u
WEZ="$1"; MUX="$2"; OUT="$3"; WIN="${4:-}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
mkdir -p "$OUT"; cd "$OUT" || exit 1
unset DISPLAY WAYLAND_DISPLAY

if [ "$WIN" = --windows ]; then
  SOCK_LUA="$(cygpath -m "$OUT")/mux.sock"; CFG="$(cygpath -m "$OUT")/mux.lua"
  SHELL_CMD=(cmd.exe /d /q /k)
  # 送出去的是 %OS%，窗格裡的 cmd 會把它展開成 Windows_NT：讀到展開後的字，才表示指令真的被執行
  SEND=$'echo SMOKE_HELLO_%OS%\r\n'; WANT=SMOKE_HELLO_Windows_NT
else
  SOCK_LUA="$OUT/mux.sock"; CFG="$OUT/mux.lua"
  SHELL_CMD=(bash --noprofile --norc -i)
  # 同理：送出去的是 $((6*7))，讀到 42 才表示 bash 真的算過
  SEND=$'echo SMOKE_HELLO_$((6*7))\n'; WANT=SMOKE_HELLO_42
fi
cat > mux.lua <<LUA
local wezterm = require 'wezterm'
return {
  unix_domains = { { name = 'smoke', socket_path = '$SOCK_LUA' } },
  default_domain = 'smoke',
  enable_wayland = false,
}
LUA
cli() { WEZTERM_UNIX_SOCKET="$SOCK_LUA" "$WEZ" --config-file "$CFG" cli --no-auto-start --prefer-mux "$@"; }

result=FAIL; detail=''
"$MUX" --config-file "$CFG" > mux.log 2>&1 &
MUXPID=$!
up=no
for _ in $(seq 1 60); do
  if cli list > list.log 2>&1; then up=yes; break; fi
  sleep 0.5
done
if [ "$up" = yes ]; then
  PANE=$(cli spawn --new-window -- "${SHELL_CMD[@]}" 2> spawn.err | tr -d '[:space:]')
  if [ -n "$PANE" ]; then
    sleep 1
    cli send-text --pane-id "$PANE" --no-paste "$SEND" > send.log 2>&1
    sleep 1.5
    cli get-text --pane-id "$PANE" > text.log 2>&1
    if grep -q "$WANT" text.log; then
      result=PASS; detail="窗格 $PANE 讀到 $WANT"
    else
      detail="沒讀到送進去的字：$(head -c 200 text.log | tr '\r\n' '  ')"
    fi
  else
    detail="spawn 失敗：$(head -c 300 spawn.err | tr '\r\n' '  ')"
  fi
else
  detail="mux-server 連不上：$(head -c 300 list.log | tr '\r\n' '  ')；log：$(head -c 300 mux.log | tr '\r\n' '  ')"
fi
# 只關自己起的那一個
kill "$MUXPID" 2>/dev/null || true
{
  echo "#### mux 實測：$result"
  echo
  echo "$detail"
  echo
} >> "$SUMMARY"
echo "[smoke] $result $detail"
[ "$result" = PASS ]
