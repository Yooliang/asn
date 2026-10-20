#!/usr/bin/env node
// 列出這台電腦上的夥伴，輸出格式仿 `claude agents --json`。
//   Grok 夥伴：讀 <GROK_AGENTS_DIR>/<uuid>/profile.json 的 name（只讀這個檔，不碰記憶、附件、資料庫）
//   Claude Code（預設不列）：IRORI_CLOUD_ROSTER_CLAUDE=1 才跑 claude agents --json（interactive/cli、排除「收發室」結尾）
//   node grok-agents.mjs          JSON
//   node grok-agents.mjs --names  只印名字
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { UUID_RE } from './config.mjs'

const execFileAsync = promisify(execFile)

const agentsDir = (env = process.env) => env.GROK_AGENTS_DIR || '/home/box/agent-data/agents'
const claudeBin = (env = process.env) => env.IRORI_CLAUDE_BIN || '/home/box/.local/bin/claude'

// 測試／Windows：IRORI_CLAUDE_SCRIPT 指向假 .mjs 時用 node 執行
function claudeAgentsExec(env = process.env) {
  const script = (env.IRORI_CLAUDE_SCRIPT || '').trim()
  if (script) return { file: process.execPath, args: [script, 'agents', '--json'] }
  return { file: claudeBin(env), args: ['agents', '--json'] }
}

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

export async function listClaudeSessions(env = process.env) {
  if ((env.IRORI_CLOUD_ROSTER_CLAUDE ?? '0') !== '1') return []
  const { file, args } = claudeAgentsExec(env)
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: 15_000, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024,
    })
    const arr = JSON.parse(stdout)
    if (!Array.isArray(arr)) return []
    return arr.filter(a => a && a.kind === 'interactive' && a.entrypoint === 'cli' && a.name && !String(a.name).endsWith('收發室'))
      .map(a => ({ name: String(a.name), status: a.status || 'idle', engine: 'claude', kind: 'claude', cwd_label: path.basename(String(a.cwd || '')) || 'claude' }))
  } catch { return [] }
}

export async function listAll(env = process.env) {
  return [...listGrokAgents(env), ...(await listClaudeSessions(env))]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = async () => {
    const all = await listAll()
    if (process.argv.includes('--names')) console.log(all.map(a => a.name).join('\n'))
    else console.log(JSON.stringify(all, null, 2))
  }
  run().catch(e => { console.error(e.message); process.exit(1) })
}
