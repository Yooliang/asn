#!/bin/bash
# 強殺測試：隔離 ASN（mux 模式）開夥伴 → taskkill /F 只殺 ASN → 看 mux 與夥伴 → 重開 ASN → 看認回與 mux 個數 → 收尾
S=/c/Users/cwen0708/AppData/Local/Temp/claude/a95c5df0d0e2737f/f11bf022-ab34-493d-94be-cfdc12424e3a/scratchpad
T=/c/Users/cwen0708/AppData/Local/Temp/claude/D--Github/f11bf022-ab34-493d-94be-cfdc12424e3a/scratchpad/toastfocus
N=$S/kill1
cd $S
python - <<'PY'
p=r'C:\Users\cwen0708\AppData\Local\Temp\claude\a95c5df0d0e2737f\f11bf022-ab34-493d-94be-cfdc12424e3a\scratchpad\iso.mjs'
s=open(p,encoding='utf8').read()
if 'respawn' not in s:
    a=s.index("const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })")
    b=s.index("console.log('結束碼', child.exitCode)")
    s=s[:a]+"""let child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
const log = fs.createWriteStream(path.join(flags, 'asn.log'))
child.stdout.pipe(log); child.stderr.pipe(log)
fs.writeFileSync(path.join(flags, 'started'), JSON.stringify({ pid: child.pid, tmp, url: relay.url }))
console.log('ASN pid', child.pid, 'tmp', tmp)
const t0 = Date.now(); let respawned = false
while (!fs.existsSync(path.join(flags, 'done')) && Date.now() - t0 < 25 * 60_000) {
  if (child.exitCode !== null || child.signalCode) {
    if (!respawned && fs.existsSync(path.join(flags, 'respawn'))) {
      respawned = true
      child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
      fs.writeFileSync(path.join(flags, 'restarted'), String(child.pid))
    } else if (respawned) break
  }
  await new Promise(r => setTimeout(r, 300))
}
"""+s[b:]
    s=s.replace("child.stdout.pipe(log); child.stderr.pipe(log)\nfs.writeFileSync","child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })\nfs.writeFileSync",1)
    open(p,'w',encoding='utf8').write(s)
PY
rm -rf $N; mkdir -p $N
node iso.mjs "$(cygpath -w $N)" mux > $N/iso.out 2>&1 &
for i in $(seq 1 20); do [ -f $N/started ] && break; node -e "setTimeout(()=>{},1000)"; done
node -e "setTimeout(()=>{},7000)"
P=$(python -c "import json;print(json.load(open(r'$(cygpath -w $N/started)'))['pid'])")
H=$(powershell -NoProfile -c "(Get-Process -Id $P).MainWindowHandle" | tr -d '\r')
D=$(python -c "import json;print(json.load(open(r'$(cygpath -w $N/started)'))['tmp'])")
DU=$(cygpath "$D")
echo "asn=$P"
cd $T; W=$(cygpath -w $N)
node gui.mjs "front #$H" "sleep 500" "clickat #$H|329|108" "sleep 900" "clickat #$H|362|151" "sleep 1200" "clickat #$H|288|533" "sleep 1000" "clickat #$H|288|584" "sleep 1000" "clickat #$H|308|545" "sleep 14000" 2>&1 | tail -1 | cut -c1-50
echo == 殺之前; tasklist | grep -E "wezterm" | cut -c1-44
M=$(tasklist | grep wezterm-mux | awk '{print $2}' | head -1)
cat "$DU/data/wezterm-terms.json" | python -c "import json,sys;d=json.load(sys.stdin);print([(t['id'],t.get('kind'),t.get('pid')) for t in d['terms']])"
K=$(powershell -NoProfile -c "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=$M' | ?{ \$_.Name -eq 'powershell.exe' }).ProcessId" | tr -d '\r' | head -1)
echo "mux=$M 夥伴殼=$K"
echo == 強殺 ASN；只殺這一個編號; taskkill //PID $P //F 2>&1 | cut -c1-70
node -e "setTimeout(()=>{},4000)"
echo == 殺之後; tasklist | grep -E "asn.exe *$P|wezterm" | cut -c1-44; powershell -NoProfile -c "if(Get-Process -Id $K -ErrorAction SilentlyContinue){'夥伴殼還在'}else{'夥伴殼不在'}"
powershell -NoProfile -c "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ?{ \$_.CommandLine -match 'asn-iso-' } | Measure-Object | %{ '殘留 webview='+\$_.Count }"
touch $N/respawn
for i in $(seq 1 15); do [ -f $N/restarted ] && break; node -e "setTimeout(()=>{},1000)"; done
node -e "setTimeout(()=>{},10000)"
P2=$(cat $N/restarted); echo "新 asn=$P2"
echo == 重開後; tasklist | grep -E "wezterm" | cut -c1-44; echo "mux 個數: $(tasklist | grep -c wezterm-mux)"
cat "$DU/data/wezterm-terms.json" | python -c "import json,sys;d=json.load(sys.stdin);print([(t['id'],t.get('kind'),t.get('pid')) for t in d['terms']])"
tail -4 "$DU/local/ASN/m/mux.log" 2>/dev/null | cut -c1-110
cut -c1-150 $N/asn.log | tail -4
touch $N/done
for i in $(seq 1 15); do tasklist | grep -q "asn.exe *$P2 " || break; node -e "setTimeout(()=>{},1000)"; done
node -e "setTimeout(()=>{},1500)"
MSYS2_ARG_CONV_EXCL='*' reg add 'HKCU\Software\Classes\asn\shell\open\command' /ve /t REG_SZ /d '"C:\Users\cwen0708\AppData\Local\ASN\asn.exe" "%1"' /f >/dev/null
echo == 收尾; tasklist | grep -E "wezterm" | cut -c1-44
powershell -NoProfile -c "Get-CimInstance Win32_Process -Filter \"Name='wezterm-mux-server.exe' OR Name='wezterm-gui.exe'\" | %{ \$c=[string]\$_.CommandLine; if(\$c -match 'asn-iso-'){ Stop-Process -Id \$_.ProcessId -Force; '關掉隔離實例留下的 '+\$_.Name+' '+\$_.ProcessId } }"
echo "最後 wezterm: $(tasklist | grep -c wezterm)"
exit 0
