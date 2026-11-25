# #1788 實機驗證用，合併前要刪掉
# 用途：在這台電腦裝上 #1788 的測試版（從 GitHub Actions artifact 下載）。
# 用法：powershell -File tools\dev\1788-install-test.ps1 -RunId <編號> -Sha256 <雜湊> [-DryRun] [-OutFile <路徑>]
param(
    [Parameter(Mandatory = $true)][string]$RunId,
    [string]$ArtifactName = 'asn-rehearsal-installer-unsigned-1',
    [Parameter(Mandatory = $true)][string]$Sha256,
    [switch]$DryRun,
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '1788-common.ps1')

Initialize-Log -Prefix 'asn-1788-install' -OutFile $OutFile
Write-Step ('記錄檔：' + $script:LogFile)

Test-GhReady
Write-Step 'gh 已安裝並已登入。'

$tmp = Join-Path $env:TEMP ('asn-1788-dl-' + $RunId)
$cmd = "gh run download $RunId -R Yooliang/asn -n $ArtifactName -D `"$tmp`""

if ($DryRun) {
    Write-Step '【乾跑模式】只做唯讀偵測，不下載、不停程序、不安裝。'
    Show-AsnPlan
    Write-Step ('會執行的下載指令：' + $cmd)
    Write-Step ('暫存資料夾：' + $tmp)
    Write-Step ('會核對 sha256：' + $Sha256)
    Write-Step '會執行：/S 靜默安裝，檢查結束碼，再重開 ASN 並印出新版本。'
    $names = @(gh api "repos/Yooliang/asn/actions/runs/$RunId/artifacts" --jq '.artifacts[].name')
    if ($names.Count -eq 0) { Write-Step ('run ' + $RunId + ' 目前還沒有任何 artifact（可能還在建置）。') }
    else {
        Write-Step ('run ' + $RunId + ' 的 artifact：' + ($names -join ', '))
        if ($names -contains $ArtifactName) { Write-Step ('會下載：' + $ArtifactName) }
        else { Write-Step ('注意：找不到名為 ' + $ArtifactName + ' 的 artifact。') }
    }
    Write-Step '乾跑結束。'
    exit 0
}

if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
Write-Step ('下載：' + $cmd)
gh run download $RunId -R Yooliang/asn -n $ArtifactName -D $tmp
if ($LASTEXITCODE -ne 0) { Stop-WithMessage '下載 artifact 失敗，請確認 run 編號與名稱。' }

$setup = Get-ChildItem -LiteralPath $tmp -Recurse -Filter '*-setup.exe' | Select-Object -First 1
if (-not $setup) { Stop-WithMessage '下載的內容裡找不到 *-setup.exe。' }
Assert-FileSha256 -Path $setup.FullName -Expected $Sha256

Write-Step ('安裝前的 ASN 版本：' + (Get-AsnVersion))
Stop-AsnByPid -Targets @(Get-AsnProcessList)
Install-AsnSilent -InstallerPath $setup.FullName
Start-AsnIfNotRunning
Write-Step ('安裝後的 ASN 版本：' + (Get-AsnVersion))
Write-Step '完成。'
