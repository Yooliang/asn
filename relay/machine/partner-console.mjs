#!/usr/bin/env node
// 本機 CLI 夥伴的主控台視窗：查詢可否切換、顯示／隱藏（Windows 用 ShowWindow；其他平台回報不支援）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = { cmd: '', engine: '', name: '', visible: null, help: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--query') out.cmd = 'query'
    else if (a === '--set') out.cmd = 'set'
    else if (a === '--engine') out.engine = argv[++i] ?? ''
    else if (a === '--name') out.name = argv[++i] ?? ''
    else if (a === '--visible') out.visible = (argv[++i] ?? '') === 'true'
    else if (a === '--help') out.help = true
  }
  return out
}

function sessionPath(pid) {
  return path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`)
}

function readSession(pid) {
  try {
    const j = JSON.parse(fs.readFileSync(sessionPath(pid), 'utf8'))
    return Number(j.pid) === pid ? j : null
  } catch { return null }
}

function alivePid(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** @returns {number|null} */
export function resolveClaudePidByName(name, env = process.env) {
  const script = env.IRORI_CLAUDE_SCRIPT || ''
  const bin = script ? process.execPath : (env.CLAUDE_BIN || 'claude')
  const pre = script ? [script] : []
  let out
  try {
    out = execFileSync(bin, [...pre, 'agents', '--json'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 << 20 })
  } catch { return null }
  let list
  try { list = JSON.parse(out) } catch { return null }
  const hit = (Array.isArray(list) ? list : []).find(a => a?.name === name && a?.kind === 'interactive')
  if (!hit?.pid) return null
  const pid = Number(hit.pid)
  if (!alivePid(pid)) return null
  const sess = readSession(pid)
  if (sess && sess.entrypoint && sess.entrypoint !== 'cli') return null
  return pid
}

/** Windows：依行程 pid 找 ConsoleWindowClass 視窗 */
function findConsoleHwndWin32(pid) {
  if (process.platform !== 'win32' || !pid) return null
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class Cw {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static IntPtr Find(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != target) return true;
      var sb = new StringBuilder(64);
      GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "ConsoleWindowClass") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Vis(IntPtr h) { return h != IntPtr.Zero && IsWindowVisible(h); }
}
"@
$pid = ${pid}
$h = [Cw]::Find([uint32]$pid)
if ($h -eq [IntPtr]::Zero) { exit 2 }
$vis = [Cw]::Vis($h)
Write-Output ("{0}|{1}" -f $h.ToInt64(), $(if ($vis) { '1' } else { '0' }))
`
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim()
    const [hs, vs] = raw.split('|')
    const hwnd = Number(hs)
    if (!hwnd) return null
    return { hwnd, visible: vs === '1' }
  } catch { return null }
}

function setConsoleVisibleWin32(hwnd, visible) {
  const show = visible ? 5 : 0   // SW_SHOW / SW_HIDE
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cw {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$h = [IntPtr]::new(${hwnd})
[Cw]::ShowWindow($h, ${show}) | Out-Null
if (${visible ? 1 : 0}) { [Cw]::SetForegroundWindow($h) | Out-Null }
`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 15_000, windowsHide: true })
}

/** @returns {{ ok: boolean, canToggle?: boolean, visible?: boolean, reason?: string }} */
export function queryConsole({ engine, name, env = process.env }) {
  if (process.platform !== 'win32') return { ok: true, canToggle: false, reason: '僅 Windows 可切換主控台視窗' }
  if (!name) return { ok: false, reason: '缺少名字' }
  let pid = null
  if (engine === 'claude' || !engine) pid = resolveClaudePidByName(name, env)
  if (!pid) return { ok: true, canToggle: false, reason: '找不到這個夥伴的主控台視窗' }
  const w = findConsoleHwndWin32(pid)
  if (!w) return { ok: true, canToggle: false, reason: '找不到這個夥伴的主控台視窗' }
  return { ok: true, canToggle: true, visible: w.visible, pid, hwnd: w.hwnd }
}

export function setConsoleVisible({ engine, name, visible, env = process.env }) {
  const q = queryConsole({ engine, name, env })
  if (!q.canToggle || !q.hwnd) return { ok: false, reason: q.reason || '無法切換' }
  if (process.platform !== 'win32') return { ok: false, reason: '僅 Windows 可切換主控台視窗' }
  setConsoleVisibleWin32(q.hwnd, visible)
  const after = findConsoleHwndWin32(q.pid)
  return { ok: true, visible: after?.visible ?? visible }
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.cmd) {
    console.error('用法：partner-console.mjs --query|--set --engine <id> --name <名字> [--visible true|false]')
    process.exit(args.help ? 0 : 2)
  }
  const body = args.cmd === 'query'
    ? queryConsole({ engine: args.engine, name: args.name })
    : setConsoleVisible({ engine: args.engine, name: args.name, visible: args.visible === true })
  console.log(JSON.stringify(body))
  process.exit(body.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
