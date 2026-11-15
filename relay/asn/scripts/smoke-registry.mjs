// 冒煙探測登記表（#1540）：scripts/smoke-probes/ 底下每個 .mjs 是一個探測，載入時自動收集。
// 新增一種探測只要加一個檔，不用改 smoke-lib 的分派、也不用改 smoke-ui.test 的遮罩條件。
//
// 每個探測檔 export default {
//   key,          // 情境 probe 上的鍵名，例如 'devSel'；情境寫 probe: { devSel: true } 就會用這個探測
//   has?,         // 選填：probe => 布林，判斷這個情境歸不歸這個探測（預設：probe[key] 為真）
//   kind,         // 失敗訊息裡的中文名稱，字串或 probe => 字串
//   source,       // probe => 注入頁面的判斷式原始碼（回傳 { ok, why }）
//   scenarios?,   // 選填：這個探測自己的情境，接在 smoke-lib 的 SCENARIOS 後面
//   table?,       // 選填：(scenario, table) => 要蓋到假後台表的欄位（物件）；沒有就回傳 undefined
// }
// 一個情境只能對到一個探測（測試會檢查），所以檔名順序不影響結果。
// 探測檔不要 import smoke-lib.mjs（smoke-lib 載入時會 await 這裡，互相等待會卡住）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PROBE_DIR = fileURLToPath(new URL('./smoke-probes/', import.meta.url))

export const probeHas = (entry, probe) => !!probe && (entry.has ? !!entry.has(probe) : !!probe[entry.key])

export const findProbe = (entries, probe) => entries.find(e => probeHas(e, probe))

export const validateProbe = (entry, file) => {
  const bad = why => new Error(`冒煙探測 ${file}：${why}`)
  if (!entry || typeof entry !== 'object') throw bad('要 export default 一個物件')
  if (typeof entry.key !== 'string' || !entry.key) throw bad('缺 key')
  if (typeof entry.kind !== 'string' && typeof entry.kind !== 'function') throw bad('kind 要是字串或函式')
  if (typeof entry.source !== 'function') throw bad('source 要是函式')
  if (entry.has !== undefined && typeof entry.has !== 'function') throw bad('has 要是函式')
  if (entry.table !== undefined && typeof entry.table !== 'function') throw bad('table 要是函式')
  if (entry.scenarios !== undefined && !Array.isArray(entry.scenarios)) throw bad('scenarios 要是陣列')
  return entry
}

// smoke-lib 用：探測檔自帶的情境接在原本的表後面；假後台表套上探測檔給的欄位（回傳新物件，不改傳進來的表）
export const withProbeScenarios = (base, entries) => Object.freeze([...base, ...entries.flatMap(e => e.scenarios ?? [])])
export const withProbeTables = (table, scenario, entries) => entries.reduce((t, e) => { const patch = e.table?.(scenario, t); return patch ? { ...t, ...patch } : t }, table)

export const probeFiles = (dir = PROBE_DIR) => fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()

export async function loadProbes(dir = PROBE_DIR) {
  const entries = []
  for (const f of probeFiles(dir)) entries.push(validateProbe((await import(pathToFileURL(path.join(dir, f)).href)).default, f))
  const seen = new Map()
  for (const [i, e] of entries.entries()) {
    if (seen.has(e.key)) throw new Error(`冒煙探測 key 重複：${e.key}（${seen.get(e.key)}、${probeFiles(dir)[i]}）`)
    seen.set(e.key, probeFiles(dir)[i])
  }
  return Object.freeze(entries)
}
