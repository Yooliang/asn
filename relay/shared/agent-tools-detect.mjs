// 本機 CLI 是否在 PATH 上（與 agent-tools.catalog.json 同步；機器橋／local-partner-launch 用）。
// ASN 桌面版請走 Rust agent_tools::ai_cli_detect，邏輯應與此處一致。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { AGENT_TOOLS, LAUNCH_TOOL_IDS } from './agent-tools.mjs'

const execFileAsync = promisify(execFile)

/**
 * @returns {Promise<Record<string, { id: string, label: string, cmd: string|null, version: string|null, installHint: string }>>}
 */
export async function detectAgentTools(deps = {}) {
  const platform = deps.platform ?? process.platform
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? ''
  const execLookup = deps.execLookup ?? defaultLookup
  const execFileFn = deps.execFile ?? execFileAsync
  const out = {}
  for (const def of AGENT_TOOLS) {
    if (!LAUNCH_TOOL_IDS.includes(def.id)) continue
    const cmd = await execLookup(def.binary, { platform, pathEnv })
    let version = null
    if (cmd) {
      try { version = await readVersion(def.binary, cmd, execFileFn) } catch { version = null }
    }
    out[def.id] = {
      id: def.id,
      label: def.label,
      cmd,
      version,
      installHint: def.installBlurb ?? def.install_blurb ?? '',
    }
  }
  return out
}

export function toolsList(map) {
  return LAUNCH_TOOL_IDS.map(id => map[id]).filter(Boolean)
}

// 測試用假執行檔資料夾：ASN_MOCK_BIN_DIR 優先，沒設才讀舊名 IRORI_ASN_MOCK_BIN_DIR（#14 第一期改名相容）
export function mockBinDir(env = process.env) {
  const n = String(env.ASN_MOCK_BIN_DIR ?? '').trim()
  return n || String(env.IRORI_ASN_MOCK_BIN_DIR ?? '').trim()
}

async function defaultLookup(name, { platform, pathEnv }) {
  const base = mockBinDir()
  if (base) {
    const win = path.join(base, `${name}.exe`)
    const nx = path.join(base, name)
    if (fs.existsSync(win)) return win
    if (fs.existsSync(nx)) return nx
  }
  if (platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `where ${name}`], { timeout: 8000, windowsHide: true })
      const line = String(stdout).split(/\r?\n/).map(s => s.trim()).find(Boolean)
      if (line && fs.existsSync(line)) return line
    } catch { /* 找不到 */ }
    return null
  }
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name)
    try { if (fs.statSync(p).isFile()) return p } catch { /* 略過 */ }
  }
  return null
}

async function readVersion(_binary, cmd, execFileFn) {
  try {
    const { stdout } = await execFileFn(cmd, ['--version'], { timeout: 12_000, windowsHide: true, env: cleanEnv() })
    const t = String(stdout).trim().split(/\r?\n/)[0]?.trim()
    return t ? t.slice(0, 120) : null
  } catch {
    return null
  }
}

function cleanEnv() {
  const keep = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL'])
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (keep.has(k) || keep.has(k.toUpperCase())) out[k] = v
  }
  return out
}
