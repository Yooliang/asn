// 雲端代理收發室工具的共用設定：路徑、節點代號、金鑰讀取。全部可用環境變數改（測試就是靠這個指到暫存資料夾）。
//   ASN_CLOUD_HOME      根目錄（預設 /workspace，重置後保留的那個）
//   ASN_CLOUD_KEY_DIR   金鑰檔目錄（預設 ASN_HOME；沒有就 <根>/.asn，若只有舊 .irori-relay 則沿用）
//   ASN_CLOUD_MAIL_DIR  信件目錄（預設 <根>/relay）
//   ASN_RELAY_ID        節點代號（預設 grok）
//   ASN_RELAY_URL       仲介網址（預設正式；測試指到 127.0.0.1）
//   ASN_RELAY_KEY       節點金鑰（優先於金鑰檔）
//   ASN_RELAY_ANON_KEY／<金鑰目錄>/anon.key：Realtime 門鈴（pickAnon 會對專案代號並內建新後台 anon；舊名 IRORI_RELAY_ANON_KEY 經 env-compat 併入新名）
//   舊名 IRORI_* 由 env-compat.mjs 在 resolveConfig 入口轉成 ASN_*（ONBOARDING §5）
import { pickAnon } from '../machine/anon.mjs'
import { resolveHome } from '../machine/home.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_URL, ID_RE } from '../machine/register.mjs'
import { applyEnvCompat } from './env-compat.mjs'

export { ID_RE }
export const NO_KEY_MSG = '沒有設定 ASN_RELAY_KEY'
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class Fail extends Error { constructor(code, msg) { super(msg); this.code = code } }

// 金鑰目錄：照 ../machine/home.mjs 的順序（<根>/.asn 優先、只有舊 <根>/.irori-relay 才沿用）；ASN_HOME 由 resolveConfig 另外處理
function defaultKeyDir(root) {
  return resolveHome({ base: root, env: {} }).primary
}

export function resolveConfig(rawEnv = process.env) {
  const { env } = applyEnvCompat(rawEnv)
  const root = env.ASN_CLOUD_HOME || '/workspace'
  const keyDir = env.ASN_CLOUD_KEY_DIR || (env.ASN_HOME || '').trim() || defaultKeyDir(root)
  const mailDir = env.ASN_CLOUD_MAIL_DIR || path.join(root, 'relay')
  const node = (env.ASN_RELAY_ID || 'grok').trim()
  const name = (env.ASN_CLOUD_ROSTER_NAME || 'Grok').trim()
  const grokAgentsDir = (env.GROK_AGENTS_DIR || '/home/box/agent-data/agents').trim()
  const claudeBin = (env.ASN_CLAUDE_BIN || '/home/box/.local/bin/claude').trim()
  const claudeScript = (env.ASN_CLAUDE_SCRIPT || '').trim()
  const rosterAuto = (env.ASN_CLOUD_ROSTER_AUTO ?? '1') !== '0'
  const rosterClaude = (env.ASN_CLOUD_ROSTER_CLAUDE ?? '0') === '1'
  return {
    root, keyDir, mailDir, node, name,
    grokAgentsDir, claudeBin, claudeScript, rosterAuto, rosterClaude,
    baseUrl: (env.ASN_RELAY_URL || DEFAULT_URL).replace(/\/+$/, ''),
    keyFile: path.join(keyDir, `${node}.key`),
    inboxFile: path.join(mailDir, 'inbox.jsonl'),
    doneFile: path.join(mailDir, 'done.jsonl'),
    logFile: path.join(mailDir, 'recv.log'),
    pidFile: path.join(mailDir, 'recv.pid'),
    agentsFile: path.join(mailDir, 'agents.json'),
    agentsEnv: env.ASN_CLOUD_AGENTS || '',
    cwdLabel: (env.ASN_CLOUD_ROSTER_LABEL || 'grok-cloud').trim(),
    engine: (env.ASN_CLOUD_ENGINE || 'grok').trim(),
    pollMs: Number(env.ASN_RECV_POLL_MS || 120_000),
    rosterMs: Number(env.ASN_ROSTER_MS || 60_000),
    rosterRetryAfter403Ms: Number(env.ASN_ROSTER_403_RETRY_MS || 3_600_000),
    _resolvedEnv: env,
  }
}

export function rosterScanEnvFrom(cfg) {
  const base = cfg._resolvedEnv ?? applyEnvCompat(process.env).env
  return {
    ...base,
    GROK_AGENTS_DIR: cfg.grokAgentsDir,
    ASN_CLAUDE_BIN: cfg.claudeBin,
    ASN_CLAUDE_SCRIPT: cfg.claudeScript,
    ASN_CLOUD_ROSTER_AUTO: cfg.rosterAuto ? '1' : '0',
    ASN_CLOUD_ROSTER_CLAUDE: cfg.rosterClaude ? '1' : '0',
  }
}

