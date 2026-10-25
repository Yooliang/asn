// pi 擴充第三期：遠端控制（目前只有 set_model＝切換模型）的純邏輯（檔案層，不 import pi，方便 node --test）。
//
// 為什麼不用 pi 的 RPC：ASN 開的 pi 是互動視窗加這個擴充，不是 `pi --mode rpc` 程序，沒有 RPC 通道可以送指令。
// 擴充 API 有 pi.setModel(model)（回傳 Promise<boolean>），所以仿照收信，用檔案當管道：
//
// 檔案約定（與 Rust 橋 relay/asn/src-tauri/src/bridge/engines/pi.rs 一致）：
//   ~/.asn/pi-control/<sessionId>/<請求編號>.json          請求（橋寫、擴充讀）{ v:1, id, op:'set_model', provider?, model, at }
//   ~/.asn/pi-control/<sessionId>/<請求編號>.result.json   結果（擴充寫、橋讀）{ v:1, id, ok, model?, provider?, error?, at }
// 一個請求只處理一次：結果檔存在就不再處理（重開 pi 也有效）。
import fs from 'node:fs'
import path from 'node:path'
import { validSessionId } from './inbox.mjs'

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
// 模型代號與提供者：pi 的模型 id 只會有英數與 . _ : @ -（例如 claude-opus-4-8、gpt-5.6-sol、MiniMax-M3.1-Flash）
export const MODEL_RE = /^[A-Za-z0-9._:@-]{1,100}$/
export const PROVIDER_RE = /^[A-Za-z0-9._-]{1,50}$/
export const OPS = ['set_model']
const RESULT_SUFFIX = '.result.json'

/** 讀一個請求檔；不合格（壞 JSON、檔名與 id 不符、不認得的動作、模型代號不合法）回 null */
export function parseRequest(file, id) {
  try {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!e || e.id !== id || e.v !== 1 || !OPS.includes(e.op)) return null
    if (typeof e.model !== 'string' || !MODEL_RE.test(e.model)) return null
    if (e.provider != null && (typeof e.provider !== 'string' || !PROVIDER_RE.test(e.provider))) return null
    return { id, op: e.op, model: e.model, provider: e.provider ?? null, at: Number.isFinite(e.at) ? e.at : 0 }
  } catch {
    return null
  }
}

/** 取下一批還沒處理的請求（依 at 排序、最多 limit 筆）。已有結果檔、記憶體裡處理過的、壞檔都略過 */
export function nextRequests(controlDir, sessionId, seen, limit = 3) {
  if (!validSessionId(sessionId)) return []
  const dir = path.join(controlDir, sessionId)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json') || n.endsWith(RESULT_SUFFIX)) continue
    const id = n.slice(0, -5)
    if (!ID_RE.test(id) || seen.has(id)) continue
    if (fs.existsSync(path.join(dir, `${id}${RESULT_SUFFIX}`))) continue
    const e = parseRequest(path.join(dir, n), id)
    if (e) out.push(e)
  }
  out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  const batch = out.slice(0, limit)
  for (const e of batch) seen.add(e.id)
  return batch
}

/** 寫結果（原子寫入：先寫暫存檔再改名，橋不會讀到半份） */
export function writeResult(controlDir, sessionId, id, result, now = Date.now()) {
  if (!validSessionId(sessionId) || !ID_RE.test(id)) return false
  const dir = path.join(controlDir, sessionId)
  const rec = { v: 1, id, ok: result?.ok === true, at: now }
  if (result?.model) rec.model = String(result.model).slice(0, 100)
  if (result?.provider) rec.provider = String(result.provider).slice(0, 50)
  if (result?.error) rec.error = String(result.error).slice(0, 40)
  if (Array.isArray(result?.providers)) rec.providers = result.providers.slice(0, 20).map(p => String(p).slice(0, 50))
  try {
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `${id}${RESULT_SUFFIX}`)
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(rec))
    fs.renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

/**
 * 在模型清單裡挑出要切換的那一個。
 * available＝已設定金鑰、現在能用的模型；all＝pi 認得的全部模型（用來分辨「沒有這個模型」和「有但沒金鑰」）。
 * 給了 provider 就精確比對；沒給就用模型代號找，剛好一個才算數，多個提供者都有就回 ambiguous（附提供者清單）。
 * 回 { model } 或 { error: 'not_found' | 'no_api_key' | 'ambiguous', providers? }
 */
export function pickModel({ available = [], all = [] }, provider, modelId) {
  const same = m => m && m.id === modelId && (!provider || m.provider === provider)
  const usable = available.filter(same)
  if (usable.length === 1) return { model: usable[0] }
  if (usable.length > 1) return { error: 'ambiguous', providers: [...new Set(usable.map(m => m.provider))] }
  if (all.some(same)) return { error: 'no_api_key' }
  return { error: 'not_found' }
}

/** 清掉太舊的請求與結果（避免資料夾一直長大） */
export function pruneControl(controlDir, sessionId, now, maxAgeMs) {
  if (!validSessionId(sessionId)) return
  const dir = path.join(controlDir, sessionId)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {}
  for (const n of names) {
    try {
      const f = path.join(dir, n)
      if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f)
    } catch {}
  }
}
