# ASN 收發室橋：Windows 安裝程式（給一般人用，雙擊「安裝.cmd」就會跑這支）。
# 做的事：檢查 Node.js → 用邀請碼註冊這台電腦 → 把程式放進 %USERPROFILE%\.irori-relay\app → 建立「登入時自動執行」的排程並啟動。
# 已經裝過就是「更新程式」模式：只換程式、重啟橋，不重新註冊。
#
# 預覽（不改任何東西、不連網）：  .\install.ps1 -WhatIf
# 可選參數（一般人不用）：
#   -InviteCode <邀請碼>  -NodeId <代號>  -DisplayName <這台電腦的名稱>  -Reissue（用「重設碼」重裝，金鑰不見時用）
#   -BaseUrl <仲介網址>  -HomeDir <家目錄，測試用>  -AnonKey <門鈴公開金鑰，選填>
#   -NodeCommand / -ClaudeCommand（測試用）  -NoSchedule（不建排程、不啟動，測試用）  -NonInteractive（不提問）
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InviteCode = '',
  [string]$NodeId = '',
  [string]$DisplayName = '',
  [switch]$Reissue,
  [string]$BaseUrl = '',
  [string]$HomeDir = '',
  [string]$AnonKey = '',
  [string]$NodeCommand = 'node',
  [string]$ClaudeCommand = 'claude',
  [switch]$NoSchedule,
  [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'asn-common.ps1')
Initialize-Console
$preview = [bool]$WhatIfPreference
$ni = [bool]$NonInteractive

function Stop-Install([string]$Why) {
  Say ''
  Say $Why 'Red'
  Say ''
  Say '安裝沒有完成。解決後再雙擊一次「安裝.cmd」就可以了。' 'Yellow'
  exit 1
}

Say ''
Say '=== ASN 收發室橋：安裝 ===' 'Cyan'
if ($preview) { Say '（預覽模式：只告訴你會做什麼，不會改動這台電腦，也不會連網。）' 'Yellow' }

# ---- 1. 程式檔在不在（沒解壓縮就雙擊的人最常遇到）----
$appSrc = Join-Path $PSScriptRoot 'app'
if (-not (Test-Path -LiteralPath (Join-Path $appSrc 'bridge.mjs'))) {
  Stop-Install '找不到程式檔（app 資料夾）。請先把 zip「全部解壓縮」到一個資料夾，再到那個資料夾裡雙擊「安裝.cmd」；不要直接在壓縮檔裡執行。'
}

# ---- 2. Node.js ----
$nodeCmd = Get-Command $NodeCommand -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Stop-Install "這台電腦還沒有安裝 Node.js。請到 https://nodejs.org 下載「LTS」版本安裝（一路按下一步即可），裝好後再執行一次。"
}
$nodeExe = $nodeCmd.Source
$verText = (& $nodeExe --version 2>$null | Out-String).Trim()
$major = 0
if ($verText -match '^v(\d+)\.') { $major = [int]$Matches[1] }
if ($major -lt 22) {
  Stop-Install "這台電腦的 Node.js 版本太舊了（目前是 $verText，需要 22 以上）。請到 https://nodejs.org 下載「LTS」版本安裝（會直接蓋過舊版），裝好後再執行一次。"
}
Say "已找到 Node.js $verText" 'Green'

# ---- 3. Claude Code ----
$hasClaude = [bool](Get-Command $ClaudeCommand -ErrorAction SilentlyContinue)
if ($hasClaude) {
  Say '已找到 Claude Code。' 'Green'
} else {
  Say '這台電腦還沒有 Claude Code。可以先裝，橋會先連上 ASN、把收到的信留著，等你裝好 Claude Code 並開一個視窗後才有地方轉信（裝好之後再雙擊一次「安裝.cmd」讓橋重新啟動）。' 'Yellow'
}

# ---- 4. 位置與模式 ----
$home_ = Get-AsnHome $HomeDir
$irori = Join-Path $home_ '.irori-relay'
$appDst = Join-Path $irori 'app'
$existingId = ''
$nodeFile = Join-Path $irori 'node'
if (Test-Path -LiteralPath $nodeFile) { $existingId = (Get-Content -LiteralPath $nodeFile -Raw).Trim() }
$installed = $existingId -and (Test-Path -LiteralPath (Join-Path $irori "$existingId.key")) -and -not $Reissue
$register = Join-Path $appSrc 'register.mjs'
$urlArgs = if ($BaseUrl) { @('--url', $BaseUrl) } else { @() }
$homeArgs = if ($HomeDir) { @('--home', $HomeDir) } else { @() }
$newVer = Get-AppVersion $appSrc

