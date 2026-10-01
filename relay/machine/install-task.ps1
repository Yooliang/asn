# 建立「登入時執行、隱藏視窗」的工作排程。預設只預覽；加 -Apply 才真的建立。
#   .\install-task.ps1                 預覽（不改任何東西）
#   .\install-task.ps1 -Apply          建立排程 IroriRelayMachine-<ID>
#   .\install-task.ps1 -Uninstall      移除排程
param([string]$NodeId = 'H', [switch]$Apply, [switch]$Uninstall)
$name = "IroriRelayMachine-$NodeId"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $dir 'run-bridge.ps1'
if ($Uninstall) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "removed $name"; return }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -NodeId $NodeId"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
if (-not $Apply) {
  "preview only (nothing changed). Task: $name`n  run: powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -NodeId $NodeId`n  trigger: at logon of $env:USERNAME, hidden, restart on failure x5`n  add -Apply to create it."
  return
}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
"created $name (starts at next logon; run 'Start-ScheduledTask $name' to start now)"
