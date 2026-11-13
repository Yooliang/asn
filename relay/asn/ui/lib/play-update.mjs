// 手機（Play 安裝）的新版提示：版本紀錄裡「Play 上已經有」的最新版本，比自己新才算有新版。
// 官網先發、Play 還沒上的版本不算；資料讀不到、空、沒有任何一版標 Play → 一律當沒新版（不亮、不報錯）。純邏輯，node 與瀏覽器都能跑。
import { compareVersions } from './update.mjs'

export const PLAY_PLATFORM = 'Play'
export const PLAY_PACKAGE = 'tw.yooliang.asn'
export const PLAY_WEB_URL = `https://play.google.com/store/apps/details?id=${PLAY_PACKAGE}`
export const PLAY_BUTTON_LABEL = '到 Play 商店更新'
export const PLAY_LATEST_TEXT = '已是最新版本'
export const PLAY_NOTICE_NOT_AUTO = '這個版本不提供自動檢查新版本。'
export const playNewText = v => `有新版本 ${v}`

// rel＝{ phase, entries }（releases.mjs 的 loadReleases 結果，entries 的每筆帶 platforms 字串陣列）→ Play 上最新的版本字串，沒有回 ''
export function latestPlayVersion(entries) {
  let best = ''
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.version !== 'string' || !Array.isArray(e.platforms) || !e.platforms.includes(PLAY_PLATFORM)) continue
    if (compareVersions(e.version, '0.0.0') === null) continue
    if (!best || compareVersions(e.version, best) === 1) best = e.version
  }
  return best
}

// 有新版 → 回該版本字串；沒有（含讀不到、格式不對）回 ''
export function playUpdateVersion(rel, current) {
  if (rel?.phase !== 'ok') return ''
  const v = latestPlayVersion(rel.entries)
  return v && compareVersions(v, current) === 1 ? v : ''
}

// 更新頁（原本寫「不提供自動檢查」的那種）的狀態：{ kind: 'new', version } | { kind: 'latest' } | { kind: 'unknown' }（讀不到／沒有 Play 版本：維持原句）
export function playUpdateView(rel, current) {
  if (rel?.phase !== 'ok') return { kind: 'unknown' }
  const nv = playUpdateVersion(rel, current)
  if (nv) return { kind: 'new', version: nv }
  return latestPlayVersion(rel.entries) ? { kind: 'latest' } : { kind: 'unknown' }
}

// 開 Play 商店：直接開 https 網址（Android 會用 Play App 開）。open＝(url) => Promise；失敗回 false
export async function openPlayStore(open) {
  try { await open(PLAY_WEB_URL); return true } catch { return false }
}
