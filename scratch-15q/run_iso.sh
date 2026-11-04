#!/bin/bash
# run_iso.sh <資料夾名> <mux|broken>：開隔離實例，走名單開夥伴，截圖，收尾
S=/c/Users/cwen0708/AppData/Local/Temp/claude/a95c5df0d0e2737f/f11bf022-ab34-493d-94be-cfdc12424e3a/scratchpad
T=/c/Users/cwen0708/AppData/Local/Temp/claude/D--Github/f11bf022-ab34-493d-94be-cfdc12424e3a/scratchpad/toastfocus
N=$1; MODE=$2
cd $S
rm -rf $S/$N; mkdir -p $S/$N
node iso.mjs "$(cygpath -w $S/$N)" $MODE > $S/$N/iso.out 2>&1 &
for i in $(seq 1 20); do [ -f $S/$N/started ] && break; node -e "setTimeout(()=>{},1000)"; done
node -e "setTimeout(()=>{},7000)"
P=$(python -c "import json;print(json.load(open(r'$(cygpath -w $S/$N/started)'))['pid'])")
H=$(powershell -NoProfile -c "(Get-Process -Id $P).MainWindowHandle" | tr -d '\r')
echo "asn pid=$P hwnd=$H"
cd $T; W=$(cygpath -w $S/$N)
node gui.mjs "front #$H" "sleep 500" "clickat #$H|329|108" "sleep 900" "clickat #$H|362|151" "sleep 1200" "clickat #$H|288|533" "sleep 1000" "clickat #$H|288|584" "sleep 1000" "shotwin #$H|$W\\dlg.png" "clickat #$H|308|545" "sleep 22000" "fg" "shotwin @fg|$W\\fg.png" "shotwin #$H|$W\\list.png" 2>&1 | cut -c1-110
echo == 程序; tasklist | grep -E "wezterm|conhost" | cut -c1-40 | sort | uniq -c | sort -rn | head -6
tasklist | grep -E "wezterm" | cut -c1-44
powershell -NoProfile -c "Get-CimInstance Win32_Process -Filter 'ParentProcessId=$P' | %{ \$_.Name+' '+\$_.ProcessId }"
echo == 紀錄; cut -c1-170 $S/$N/asn.log | tail -6
D=$(python -c "import json;print(json.load(open(r'$(cygpath -w $S/$N/started)'))['tmp'])")
python - "$D" <<'PY'
import json,sys,os
d=sys.argv[1]
p=os.path.join(d,'data','wezterm-terms.json')
if os.path.exists(p):
    t=json.load(open(p,encoding='utf8')); print([{k:x.get(k) for k in ('id','kind','session_id','pid','title','mux')}|{'nonce':bool(x.get('exit_nonce'))} for x in t.get('terms',[])])
PY
touch $S/$N/done
for i in $(seq 1 15); do tasklist | grep -q "asn.exe *$P " || break; node -e "setTimeout(()=>{},1000)"; done
node -e "setTimeout(()=>{},1500)"
MSYS2_ARG_CONV_EXCL='*' reg add 'HKCU\Software\Classes\asn\shell\open\command' /ve /t REG_SZ /d '"C:\Users\cwen0708\AppData\Local\ASN\asn.exe" "%1"' /f >/dev/null
MSYS2_ARG_CONV_EXCL='*' reg query 'HKCU\Software\Classes\asn\shell\open\command' | tail -2 | cut -c1-90
echo == 收尾後; tasklist | grep -E "wezterm" | cut -c1-44
powershell -NoProfile -c "Get-CimInstance Win32_Process -Filter \"Name='wezterm-mux-server.exe' OR Name='wezterm-gui.exe'\" | %{ \$c=[string]\$_.CommandLine; if(\$c -match 'asn-iso-'){ Stop-Process -Id \$_.ProcessId -Force; '關掉隔離實例留下的 '+\$_.Name+' '+\$_.ProcessId } }"
exit 0
