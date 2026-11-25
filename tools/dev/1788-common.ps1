# #1788 實機驗證用，合併前要刪掉
# 共用函式：停 ASN（只停自己路徑的 PID）、靜默安裝、重開、記錄。
# 用法：由 1788-install-test.ps1、1788-restore-0.2.97.ps1 以 dot-source 載入。
# 注意：本檔為 UTF-8 帶 BOM，PowerShell 5.1 才能正確讀中文。

$script:AsnExe = Join-Path $env:LOCALAPPDATA 'ASN\asn.exe'
$script:LogFile = $null
$script:OutFilePath = $null

function Initialize-Log {
    param([string]$Prefix, [string]$OutFile)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script:LogFile = Join-Path $env:TEMP ("{0}-{1}.log" -f $Prefix, $stamp)
    $script:OutFilePath = $OutFile
    if ($OutFile) {
        $dir = Split-Path -Parent $OutFile
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        Set-Content -LiteralPath $OutFile -Value '' -Encoding UTF8
    }
}

function Write-Step {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $line
    if ($script:LogFile) { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 }
    if ($script:OutFilePath) { Add-Content -LiteralPath $script:OutFilePath -Value $line -Encoding UTF8 }
}

function Stop-WithMessage {
    param([string]$Message)
    Write-Step ('中止：' + $Message)
    exit 1
}

function Get-AsnVersion {
    if (-not (Test-Path -LiteralPath $script:AsnExe)) { return '（找不到 asn.exe）' }
    return (Get-Item -LiteralPath $script:AsnExe).VersionInfo.ProductVersion
}

# 只回傳「路徑正好是 %LOCALAPPDATA%\ASN\asn.exe」的 asn 程序，其他一律不碰。
function Get-AsnProcessList {
    $found = @()
    foreach ($p in (Get-Process -Name 'asn' -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $p.Path } catch { $path = $null }
        if ($path -and ($path -ieq $script:AsnExe)) { $found += $p }
    }
    return $found
}

function Test-GhReady {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Stop-WithMessage '這台電腦沒有安裝 gh（GitHub 命令列工具），請先安裝後再執行。'
    }
    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage 'gh 還沒登入 GitHub，請先執行 gh auth login 再重來。'
    }
}

function Assert-FileSha256 {
    param([string]$Path, [string]$Expected)
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    $want = $Expected.ToLowerInvariant() -replace '^sha256:', ''
    if ($actual -ne $want) {
        Stop-WithMessage ("安裝檔的 sha256 對不上，不安裝。預期 {0}，實際 {1}。" -f $want, $actual)
    }
    Write-Step ('sha256 核對通過：' + $actual)
}

function Stop-AsnByPid {
    param([System.Diagnostics.Process[]]$Targets)
    if (-not $Targets -or $Targets.Count -eq 0) { Write-Step 'ASN 目前沒有在執行，不需要停。'; return }
    $ids = @($Targets | ForEach-Object { $_.Id })
    foreach ($p in $Targets) { try { [void]$p.CloseMainWindow() } catch { } }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 500
        $left = @($ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    } while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
    foreach ($id in $left) {
        Write-Step ("PID {0} 只縮到系統匣，改用 PID 結束" -f $id)
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    Write-Step ('已停止 ASN 程序 PID：' + ($ids -join ', '))
}

function Install-AsnSilent {
    param([string]$InstallerPath)
    Write-Step ('開始靜默安裝：' + $InstallerPath)
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        Stop-WithMessage ('安裝程式結束碼不是 0（{0}），請檢查後再試。' -f $proc.ExitCode)
    }
    Write-Step '安裝程式正常結束（結束碼 0）。'
}

# 安裝後若安裝程式已自己開了 asn.exe 就不重複開。
function Start-AsnIfNotRunning {
    Start-Sleep -Seconds 5
    $running = @(Get-AsnProcessList)
    if ($running.Count -gt 0) {
        Write-Step ('安裝程式已自動開啟 ASN（PID：{0}），不重複開。' -f (($running | ForEach-Object { $_.Id }) -join ', '))
        return
    }
    if (-not (Test-Path -LiteralPath $script:AsnExe)) { Stop-WithMessage '安裝後找不到 asn.exe。' }
    $p = Start-Process -FilePath $script:AsnExe -PassThru
    Write-Step ('已重新開啟 ASN（PID：{0}）。' -f $p.Id)
    Start-Sleep -Seconds 3
}

function Show-AsnPlan {
    Write-Step ('目前 ASN 版本：' + (Get-AsnVersion))
    $list = @(Get-AsnProcessList)
    if ($list.Count -eq 0) { Write-Step '會停止的 PID：（目前沒有）' }
    else { Write-Step ('會停止的 PID：' + (($list | ForEach-Object { $_.Id }) -join ', ') + '（先 CloseMainWindow，10 秒後仍在就用 Stop-Process -Id）') }
    Write-Step '不會碰終端服務（wezterm-mux-server）。'
}
