# 啟動收發室橋（給工作排程用；也可手動執行）。設定都在 ~/.irori-relay/：<ID>.key、anon.key。
param([string]$NodeId = 'H', [string]$DefaultAgent = '')
$ErrorActionPreference = 'Continue'
$env:IRORI_RELAY_ID = $NodeId
if ($DefaultAgent) { $env:IRORI_RELAY_DEFAULT_AGENT = $DefaultAgent }   # 不帶＝bridge.mjs 內建預設
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:USERPROFILE ".irori-relay\machine-$NodeId\launcher.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
while ($true) {
  "$(Get-Date -Format o) start bridge" | Add-Content $log
  & node (Join-Path $dir 'bridge.mjs') 2>&1 | Out-Null
  $code = $LASTEXITCODE
  "$(Get-Date -Format o) bridge exited code=$code" | Add-Content $log
  if ($code -eq 3) { break }   # another instance is running; do not loop
  Start-Sleep -Seconds 15
}
