#!/usr/bin/env bash
# 外部下載不穩時的重試（CI 用）：只有輸出看得出是「外部服務的錯誤」（5xx、逾時、連線中斷）才重試，
# 其他失敗一律立刻照原本的結束碼失敗，不放水。最多 3 次，之間退避 15、45 秒；3 次都失敗就紅，訊息寫明是外部服務。
#
# 用法：retry-external.sh <說明> [--before '<每次重試前要跑的清理指令>'] -- <指令…>
set -uo pipefail

label="$1"; shift
before=""
if [ "${1:-}" = "--before" ]; then before="$2"; shift 2; fi
[ "${1:-}" = "--" ] && shift

# 看得出是外部服務問題的字樣（英文來自 curl／reqwest／tauri bundler，中文來自產品的取得流程）
pattern='HTTP[/ ][0-9.]* 5[0-9][0-9]|returned error: 5[0-9][0-9]|response code: 5[0-9][0-9]|status(: | code )5[0-9][0-9]|\b50[0234]\b.*(Bad Gateway|Gateway|Unavailable|Internal Server Error)|Gateway Time-?out|Service Unavailable|(operation|connection|request|connect|read) timed out|Timeout was reached|connection (reset|refused|closed)|error sending request|伺服器回 5[0-9][0-9]|連不上或逾時|下載中斷'

log="$(mktemp)"
delays=(15 45)
for attempt in 1 2 3; do
  if [ "$attempt" -gt 1 ] && [ -n "$before" ]; then bash -c "$before"; fi
  "$@" 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  if [ "$code" -eq 0 ]; then rm -f "$log"; exit 0; fi
  if ! grep -Eiq "$pattern" "$log"; then
    echo "::error::${label}：失敗（結束碼 ${code}），不是外部服務的錯誤，不重試" >&2
    rm -f "$log"; exit "$code"
  fi
  if [ "$attempt" -lt 3 ]; then
    d=${delays[$((attempt - 1))]}
    echo "::warning::${label}：第 ${attempt} 次碰到外部服務錯誤（5xx／逾時／連線中斷），${d} 秒後重試" >&2
    sleep "$d"
  fi
done
echo "::error::${label}：外部服務錯誤，重試 3 次仍失敗（不是程式問題，但這一步沒有驗到，所以算失敗）" >&2
rm -f "$log"
exit "$code"
