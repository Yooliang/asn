# 啟動收發室橋（給工作排程用；也可手動執行）。設定都在 ~/.asn/（舊位置 ~/.irori-relay/ 也認，解析順序同 home.mjs）：<ID>.key、anon.key。
param([string]$NodeId = 'H', [string]$DefaultAgent = '', [string]$Engines = '')
$ErrorActionPreference = 'Continue'
$env:ASN_RELAY_ID = $NodeId; $env:IRORI_RELAY_ID = $NodeId   # 新舊名都設，沒更新的程式照樣讀得到
if ($DefaultAgent) { $env:ASN_RELAY_DEFAULT_AGENT = $DefaultAgent; $env:IRORI_RELAY_DEFAULT_AGENT = $DefaultAgent }   # 不帶＝bridge.mjs 內建預設
if ($Engines) { $env:ASN_ENGINES = $Engines; $env:IRORI_ENGINES = $Engines }                          # 例：-Engines claude,acp（載入 Gemini 等背景工作者）；不帶＝只有 claude
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 資料夾：ASN_HOME → ~/.asn → 舊的 ~/.irori-relay（舊的是連結或空的就用 ~/.asn；是有內容的真資料夾＝尚未遷移，用舊的）
$dataDir = if ($env:ASN_HOME) { $env:ASN_HOME } elseif ($env:IRORI_HOME) { $env:IRORI_HOME } else {
  $n = Join-Path $env:USERPROFILE '.asn'; $l = Join-Path $env:USERPROFILE '.irori-relay'
  $useLegacy = $false
  if (Test-Path -LiteralPath $l) {
    if (-not (Test-Path -LiteralPath $n)) { $useLegacy = $true }
    else {
      $it = Get-Item -LiteralPath $l -Force
      if (-not ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $it.PSIsContainer -and (Get-ChildItem -LiteralPath $l -Force | Select-Object -First 1)) { $useLegacy = $true }
    }
  }
  if ($useLegacy) { $l } else { $n }
}
$log = Join-Path $dataDir "machine-$NodeId\launcher.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
while ($true) {
  "$(Get-Date -Format o) start bridge" | Add-Content $log
  & node (Join-Path $dir 'bridge.mjs') 2>&1 | Out-Null
  $code = $LASTEXITCODE
  "$(Get-Date -Format o) bridge exited code=$code" | Add-Content $log
  if ($code -eq 3) { break }   # another instance is running; do not loop
  Start-Sleep -Seconds 15
}