function Install-AppFiles {
  if (Test-Path -LiteralPath $appDst) { Remove-Item -LiteralPath $appDst -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $appDst | Out-Null
  Copy-Item -Path (Join-Path $appSrc '*') -Destination $appDst -Recurse -Force
  # 解除安裝程式留一份在 .irori-relay\uninstall，下載的資料夾刪掉了也能移除
  $un = Join-Path $irori 'uninstall'
  New-Item -ItemType Directory -Force -Path $un | Out-Null
  foreach ($f in @('uninstall.ps1', 'asn-common.ps1', 'irori-common.ps1', '解除安裝.cmd')) {
    $s = Join-Path $PSScriptRoot $f
    if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination $un -Force }
  }
}

function Start-AsnTask([string]$Id) {
  # 沿用 install-task.ps1 的排程設定（登入時執行、conhost --headless 沒有視窗、失敗 1 分鐘後重啟最多 5 次）
  try {
    & (Join-Path $appDst 'install-task.ps1') -NodeId $Id -Apply | Out-Null
    # 舊名排程（IroriRelayMachine-<代號>）若還在就移除，免得兩個排程同時拉起橋
    if (Get-ScheduledTask -TaskName "IroriRelayMachine-$Id" -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName "IroriRelayMachine-$Id" -Confirm:$false -ErrorAction SilentlyContinue
    }
    Start-ScheduledTask -TaskName "AsnBridge-$Id"
    return $true
  } catch {
    Say "建立自動啟動的排程沒有成功：$($_.Exception.Message)" 'Red'
    return $false
  }
}

Set-Alias -Name Start-IroriTask -Value Start-AsnTask   # 舊函式名別名

