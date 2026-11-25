# #1788 實機驗證用，合併前要刪掉
# 用途：驗完後把正式版 0.2.97 裝回來。
# 用法：powershell -File tools\dev\1788-restore-0.2.97.ps1 [-DryRun] [-OutFile <路徑>]
param(
    [switch]$DryRun,
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '1788-common.ps1')

$url = 'https://github.com/Yooliang/asn/releases/download/v0.2.97/ASN_0.2.97_x64-setup.exe'
$expected = 'd6bede29402fbc019f1d9616da02a0c8d6a396e389b32cf1f0e848efa7c3b094'
$tmp = Join-Path $env:TEMP 'asn-1788-restore'
$setupPath = Join-Path $tmp 'ASN_0.2.97_x64-setup.exe'

Initialize-Log -Prefix 'asn-1788-restore' -OutFile $OutFile
Write-Step ('記錄檔：' + $script:LogFile)

if ($DryRun) {
    Write-Step '【乾跑模式】只做唯讀偵測，不下載、不停程序、不安裝。'
    Show-AsnPlan
    Write-Step ('會下載：' + $url)
    Write-Step ('存到：' + $setupPath)
    Write-Step ('會核對 sha256：' + $expected)
    try {
        $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing
        Write-Step ('網址檢查（HEAD）：HTTP ' + [int]$r.StatusCode + '，大小 ' + $r.Headers['Content-Length'] + ' 位元組')
    } catch {
        Write-Step ('網址檢查（HEAD）失敗：' + $_.Exception.Message)
    }
    Write-Step '會執行：/S 靜默安裝，檢查結束碼，再重開 ASN 並印出新版本。'
    Write-Step '乾跑結束。'
    exit 0
}

if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
Write-Step ('下載：' + $url)
Invoke-WebRequest -Uri $url -OutFile $setupPath -UseBasicParsing
Assert-FileSha256 -Path $setupPath -Expected $expected

Write-Step ('還原前的 ASN 版本：' + (Get-AsnVersion))
Stop-AsnByPid -Targets @(Get-AsnProcessList)
Install-AsnSilent -InstallerPath $setupPath
Start-AsnIfNotRunning
Write-Step ('還原後的 ASN 版本：' + (Get-AsnVersion))
Write-Step '完成。'