export function readKey(cfg, rawEnv = cfg._resolvedEnv ?? process.env) {
  const { env } = applyEnvCompat(rawEnv)
  const fromEnv = (env.ASN_RELAY_KEY || '').trim()
  if (fromEnv) return fromEnv
  try { return fs.readFileSync(cfg.keyFile, 'utf8').trim() } catch { return '' }
}

export function readAnonKey(cfg, rawEnv = cfg._resolvedEnv ?? process.env) {
  const { env } = applyEnvCompat(rawEnv)
  let f = ''
  try { f = fs.readFileSync(path.join(cfg.keyDir, 'anon.key'), 'utf8').trim() } catch { /* 沒有檔案 */ }
  return pickAnon(cfg.baseUrl, [env.ASN_RELAY_ANON_KEY, f])
}

const STATUSES = new Set(['idle', 'busy', 'waiting'])

function normalizeManualEntry(a, cfg) {
  const name = String((typeof a === 'string' ? a : a?.name) ?? '').trim().slice(0, 100)
  if (!name || /收發室$/.test(name)) return null
  return {
    name,
    status: STATUSES.has(a?.status) ? a.status : 'idle',
    engine: String(a?.engine ?? cfg.engine).trim().slice(0, 20) || cfg.engine,
    cwd_label: String(a?.cwd_label ?? cfg.cwdLabel).trim().slice(0, 100),
  }
}

export function loadManualAgentEntries(cfg) {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(cfg.agentsFile, 'utf8')) } catch {}
  if (!Array.isArray(raw)) raw = cfg.agentsEnv ? cfg.agentsEnv.split(',').map(name => ({ name })) : []
  const out = []
  const seen = new Set()
  for (const a of raw) {
    const row = normalizeManualEntry(a, cfg)
    if (!row || seen.has(row.name)) continue
    seen.add(row.name)
    out.push(row)
    if (out.length >= 30) break
  }
  return out
}

export function loadAgents(cfg) {
  const manual = loadManualAgentEntries(cfg)
  return manual.length ? manual : [{ name: cfg.name, status: 'idle', engine: cfg.engine, cwd_label: cfg.cwdLabel }]
}

function normalizeScannedEntry(a, cfg) {
  const name = String(a?.name ?? '').trim()
  if (!name || /收發室$/.test(name)) return null
  return {
    name,
    status: STATUSES.has(a?.status) ? a.status : 'idle',
    engine: String(a?.engine ?? cfg.engine).trim().slice(0, 20) || cfg.engine,
    cwd_label: String(a?.cwd_label ?? cfg.cwdLabel).trim().slice(0, 100) || cfg.cwdLabel,
  }
}

function mergeScannedWithManual(scanned, manual, cfg) {
  const manualMap = new Map(manual.map(a => [a.name, a]))
  const byName = new Map()
  const order = []
  for (const raw of scanned) {
    const base = normalizeScannedEntry(raw, cfg)
    if (!base) continue
    const m = manualMap.get(base.name)
    const row = m ? {
      ...base,
      status: STATUSES.has(m.status) ? m.status : base.status,
      cwd_label: m.cwd_label || base.cwd_label,
    } : base
    if (!byName.has(row.name)) order.push(row.name)
    byName.set(row.name, row)
  }
  for (const m of manual) {
    if (!byName.has(m.name)) {
      byName.set(m.name, m)
      order.push(m.name)
    }
  }
  if (!order.length) {
    return [{ name: cfg.name, status: 'idle', engine: cfg.engine, cwd_label: cfg.cwdLabel }]
  }
  return order.map(n => byName.get(n)).slice(0, 30)
}

export async function resolveCloudAgents(cfg, env = rosterScanEnvFrom(cfg), listAllFn) {
  const manual = loadManualAgentEntries(cfg)
  if (!cfg.rosterAuto) return loadAgents(cfg)
  let scanned = []
  try {
    const listAll = listAllFn ?? (await import('./grok-agents.mjs')).listAll
    scanned = await listAll(env)
  } catch {}
  if (!Array.isArray(scanned)) scanned = []
  if (!scanned.length && !manual.length) {
    return [{ name: cfg.name, status: 'idle', engine: cfg.engine, cwd_label: cfg.cwdLabel }]
  }
  return mergeScannedWithManual(scanned, manual, cfg)
}

/** @deprecated 請用 resolveCloudAgents；recv roster 仍呼叫此別名 */
export async function rosterAgentsForReport(cfg, env = rosterScanEnvFrom(cfg), listAllFn) {
  return resolveCloudAgents(cfg, env, listAllFn)
}
