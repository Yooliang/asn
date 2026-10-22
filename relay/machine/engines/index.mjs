// 轉接器登記處：ASN_ENGINES（舊名 IRORI_ENGINES；逗號分隔，預設 claude）決定橋載入哪些引擎。
// 內建名稱 → 同資料夾的轉接器；其他值當成模組檔路徑（只給測試／試驗用，例如假引擎）。
// 每個轉接器模組輸出 createEngine(ctx) → engine（介面見 relay/machine/README.md「轉接器介面」）。
import { envGet } from '../env-compat.mjs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BUILTIN = { claude: './claude.mjs', codex: './codex.mjs', acp: './acp.mjs' }
export const REQUIRED_METHODS = ['capabilities', 'start', 'stop', 'listWindows', 'listNames', 'activityOf', 'deliver']

export function validateEngine(e) {
  if (!e || typeof e.id !== 'string' || !e.id) throw new Error('engine 缺 id')
  for (const m of REQUIRED_METHODS) if (typeof e[m] !== 'function') throw new Error(`engine ${e.id} 缺方法 ${m}`)
  return e
}

export async function loadEngines(ctx, spec = envGet(process.env, 'ENGINES') || 'claude') {
  const out = []
  for (const raw of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const target = BUILTIN[raw] ? new URL(BUILTIN[raw], import.meta.url).href : pathToFileURL(path.resolve(raw)).href
    const mod = await import(target)
    if (typeof mod.createEngine !== 'function') throw new Error(`轉接器 ${raw} 沒有輸出 createEngine`)
    out.push(validateEngine(mod.createEngine(ctx)))
  }
  if (!out.length) throw new Error('ASN_ENGINES 是空的')
  return out
}
