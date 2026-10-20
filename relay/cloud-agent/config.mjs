// 雲端代理收發室工具的共用設定：路徑、節點代號、金鑰讀取。全部可用環境變數改（測試就是靠這個指到暫存資料夾）。
//   IRORI_CLOUD_HOME      根目錄（預設 /workspace，重置後保留的那個）
//   IRORI_CLOUD_KEY_DIR   金鑰檔目錄（預設 <根>/.irori-relay；只是備援，主要身分來源是環境變數 IRORI_RELAY_KEY）
//   IRORI_CLOUD_MAIL_DIR  信件目錄（預設 <根>/relay）：inbox.jsonl、done.jsonl、recv.log、recv.pid
//   IRORI_RELAY_ID        節點代號（預設 grok）
//   IRORI_RELAY_URL       仲介網址（預設正式；測試指到 127.0.0.1）
//   IRORI_RELAY_KEY       節點金鑰（優先於金鑰檔）；IRORI_RELAY_ANON_KEY／<金鑰目錄>/anon.key：Realtime 門鈴用的公開 anon 金鑰（沒有＝只輪詢）
//   IRORI_CLOUD_ROSTER_NAME（預設 Grok）／IRORI_CLOUD_ROSTER_LABEL（預設 grok-cloud）／IRORI_CLOUD_ENGINE（預設 grok）
//   名單有好幾個代理時（一台雲端環境裡住了好幾位）：<信件目錄>/agents.json（優先，每次回報都重讀，可隨時改）
//     [{"name":"小真"},{"name":"正見","engine":"grok","cwd_label":"policy","status":"busy"}]
//   或環境變數 IRORI_CLOUD_AGENTS="Grok,小真,正見"（逗號分隔）。都沒有＝只有 IRORI_CLOUD_ROSTER_NAME 一位
//   自動掃描（Grok 雲端預設開）：grok-agents.mjs 讀 Grok 夥伴 profile ＋ claude agents --json；IRORI_CLOUD_ROSTER_AUTO=0 關閉，只用 agents.json／IRORI_CLOUD_AGENTS
//   GROK_AGENTS_DIR（預設 /home/box/agent-data/agents）、IRORI_CLAUDE_BIN（預設 /home/box/.local/bin/claude）
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
  const rosterAuto = (env.IRORI_CLOUD_ROSTER_AUTO ?? '1') !== '0'
  return {
    root, keyDir, mailDir, node, name,
    grokAgentsDir, claudeBin, rosterAuto,
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
    // resolveConfig 當下用的 env 快照（測試合併暫存變數時，roster 掃描不會漏回 process.env 的真實路徑）
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
    IRORI_CLOUD_ROSTER_AUTO: cfg.rosterAuto ? '1' : '0',
  }
}

// 金鑰：有 IRORI_RELAY_KEY 就只用它、完全不讀檔；沒有才讀金鑰檔。找不到回空字串。呼叫端絕不可印出回傳值（連片段都不行）。
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

// 這台雲端環境要回報的代理名單：agents.json → IRORI_CLOUD_AGENTS → 只有預設那位。名字去頭尾空白、去重、最多 30 位、每個最多 100 字；
// 結尾是「收發室」的不收（ASN 不列收發室）。status 只收 idle／busy／waiting，其餘當 idle。
const STATUSES = new Set(['idle', 'busy', 'waiting'])
export function loadAgents(cfg) {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(cfg.agentsFile, 'utf8')) } catch {}
  if (!Array.isArray(raw)) raw = cfg.agentsEnv ? cfg.agentsEnv.split(',').map(name => ({ name })) : []
  const out = [], seen = new Set()
  for (const a of raw) {
    const name = String((typeof a === 'string' ? a : a?.name) ?? '').trim().slice(0, 100)
    if (!name || seen.has(name) || /收發室$/.test(name)) continue
    seen.add(name)
    out.push({
      name,
      status: STATUSES.has(a?.status) ? a.status : 'idle',
      engine: String(a?.engine ?? cfg.engine).trim().slice(0, 20) || cfg.engine,
      cwd_label: String(a?.cwd_label ?? cfg.cwdLabel).trim().slice(0, 100),
    })
    if (out.length >= 30) break
  }
  return out.length ? out : [{ name: cfg.name, status: 'idle', engine: cfg.engine, cwd_label: cfg.cwdLabel }]
}

// roster 回報用名單：先試本機掃描（Grok 夥伴＋ Claude 視窗），沒有結果再 loadAgents（手動 agents.json 等）
export async function rosterAgentsForReport(cfg, env = rosterScanEnvFrom(cfg), listAllFn) {
  if (cfg.rosterAuto) {
    let raw = []
    try {
      const listAll = listAllFn ?? (await import('./grok-agents.mjs')).listAll
      raw = listAll(env)
    } catch {}
    const agents = (Array.isArray(raw) ? raw : []).map(({ name, status, engine, cwd_label }) => ({
      name: String(name).trim(),
      status: STATUSES.has(status) ? status : 'idle',
      engine: String(engine ?? cfg.engine).trim().slice(0, 20) || cfg.engine,
      cwd_label: String(cwd_label ?? cfg.cwdLabel).trim().slice(0, 100) || cfg.cwdLabel,
    })).filter(a => a.name && !/收發室$/.test(a.name))
    if (agents.length) return agents.slice(0, 30)
  }
  return loadAgents(cfg)
}
