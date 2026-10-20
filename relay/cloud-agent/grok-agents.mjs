#!/usr/bin/env node
// 列出這台電腦上的夥伴，輸出格式仿 `claude agents --json`。
//   Grok 夥伴：讀 <GROK_AGENTS_DIR>/<uuid>/profile.json 的 name（只讀這個檔，不碰記憶、附件、資料庫）
//   Claude Code：`claude agents --json`，只留 kind=interactive 且 entrypoint=cli（同 relay/machine/bridge.mjs），排除名稱以「收發室」結尾的
//   node grok-agents.mjs          JSON
//   node grok-agents.mjs --names  只印名字
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { UUID_RE } from './config.mjs'

const agentsDir = (env = process.env) => env.GROK_AGENTS_DIR || '/home/box/agent-data/agents'
const claudeBin = (env = process.env) => env.IRORI_CLAUDE_BIN || '/home/box/.local/bin/claude'

export function listGrokAgents(env = process.env) {
  const DIR = agentsDir(env)
  const list = []
  let ids = []
  try { ids = fs.readdirSync(DIR) } catch { return list }
  for (const id of ids) {
    if (!UUID_RE.test(id)) continue
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DIR, id, 'profile.json'), 'utf8'))
      const name = String(p.name || '').trim()
      if (name) list.push({ id, name, status: 'idle', engine: 'grok', kind: 'grok', cwd_label: 'grok-cloud' })
    } catch {}
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
}

export function listClaudeSessions(env = process.env) {
  try {
    const out = execFileSync(claudeBin(env), ['agents', '--json'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env },
    })
    const arr = JSON.parse(out)
    if (!Array.isArray(arr)) return []
    return arr.filter(a => a && a.kind === 'interactive' && a.entrypoint === 'cli' && a.name && !String(a.name).endsWith('收發室'))
      .map(a => ({ name: String(a.name), status: a.status || 'idle', engine: 'claude', kind: 'claude', cwd_label: path.basename(String(a.cwd || '')) || 'claude' }))
  } catch { return [] }
}

export function listAll(env = process.env) { return [...listGrokAgents(env), ...listClaudeSessions(env)] }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = listAll()
  if (process.argv.includes('--names')) console.log(all.map(a => a.name).join('\n'))
  else console.log(JSON.stringify(all, null, 2))
}
