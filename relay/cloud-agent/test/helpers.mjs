import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../config.mjs'
import { createCore } from '../../machine/relay-core.mjs'
import { FAKE_KEY } from './fake-relay.mjs'

export const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const testDir = path.dirname(fileURLToPath(import.meta.url))
export const fakeClaudeBin = path.join(testDir, 'fake-claude-agents.mjs')
export const script = name => path.join(dir, name)
export const sleep = ms => new Promise(r => setTimeout(r, ms))

// 暫存根目錄＋指向假 relay 的環境變數（不碰真實 /workspace、不碰正式後端、不讀本機 Grok／Claude）
export function tmpEnv(url, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-test-'))
  const grokAgentsDir = extra.GROK_AGENTS_DIR || path.join(root, 'grok-agents-isolated')
  if (!extra.GROK_AGENTS_DIR) fs.mkdirSync(grokAgentsDir, { recursive: true })
  const env = {
    IRORI_CLOUD_HOME: root,
    IRORI_RELAY_URL: url,
    IRORI_RELAY_KEY: '',
    IRORI_RELAY_ANON_KEY: '',
    IRORI_CLOUD_ROSTER_AUTO: '0',
    GROK_AGENTS_DIR: grokAgentsDir,
    IRORI_CLAUDE_BIN: fakeClaudeBin,
    FAKE_CLAUDE_AGENTS_JSON: '[]',
    ...extra,
  }
  const merged = { ...process.env, ...env }
  return { root, env, cfg: resolveConfig(merged) }
}
export const rm = root => fs.rmSync(root, { recursive: true, force: true })

export function apiFor(cfg, key = FAKE_KEY) {
  return createCore({ baseUrl: cfg.baseUrl, key, anonKey: '', log: () => {}, workDir: cfg.mailDir }).api
}

// 執行 script，收 stdout/stderr/exit code
export function run(file, args, { env = {}, stdin } = {}) {
  return new Promise(res => {
    const c = spawn(process.execPath, [script(file), ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } })
    let stdout = '', stderr = ''
    c.stdout.on('data', d => (stdout += d)); c.stderr.on('data', d => (stderr += d))
    c.on('close', code => res({ code, stdout, stderr }))
    c.stdin.end(stdin ?? '')
  })
}
