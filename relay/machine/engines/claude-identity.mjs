// Claude Code 轉接器的「身分判定」：send／recv 從父行程鏈與 messaging socket 認出呼叫者所在的 Claude 視窗。
// 從 identity.mjs 原樣搬來（行為不變）；identity.mjs 透過轉接器介面的 identity 區塊呼叫這裡。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 行程表：pid -> {ppid, name}
export function processTable() {
  const txt = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 20_000 }).replace(/^\s*(\d+)\s+(\d+)\s+/gm, '$1|$2|')
  const t = new Map()
  for (const line of txt.split(/\r?\n/)) { const m = line.trim().split('|'); if (m.length >= 2 && /^\d+$/.test(m[0])) t.set(Number(m[0]), { ppid: Number(m[1]), name: m[2] ?? '' }) }
  return t
}

export const sessionsDir = () => path.join(os.homedir(), '.claude', 'sessions')
export function readSession(pid) {
  try { const j = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${pid}.json`), 'utf8')); return Number(j.pid) === pid ? j : null } catch { return null }
}
export const alivePid = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// 判定呼叫者（回傳證據供 --whoami 印出）：
//  1. 沿父行程鏈往上，第一個有 ~/.claude/sessions/<pid>.json 的程序就是呼叫者所在的 claude 視窗（Windows PID，msys 的 bash 也在鏈上）。
//  2. 鏈上找不到時的備援：Claude Code 對 Bash 指令匯出 CLAUDE_CODE_MESSAGING_SOCKET（該視窗專屬的 pipe 路徑），
//     對上某個還活著的 session 的 messagingSocketPath 就算（涵蓋 nohup／背景化後父行程已消失的情況）。獨立啟動的程式沒有這個環境變數。
export function inspectCaller() {
  const ev = { chain: [], tableError: null, viaChain: null, viaEnv: null, envSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || '' }
  let table = null
  try { table = processTable() } catch (e) { ev.tableError = e.message }
  if (table) {
    let pid = table.get(process.pid)?.ppid ?? process.ppid
    for (let hops = 0; pid && hops < 40; hops++) {
      const s = readSession(pid)
      ev.chain.push({ pid, name: table.get(pid)?.name ?? '(已結束)', session: s ? (s.name || '(無名)') : null })
      if (s) { ev.viaChain = { pid, name: typeof s.name === 'string' ? s.name.trim() : '' }; break }
      pid = table.get(pid)?.ppid
    }
  }
  if (ev.envSocket) {
    try {
      for (const f of fs.readdirSync(sessionsDir()).filter(f => /^\d+\.json$/.test(f))) {
        const s = readSession(Number(f.slice(0, -5)))
        if (s && s.messagingSocketPath === ev.envSocket && alivePid(s.pid)) { ev.viaEnv = { pid: s.pid, name: typeof s.name === 'string' ? s.name.trim() : '' }; break }
      }
    } catch {}
  }
  return ev
}
