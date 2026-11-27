// 啟動自動發佈常駐程式本體（#2436）。獨立成一支，不 import auto_publish.mjs，避免互相引用。
// Windows：用 WMI Win32_Process.Create 啟動。Node 的 detached 只讓子程序脫離主控台，沒有脫離工作排程的 job object，
// 排程結束巡檢那次執行時常駐程式可能被一起收掉；WMI 建立的程序父程序是 WMI 服務，不在排程的 job 裡，也沒有主控台、不開視窗。
// 其他平台（CI、開發機）退回 Node 的 detached。
import { spawnSync, spawn } from 'node:child_process'

// 排程動作用 conhost.exe 啟動巡檢時帶的參數（不開視窗）；手冊第 9 節的指令用它
export const CONHOST_NO_WINDOW_FLAG = '--headless'

// 命令列與工作目錄用環境變數傳給 PowerShell，不經過引號跳脫
export const WMI_ENV_CMDLINE = 'ASN_START_CMDLINE'
export const WMI_ENV_CWD = 'ASN_START_CWD'
export const WMI_START_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:${WMI_ENV_CMDLINE}; CurrentDirectory = $env:${WMI_ENV_CWD} }`,
  'if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create 回傳 $($r.ReturnValue)" }',
  'Write-Output $r.ProcessId',
].join('; ')

// Windows 命令列：每個參數都加雙引號（路徑可能有空白；參數裡的雙引號先跳脫）
export const quoteArg = (a) => `"${String(a).replace(/"/g, '\\"')}"`
export const buildCommandLine = (execPath, args) => [execPath, ...args].map(quoteArg).join(' ')

// 回新程序的 pid；失敗丟例外
export function startViaWmi({ execPath, args, cwd }, { run = spawnSync, platform = process.platform, spawnChild = spawn } = {}) {
  if (platform !== 'win32') {
    const c = spawnChild(execPath, args, { cwd, detached: true, stdio: 'ignore' })
    c.on('error', () => { /* 起不來由下一次巡檢發現 */ })
    c.unref()
    return c.pid
  }
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WMI_START_SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, [WMI_ENV_CMDLINE]: buildCommandLine(execPath, args), [WMI_ENV_CWD]: cwd },
  })
  const pid = Number.parseInt(String(r.stdout ?? '').trim(), 10)
  if (r.status !== 0 || !Number.isInteger(pid)) throw new Error(`WMI 啟動失敗（結束碼 ${r.status}）${String(r.stderr ?? '').trim().slice(0, 200)}`)
  return pid
}
