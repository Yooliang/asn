// 版本紀錄（資料庫的 asn_site_releases，官網的藍圖與開發日誌讀同一份）：整理成設定「更新」要顯示的條目。電腦版與手機版共用，node 與瀏覽器都能跑。
// 讀取走 Rust 的 site_releases 指令（介面的內容安全政策不放行 fetch）；網址、金鑰、欄位都在 Rust 端固定，這裡不傳任何參數（只有「重試」帶 force）。
// 給人看的文字純繁體中文；內容一律只用文字插值，不當 HTML。
import { compareVersions } from './update.mjs'

export const UNREADABLE_TEXT = '暫時讀不到版本紀錄'
export const LOADING_TEXT = '讀取版本紀錄…'
export const EMPTY_TEXT = '還沒有版本紀錄。'
export const RETRY_LABEL = '重試'

const VERSION_RE = /^\d+\.\d+\.\d+$/

// 後端整理過的列 [{ version, date, lines }] → 新到舊的條目；格式不對的列略過（不信任資料）
export function sortReleases(rows) {
  const out = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.version !== 'string' || !VERSION_RE.test(r.version)) continue
    const lines = Array.isArray(r.lines) ? r.lines.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim()) : []
    out.push({ version: r.version, date: typeof r.date === 'string' ? r.date : '', lines })
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

export const initialReleases = () => ({ phase: 'idle', entries: [], text: '' })

// 讀一次：成功 → { phase: 'ok', entries }；任何失敗 → { phase: 'error', text: UNREADABLE_TEXT }（細節只在 Rust 的 log，不給畫面）
export async function loadReleases(read, { force = false } = {}) {
  if (typeof read !== 'function') return { phase: 'error', entries: [], text: UNREADABLE_TEXT }
  try {
    return { phase: 'ok', entries: sortReleases(await read(force)), text: '' }
  } catch {
    return { phase: 'error', entries: [], text: UNREADABLE_TEXT }
  }
}

// 畫面上這一塊要顯示的一句話（讀取中、讀不到、沒有資料；有資料回空字串）
export const releasesNote = rel =>
  rel?.phase === 'error' ? (rel.text || UNREADABLE_TEXT)
    : rel?.phase === 'loading' ? LOADING_TEXT
      : rel?.phase === 'ok' && !(rel.entries?.length) ? EMPTY_TEXT
        : ''
