# ASN 收發室橋：移除程式（雙擊「解除安裝.cmd」或在 PowerShell 執行）。
# 做的事：移除自動啟動的排程 → 停止橋與收發室（只結束 bridge.pid、mailbox.pid 記的兩個程序）→ 問你要不要刪除金鑰與資料夾。
#
# 預覽（不改任何東西、不連網）：  .\uninstall.ps1 -WhatIf
# 可選參數：-NodeId <代號>  -DeleteData（直接刪金鑰與資料夾）  -KeepData（不刪）  -Leave（同時從名單移除，需連網）
#           -HomeDir（測試用）  -BaseUrl（測試用）  -NodeCommand（測試用）  -NonInteractive（不提問；沒指定 -DeleteData 就不刪）
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$NodeId = '',
  [switch]$DeleteData,
  [switch]$KeepData,
  [switch]$Leave,
  [string]$HomeDir = '',
  [string]$BaseUrl = '',
  [string]$NodeCommand = 'node',
  [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'asn-common.ps1')
Initialize-Console
$preview = [bool]$WhatIfPreference
$ni = [bool]$NonInteractive

Say ''
Say '=== ASN 收發室橋：移除 ===' 'Cyan'
if ($preview) { Say '（預覽模式：只告訴你會做什麼，不會改動這台電腦，也不會連網。）' 'Yellow' }

$home_ = Get-AsnHome $HomeDir
$irori = Get-AsnDataDir $HomeDir
$id = $NodeId
if (-not $id -and (Test-Path -LiteralPath (Join-Path $irori 'node'))) { $id = (Get-Content -LiteralPath (Join-Path $irori 'node') -Raw).Trim() }
if (-not $id) {
  Say '這台電腦看起來沒有安裝過收發室橋（找不到代號），沒有東西要移除。' 'Yellow'
  exit 0
}
$taskName = "AsnBridge-$id"
$legacyTaskName = "IroriRelayMachine-$id"   # 舊安裝的排程名，兩種都處理
$workDir = Join-Path $irori "machine-$id"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
Say "要移除的是：代號 $id"

# ---- 1. 排程與程序 ----
if ($preview) {
  Say "（預覽）會移除排程 $taskName（目前$(if ($task) { '存在' } else { '不存在' })）。"
  foreach ($f in @('bridge.pid', 'mailbox.pid')) {
    $p = Get-RecordedProcess (Join-Path $workDir $f)
    Say "（預覽）$f 記的程序：$(if ($p) { '還在執行（pid ' + $p.Id + '），會結束它' } else { '沒有在執行' })"
  }
} else {
  $killed = Stop-AsnBridge $workDir $taskName $false
  if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Say '已移除自動啟動的排程。' 'Green' }
  if ($legacyTask) { Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false; Say '已移除舊名的自動啟動排程。' 'Green' }
  if (-not $task -and -not $legacyTask) { Say '沒有找到自動啟動的排程（可能早就移除了）。' }
  if ($killed.Count -gt 0) { Say "已停止橋與收發室（程序 $($killed -join '、')）。" 'Green' } else { Say '橋目前沒有在執行。' }
}

# ---- 2. 金鑰與資料夾 ----
$delete = [bool]$DeleteData
if (-not $DeleteData -and -not $KeepData -and -not $preview) {
  Say ''
  Say "金鑰與資料夾：$irori\$id.key、node、machine-$id、app"
  $delete = Read-YesNo '要刪除這些嗎？刪除後要再用這台電腦，需要重新拿邀請碼' $false $ni
}
if ($preview) {
  Say "（預覽）會問你要不要刪除金鑰（$id.key）、node 檔、machine-$id 資料夾與 app 資料夾；不刪的話它們原地保留。"
  Say '（預覽）刪除時還會問你要不要同時從 ASN 的名單移除這台電腦。'
  exit 0
}
if (-not $delete) {
  Say ''
  Say '已保留金鑰與資料夾。之後要再裝，雙擊「安裝.cmd」即可（會直接沿用，不用邀請碼）。' 'Green'
  exit 0
}

# 要不要同時離開名單：離開後這個代號才能被重新註冊（金鑰會作廢）。要先做，因為要用金鑰
$doLeave = [bool]$Leave
if (-not $Leave -and -not $ni) { $doLeave = Read-YesNo '同時把這台電腦從 ASN 的名單移除？（建議：之後想再裝同一個代號才不用再要邀請碼）' $true $ni }
if ($doLeave) {
  $nodeCmd = Get-Command $NodeCommand -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $urlArgs = if ($BaseUrl) { @('--url', $BaseUrl) } else { @() }
    $homeArgs = if ($HomeDir) { @('--home', $HomeDir) } else { @() }
    $tool = @((Join-Path $irori 'app\register.mjs'), (Join-Path $PSScriptRoot 'app\register.mjs')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $r = if ($tool) { Invoke-RegisterTool $nodeCmd.Source $tool (@('--leave', '--id', $id) + $urlArgs + $homeArgs) } else { [pscustomobject]@{ ok = $false; message = '找不到程式檔' } }
    if ($r.ok) { Say '已從名單移除這台電腦。' 'Green' } else { Say "沒有從名單移除成功（$($r.message)）。可請帳號擁有者幫你移除。" 'Yellow' }
  } else {
    Say '找不到 Node.js，沒辦法從名單移除；可請帳號擁有者幫你移除。' 'Yellow'
  }
}

$keyFile = Join-Path $irori "$id.key"
if (Test-Path -LiteralPath $keyFile) { Remove-Item -LiteralPath $keyFile -Force }
$nodeFile = Join-Path $irori 'node'
if ((Test-Path -LiteralPath $nodeFile) -and ((Get-Content -LiteralPath $nodeFile -Raw).Trim() -eq $id)) { Remove-Item -LiteralPath $nodeFile -Force }
if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
$appDir = Join-Path $irori 'app'
if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force }
# 解除安裝程式自己的副本（正在執行的這支可能刪不掉，刪不掉就留著，不影響結果）
$selfDir = Join-Path $irori 'uninstall'
if (Test-Path -LiteralPath $selfDir) { try { Remove-Item -LiteralPath $selfDir -Recurse -Force -ErrorAction Stop } catch { } }
if ((Test-Path -LiteralPath $irori) -and -not (Get-ChildItem -LiteralPath $irori -Force)) { Remove-Item -LiteralPath $irori -Force }
Say ''
Say '已刪除金鑰與資料夾，移除完成。' 'Green'
exit 0
