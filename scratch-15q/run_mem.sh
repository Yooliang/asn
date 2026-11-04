#!/bin/bash
# 量記憶體：window／mux 各 1、10 個，看每個夥伴多佔多少；背景開看視窗閃不閃
S=/c/Users/cwen0708/AppData/Local/Temp/claude/a95c5df0d0e2737f/f11bf022-ab34-493d-94be-cfdc12424e3a/scratchpad
T=/c/Users/cwen0708/AppData/Local/Temp/claude/D--Github/f11bf022-ab34-493d-94be-cfdc12424e3a/scratchpad/toastfocus
cd /d/Github/Yooliang/asn-15q/relay/asn/src-tauri || exit 1
export ASN_WEZTERM_DIR="$(cygpath -w /c/Users/cwen0708/AppData/Local/ASN/wezterm)"
BIN=$(ls -t target/debug/deps/asn_lib-*.exe | head -1)
cat > $S/mem.ps1 <<'PS'
param([string]$pids)
$all=Get-CimInstance Win32_Process
$kids=@{}; foreach($p in $all){ if(-not $kids.ContainsKey($p.ParentProcessId)){ $kids[$p.ParentProcessId]=@() }; $kids[$p.ParentProcessId]+=$p }
$seen=@{}; $q=New-Object Collections.Queue
foreach($x in ($pids -split ',')){ $r=$all | ?{ $_.ProcessId -eq [int]$x }; if($r){ $q.Enqueue($r) } }
$sum=0;$names=@{}
while($q.Count){ $p=$q.Dequeue(); if($seen[$p.ProcessId]){continue}; $seen[$p.ProcessId]=1; $sum+=$p.WorkingSetSize; $names[$p.Name]=1+[int]$names[$p.Name]; foreach($c in $kids[$p.ProcessId]){ $q.Enqueue($c) } }
$fmt=($names.GetEnumerator() | sort Name | %{ "$($_.Name)x$($_.Value)" }) -join ' '
"工作集合計 {0:N0} MB；{1}" -f ($sum/1MB),$fmt
PS
one() { # mode n hidden
  F=$S/mem-$1-$2-$3; rm -rf $F; mkdir -p $F
  ASN_15Q_CLAUDE_MODE=$1 ASN_15Q_N=$2 ASN_15Q_HIDDEN=$3 ASN_15Q_FLAGS="$(cygpath -w $F)" "$BIN" "live_mux::多個夥伴" --ignored --nocapture --test-threads=1 > $F/out.txt 2>&1 &
  for i in $(seq 1 120); do [ -f $F/opened ] && break; node -e "setTimeout(()=>{},1000)"; done
  node -e "setTimeout(()=>{},4000)"
  PIDS=$(awk '{print $2}' $F/opened | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "== $1 N=$2 hidden=$3 pids=$(echo $PIDS | cut -c1-60)"
  powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w $S/mem.ps1)" -pids "$PIDS" 2>&1 | cut -c1-140
  touch $F/done
  for i in $(seq 1 90); do [ -f $F/stopped ] && break; node -e "setTimeout(()=>{},1000)"; done
  node -e "setTimeout(()=>{},2000)"
  grep -E "RESULT|panicked" $F/out.txt | cut -c1-110 | sed 's/^.*RESULT/ /'
  echo "  收尾後 wezterm 程序: $(tasklist | grep -ci wezterm)"
}
one window 1 0
one window 10 0
one mux 1 0
one mux 10 0
# 背景開：記錄視窗有沒有閃（監看工具逐毫秒記可見狀態）
cd $T
node -e "
const {spawn}=require('child_process');const path=require('path');
const m=spawn('focustest.exe',['$(cygpath -w $S)\\\\hidden-focus.log'],{stdio:['pipe','pipe','inherit']});
setTimeout(()=>{m.stdin.write('quit\n');process.exit(0)},30000)
" &
cd /d/Github/Yooliang/asn-15q/relay/asn/src-tauri
one window 3 1
exit 0
