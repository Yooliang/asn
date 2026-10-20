// 雲端代理收發室工具的共用設定：路徑、節點代號、金鑰讀取。全部可用環境變數改（測試就是靠這個指到暫存資料夾）。
//   IRORI_CLOUD_HOME      根目錄（預設 /workspace，重置後保留的那個）
//   IRORI_CLOUD_KEY_DIR   金鑰檔目錄（預設 <根>/.irori-relay；只是備援，主要身分來源是環境變數 IRORI_RELAY_KEY）
//   IRORI_CLOUD_MAIL_DIR  信件目錄（預設 <根>/relay）：inbox.jsonl、done.jsonl、recv.log、recv.pid
//   IRORI_RELAY_ID        節點代號（預設 grok）
//   IRORI_RELAY_URL       仲介網址（預設正式；測試指到 127.0.0.1）
//   IRORI_RELAY_KEY       節點金鑰（優先於金鑰檔）；IRORI_RELAY_ANON_KEY／<金鑰目錄>/anon.key：Realtime 門鈴用的公開 anon 金鑰（沒有＝只輪詢）
//   IRORI_CLOUD_ROSTER_NAME（預設 Grok）／IRORI_CLOUD_ROSTER_LABEL（預設 grok-cloud）／IRORI_CLOUD_ENGINE（預設 grok）
//   agents.json／IRORI_CLOUD_AGENTS：手動名單；與自動掃描合併（同名時 status、cwd_label 以 agents.json 為準）
//   自動掃描（Grok 雲端預設開）：grok-agents.mjs；IRORI_CLOUD_ROSTER_AUTO=0 關閉
//   GROK_AGENTS_DIR、IRORI_CLAUDE_BIN、IRORI_CLAUDE_SCRIPT（測試用 node 跑假 claude）、IRORI_CLOUD_ROSTER_CLAUDE=1 才列 Claude 視窗
import fs from 'node:fs'
import path from 'node:path'
// 協定常數沿用 relay/machine，不複製一份
import { DEFAULT_URL, ID_RE } from '../machine/register.mjs'

export { ID_RE }
export const NO_KEY_MSG = '沒有設定 IRORI_RELAY_KEY'
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class Fail extends Error { constructor(code, msg) { super(msg); this.code = code } }

export function resolveConfig(env = process.env) {
  const root = env.IRORI_CLOUD_HOME || '/workspace'
  const keyDir = env.IRORI_CLOUD_KEY_DIR || path.join(root, '.irori-relay')
  const mailDir = env.IRORI_CLOUD_MAIL_DIR || path.join(root, 'relay')
  const node = (env.IRORI_RELAY_ID || 'grok').trim()
  const name = (env.IRORI_CLOUD_ROSTER_NAME || 'Grok').trim()
  const grokAgentsDir = (env.GROK_AGENTS_DIR || '/home/box/agent-data/agents').trim()
  const claudeBin = (env.IRORI_CLAUDE_BIN || '/home/box/.local/bin/claude').trim()
  const claudeScript = (env.IRORI_CLAUDE_SCRIPT || '').trim()
  const rosterAuto = (env.IRORI_CLOUD_ROSTER_AUTO ?? '1') !== '0'
  const rosterClaude = (env.IRORI_CLOUD_ROSTER_CLAUDE ?? '0') === '1'
  return {
    root, keyDir, mailDir, node, name,
    grokAgentsDir, claudeBin, claudeScript, rosterAuto, rosterClaude,
    baseUrl: (env.IRORI_RELAY_URL || DEFAULT_URL).replace(/\/+$/, ''),
    keyFile: path.join(keyDir, `${node}.key`),
    inboxFile: path.join(mailDir, 'inbox.jsonl'),
    doneFile: path.join(mailDir, 'done.jsonl'),
    logFile: path.join(mailDir, 'recv.log'),
    pidFile: path.join(mailDir, 'recv.pid'),
    agentsFile: path.join(mailDir, 'agents.json'),
    agentsEnv: env.IRORI_CLOUD_AGENTS || '',
    cwdLabel: (env.IRORI_CLOUD_ROSTER_LABEL || 'grok-cloud').trim(),
    engine: (env.IRORI_CLOUD_ENGINE || 'grok').trim(),
    pollMs: Number(env.IRORI_RECV_POLL_MS || 120_000),
    rosterMs: Number(env.IRORI_ROSTER_MS || 60_000),
    rosterRetryAfter403Ms: Number(env.IRORI_ROSTER_403_RETRY_MS || 3_600_000),
    _resolvedEnv: env,
  }
}

// listAll / roster 掃描用的 env：以 cfg 裡解析好的路徑為準，並保留 FAKE_CLAUDE_AGENTS_JSON 等測試用變數
export function rosterScanEnvFrom(cfg) {
  const base = cfg._resolvedEnv ?? process.env
  return {
    ...base,
    GROK_AGENTS_DIR: cfg.grokAgentsDir,
    IRORI_CLAUDE_BIN: cfg.claudeBin,
    IRORI_CLAUDE_SCRIPT: cfg.claudeScript,
    IRORI_CLOUD_ROSTER_AUTO: cfg.rosterAuto ? '1' : '0',
    IRORI_CLOUD_ROSTER_CLAUDE: cfg.rosterClaude ? '1' : '0',
  }
}

export function readKey(cfg, env = process.env) {
  const fromEnv = (env.IRORI_RELAY_KEY || '').trim()
  if (fromEnv) return fromEnv
  try { return fs.readFileSync(cfg.keyFile, 'utf8').trim() } catch { return '' }
}

export function readAnonKey(cfg, env = process.env) {
  const v = (env.IRORI_RELAY_ANON_KEY || '').trim()
  if (v) return v
  try { return fs.readFileSync(path.join(cfg.keyDir, 'anon.key'), 'utf8').trim() } catch { return '' }
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

// agents.json → IRORI_CLOUD_AGENTS；沒有設定時回 []（不含預設 Grok）
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

// 僅手動名單（相容舊呼叫）；都沒有＝只有預設那位
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

// roster／send --from／inbox --agent 共用：掃描＋agents.json 合併
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
