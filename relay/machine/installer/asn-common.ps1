# install.ps1 與 uninstall.ps1 共用的小函式（用 . 載入）。檔案要存成 UTF-8（含 BOM），Windows PowerShell 5.1 才不會把中文讀成亂碼。

# 讓中文在視窗裡正常顯示（失敗就算了，不影響功能）
function Initialize-Console {
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
  try { $global:OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
}

function Say([string]$Message, [string]$Color = '') {
  if ($Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
}

function Get-AsnHome([string]$HomeDir) {
  if ($HomeDir) { return $HomeDir }
  return $env:USERPROFILE
}

# 使用者資料夾（金鑰、節點代號、橋的工作資料夾）：與 relay/machine/home.mjs 同一套解析順序（ONBOARDING 第 5.2 節）。
# ASN_HOME（舊名 IRORI_HOME；指定了 -HomeDir 的測試不看環境變數）→ %USERPROFILE%\.asn → 舊的 %USERPROFILE%\.irori-relay。
# 兩邊都在：舊的是連結或空資料夾就用 .asn；舊的是有內容的真資料夾（還沒遷移）就用舊的。不建立任何東西。
function Get-AsnDataDir([string]$HomeDir) {
  if (-not $HomeDir) {
    $o = $env:ASN_HOME
    if ([string]::IsNullOrWhiteSpace($o)) { $o = $env:IRORI_HOME }
    if (-not [string]::IsNullOrWhiteSpace($o)) { return $o.Trim() }
  }
  $base = Get-AsnHome $HomeDir
  $new = Join-Path $base '.asn'
  $legacy = Join-Path $base '.irori-relay'
  if (-not (Test-Path -LiteralPath $new)) {
    if (Test-Path -LiteralPath $legacy) { return $legacy }
    return $new
  }
  if (Test-Path -LiteralPath $legacy) {
    $item = Get-Item -LiteralPath $legacy -Force
    $isLink = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if (-not $isLink -and $item.PSIsContainer -and (Get-ChildItem -LiteralPath $legacy -Force | Select-Object -First 1)) { return $legacy }
  }
  return $new
}

# 舊函式名仍可用（別名）：Get-IroriHome／Stop-IroriBridge／Start-IroriTask
Set-Alias -Name Get-IroriHome -Value Get-AsnHome -Scope Global
Set-Alias -Name Stop-IroriBridge -Value Stop-AsnBridge -Scope Global

# 問使用者一個問題；沒有輸入就用預設值。非互動模式直接回預設值。
function Read-Answer([string]$Prompt, [string]$Default = '', [bool]$NonInteractive = $false) {
  if ($NonInteractive) { return $Default }
  $suffix = if ($Default) { " [$Default]" } else { '' }
  $v = Read-Host "$Prompt$suffix"
  if ([string]::IsNullOrWhiteSpace($v)) { return $Default }
  return $v.Trim()
}

function Read-YesNo([string]$Prompt, [bool]$Default = $false, [bool]$NonInteractive = $false) {
  if ($NonInteractive) { return $Default }
  $hint = if ($Default) { 'Y/n' } else { 'y/N' }
  $v = Read-Host "$Prompt ($hint)"
  if ([string]::IsNullOrWhiteSpace($v)) { return $Default }
  return ($v.Trim() -match '^(y|yes|是|好)$')
}

# pid 檔裡記的那個程序：還活著、而且不是「pid 被別的程式重用」才算。
# 判斷方式：程序的啟動時間不可能晚於 pid 檔寫入時間（橋與收發室都是先啟動、再寫 pid 檔）。
function Get-RecordedProcess([string]$PidFile) {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $raw = Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue
  $n = 0
  if (-not [int]::TryParse(("$raw").Trim(), [ref]$n) -or $n -le 4) { return $null }
  $p = Get-Process -Id $n -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try {
    $written = (Get-Item -LiteralPath $PidFile).LastWriteTime
    if ($p.StartTime -gt $written.AddSeconds(5)) { return $null }
  } catch { return $null }
  return $p
}

# 停掉這個節點的橋：先停排程（不讓它 15 秒後又拉起來），再只結束 bridge.pid、mailbox.pid 記的兩個程序。
# 絕不依名稱結束程序（電腦上別的 node、Claude 視窗都不碰）。回傳實際結束的 pid 清單。
function Stop-AsnBridge([string]$WorkDir, [string]$TaskName, [bool]$SkipTask = $false) {
  $killed = @()
  # 新名 AsnBridge-<代號> 與舊名 IroriRelayMachine-<代號> 兩種排程都要停（舊安裝留下的不能漏）
  $names = @($TaskName)
  if ($TaskName -like 'AsnBridge-*') { $names += ('IroriRelayMachine-' + $TaskName.Substring('AsnBridge-'.Length)) }
  foreach ($n in $names) {
    if (-not $SkipTask -and (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue)) {
      Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    }
  }
  foreach ($f in @('mailbox.pid', 'bridge.pid')) {
    $p = Get-RecordedProcess (Join-Path $WorkDir $f)
    if ($p) {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      $killed += $p.Id
    }
  }
  return $killed
}

# 呼叫 register.mjs（Node 小幫手），回傳解析後的物件；失敗或輸出不是 JSON 時回 ok=false
function Invoke-RegisterTool([string]$NodeExe, [string]$Tool, [string[]]$Arguments) {
  $out = & $NodeExe $Tool @Arguments 2>$null
  $text = ($out | Out-String).Trim()
  try { return ($text | ConvertFrom-Json) } catch { return [pscustomobject]@{ ok = $false; error = 'internal'; message = '安裝小幫手沒有正常回應。' } }
}

function Get-AppVersion([string]$AppDir) {
  $f = Join-Path $AppDir 'VERSION.json'
  if (-not (Test-Path -LiteralPath $f)) { return '' }
  try { $v = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json; return "$($v.sha) ($($v.date))" } catch { return '' }
}