function Wait-BridgeUp([string]$Id) {
  for ($i = 0; $i -lt 20; $i++) {
    if (Get-RecordedProcess (Join-Path $irori "machine-$Id\bridge.pid")) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# ================= 更新模式 =================
if ($installed) {
  $id = $existingId
  $oldVer = Get-AppVersion $appDst
  Say ''
  Say "這台電腦已經裝過了（代號 $id），這次只更新程式，不會重新註冊。" 'Cyan'
  if ($preview) {
    Say "（預覽）會停止目前的橋（只停它自己記錄的程序）、把程式換成新版（$newVer）、重新啟動。金鑰與設定不動。"
    exit 0
  }
  $null = Stop-AsnBridge (Join-Path $irori "machine-$id") "AsnBridge-$id" ([bool]$NoSchedule)
  Install-AppFiles
  if ($AnonKey) { Set-Content -LiteralPath (Join-Path $irori 'anon.key') -Value $AnonKey -NoNewline -Encoding ASCII }
  if (-not $NoSchedule) {
    if (-not (Start-AsnTask $id)) { Stop-Install '程式已更新，但自動啟動排程建立失敗。' }
    if (Wait-BridgeUp $id) { Say '橋已重新啟動。' 'Green' } else { Say "橋還沒看到啟動，請稍等一分鐘；若一直沒有，可看 $irori\machine-$id\bridge.log。" 'Yellow' }
  }
  $chk = Invoke-RegisterTool $nodeExe $register (@('--check', '--id', $id) + $urlArgs + $homeArgs)
  Say ''
  if ($oldVer -or $newVer) { Say "程式版本：$oldVer -> $newVer" }
  if ($chk.ok) { Say '更新完成，這台電腦已連上 ASN。' 'Green' } else { Say "更新完成，但目前連不上 ASN（$($chk.message)）。橋會自動重試。" 'Yellow' }
  exit 0
}

# ================= 第一次安裝 =================
if ($preview) {
  $sugg = (Invoke-RegisterTool $nodeExe $register @('--suggest', $env:COMPUTERNAME)).id
  Say ''
  Say '（預覽）第一次安裝會依序做：' 'Yellow'
  Say '  1. 請你貼上邀請碼（帳號擁有者給的，15 分鐘內有效、只能用一次），並輸入這台電腦的名稱'
  Say "  2. 用邀請碼向 ASN 註冊這台電腦（建議代號：$sugg），金鑰存到 $irori\<代號>.key，不會顯示在畫面上"
  Say "  3. 把程式放到 $appDst（版本 $newVer）"
  Say "  4. 建立「登入時自動執行」的排程 AsnBridge-<代號> 並立刻啟動"
  Say '  5. 檢查連線並告訴你結果'
  exit 0
}

Say ''
Say '第一次安裝。邀請碼由帳號擁有者提供，15 分鐘內有效、只能用一次。' 'Cyan'
if ($Reissue) { Say '（重新安裝模式：請貼上帳號擁有者給你的「重設碼」，代號要跟以前一樣。）' 'Yellow' }

$code = $InviteCode
if (-not $code) { $code = Read-Answer $(if ($Reissue) { '請貼上重設碼' } else { '請貼上邀請碼' }) '' $ni }
if (-not $code) { Stop-Install '沒有填邀請碼。請向帳號擁有者要一組。' }
# 貼的是 ASN 產生的整行（「邀請碼：xxxx（只能用一次…）」）也可以：只取冒號後面那一串
if ($code -match '碼\s*[:：]\s*([^\s（(]+)') { $code = $Matches[1] }
$code = $code.Trim()

$name = $DisplayName
if (-not $name) { $name = Read-Answer '這台電腦的名稱（給人看的，例如：小美的筆電）' $env:COMPUTERNAME $ni }

$id = $NodeId
if (-not $id) {
  $sugg = (Invoke-RegisterTool $nodeExe $register @('--suggest', $env:COMPUTERNAME)).id
  if ($Reissue) { $id = Read-Answer '代號（要跟這台電腦以前的代號一樣）' '' $ni }
  else { $id = Read-Answer '代號（系統用的英文代號，通常不用改，直接按 Enter）' $sugg $ni }
}
if (-not $id) { Stop-Install '沒有代號。' }

$res = $null
for ($try = 1; $try -le 4; $try++) {
  $env:ASN_INVITE = $code; $env:IRORI_INVITE = $code
  try {
    $args_ = @('--id', $id, '--name', $name, '--machine', $name, '--kind', 'other', '--set-node') + $urlArgs + $homeArgs   # 註冊的就是這台電腦：node 檔要寫成它
    if ($Reissue) { $args_ += '--reissue' }
    $res = Invoke-RegisterTool $nodeExe $register $args_
  } finally { Remove-Item Env:\ASN_INVITE, Env:\IRORI_INVITE -ErrorAction SilentlyContinue }
  if ($res.ok) { break }
  Say ''
  Say $res.message 'Yellow'
  if ($res.error -eq 'bad_id_prefix' -and $res.prefix) {
    $id = (Invoke-RegisterTool $nodeExe $register @('--suggest', $id, '--prefix', $res.prefix)).id
    Say "已自動把代號改成 $id，再試一次。"
    continue
  }
  if ($res.error -eq 'id_taken' -and -not $ni) {
    $id = Read-Answer '請換一個代號（英文、數字、-、_，最多 32 字）' '' $ni
    if ($id) { continue }
  }
  if ($res.error -eq 'invalid_invite' -and -not $ni -and -not $InviteCode) {
    $code = Read-Answer '請貼上新的邀請碼（直接按 Enter 放棄）' '' $ni
    if ($code) { continue }
  }
  break
}
if (-not $res.ok) { Stop-Install '註冊沒有成功，這台電腦沒有被改動。' }
Say "註冊成功，代號 $id。金鑰已存在這台電腦（不會顯示）。" 'Green'

Install-AppFiles
if ($AnonKey) { Set-Content -LiteralPath (Join-Path $irori 'anon.key') -Value $AnonKey -NoNewline -Encoding ASCII }
Say "程式已放到 $appDst" 'Green'

$started = $true
if (-not $NoSchedule) {
  $started = Start-AsnTask $id
  if ($started) {
    if (Wait-BridgeUp $id) { Say '橋已啟動，之後每次登入 Windows 都會自動執行。' 'Green' }
    else { Say "橋還沒看到啟動，請稍等一分鐘；若一直沒有，可看 $irori\machine-$id\bridge.log。" 'Yellow' }
  }
}

$chk = Invoke-RegisterTool $nodeExe $register (@('--check', '--id', $id) + $urlArgs + $homeArgs)
Say ''
if ($res.verified -or $chk.ok) {
  Say '裝好了！這台電腦已經連上 ASN。' 'Green'
  Say "怎麼確認：到ASN 的名單，約一兩分鐘內會看到「$name」顯示在線。"
  Say '如果名單裡看得到這台電腦、卻看不到上面開著的 Claude 視窗，請告訴帳號擁有者：這個代號需要開通「回報視窗」。'
  if (-not $hasClaude) { Say '提醒：這台電腦還沒有 Claude Code，裝好後請再雙擊一次「安裝.cmd」。' 'Yellow' }
} else {
  Say "已經註冊並安裝，但現在連不上 ASN（$($chk.message)）。橋會自動重試，一兩分鐘後再到名單看看。" 'Yellow'
}
if (-not $started) { Stop-Install '自動啟動排程建立失敗，請把這個畫面截圖給帳號擁有者。' }
exit 0
