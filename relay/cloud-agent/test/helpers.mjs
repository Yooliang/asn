import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../config.mjs'
import { createCore } from '../../machine/relay-core.mjs'
import { FAKE_KEY } from './fake-relay.mjs'
import { applyEnvCompat, withoutRelayEnv } from '../env-compat.mjs'

export const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const testDir = path.dirname(fileURLToPath(import.meta.url))
export const fakeClaudeBin = path.join(testDir, 'fake-claude-agents.mjs')
export const script = name => path.join(dir, name)
export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 去掉 shell／start.sh 帶進來的 IRORI_* 與 ASN_* */
export const withoutIroriEnv = withoutRelayEnv

// 測試用完整 process env：先剔除 IRORI_*／ASN_*，再套用 tmpEnv／run 的覆寫
export function childEnv(overrides = {}) {
  return { ...withoutRelayEnv(process.env), ...overrides }
}

// 暫存根目錄＋指向假 relay 的環境變數（不碰真實 /workspace、不碰正式後端、不讀本機 Grok／Claude）
export function tmpEnv(url, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-agent-test-'))
  const grokAgentsDir = extra.GROK_AGENTS_DIR || path.join(root, 'grok-agents-isolated')
  if (!extra.GROK_AGENTS_DIR) fs.mkdirSync(grokAgentsDir, { recursive: true })
  const env = {
    ASN_CLOUD_HOME: root,
    ASN_RELAY_URL: url,
    ASN_RELAY_KEY: '',
    ASN_RELAY_ANON_KEY: '',
    GROK_AGENTS_DIR: grokAgentsDir,
    ASN_CLAUDE_BIN: process.execPath,
    ASN_CLAUDE_SCRIPT: fakeClaudeBin,
    FAKE_CLAUDE_AGENTS_JSON: '[]',
    ...extra,
  }
  const hasRosterAuto = (env.ASN_CLOUD_ROSTER_AUTO ?? env.IRORI_CLOUD_ROSTER_AUTO ?? '') !== ''
  if (!hasRosterAuto) env.ASN_CLOUD_ROSTER_AUTO = '0'
  const { env: normalized } = applyEnvCompat(env)
  return { root, env: normalized, cfg: resolveConfig(childEnv(normalized)) }
}
export const rm = root => fs.rmSync(root, { recursive: true, force: true })

export function apiFor(cfg, key = FAKE_KEY) {
  return createCore({ baseUrl: cfg.baseUrl, key, anonKey: '', log: () => {}, workDir: cfg.mailDir }).api
}

// 執行 script，收 stdout/stderr/exit code
export function run(file, args, { env = {}, stdin } = {}) {
  return new Promise(res => {
    const c = spawn(process.execPath, [script(file), ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv(env) })
    let stdout = '', stderr = ''
    c.stdout.on('data', d => (stdout += d)); c.stderr.on('data', d => (stderr += d))
    c.on('close', code => res({ code, stdout, stderr }))
    c.stdin.end(stdin ?? '')
  })
}
