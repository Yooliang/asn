// 雲端代理收發室工具的共用設定：路徑、節點代號、金鑰讀取。全部可用環境變數改（測試就是靠這個指到暫存資料夾）。
//   IRORI_CLOUD_HOME      根目錄（預設 /workspace，重置後保留的那個）
//   IRORI_CLOUD_KEY_DIR   金鑰檔目錄（預設 <根>/.irori-relay；只是備援，主要身分來源是環境變數 IRORI_RELAY_KEY）
//   IRORI_CLOUD_MAIL_DIR  信件目錄（預設 <根>/relay）：inbox.jsonl、done.jsonl、recv.log、recv.pid
//   IRORI_RELAY_ID        節點代號（預設 grok）
//   IRORI_RELAY_URL       仲介網址（預設正式；測試指到 127.0.0.1）
//   IRORI_RELAY_KEY       節點金鑰（優先於金鑰檔）；IRORI_RELAY_ANON_KEY／<金鑰目錄>/anon.key：Realtime 門鈴用的公開 anon 金鑰（沒有＝只輪詢）
//   IRORI_CLOUD_ROSTER_NAME（預設 Grok）／IRORI_CLOUD_ROSTER_LABEL（預設 grok-cloud）／IRORI_CLOUD_ENGINE（預設 grok）
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
  return {
    root, keyDir, mailDir, node, name,
    baseUrl: (env.IRORI_RELAY_URL || DEFAULT_URL).replace(/\/+$/, ''),
    keyFile: path.join(keyDir, `${node}.key`),
    inboxFile: path.join(mailDir, 'inbox.jsonl'),
    doneFile: path.join(mailDir, 'done.jsonl'),
    logFile: path.join(mailDir, 'recv.log'),
    pidFile: path.join(mailDir, 'recv.pid'),
    cwdLabel: (env.IRORI_CLOUD_ROSTER_LABEL || 'grok-cloud').trim(),
    engine: (env.IRORI_CLOUD_ENGINE || 'grok').trim(),
    pollMs: Number(env.IRORI_RECV_POLL_MS || 120_000),
    rosterMs: Number(env.IRORI_ROSTER_MS || 60_000),
    rosterRetryAfter403Ms: Number(env.IRORI_ROSTER_403_RETRY_MS || 3_600_000),
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
