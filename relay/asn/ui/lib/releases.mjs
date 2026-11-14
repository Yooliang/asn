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
    const e = { version: r.version, date: typeof r.date === 'string' ? r.date : '', lines }
    if (Array.isArray(r.platforms)) e.platforms = r.platforms.filter(p => typeof p === 'string')   // 發佈平台（官網、Play…）：手機的新版提示用，電腦版不顯示；沒這欄就不帶
    out.push(e)
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

// ---- 重讀時機（#1501）：手機（Play 版）的紅點全靠這份清單，只在啟動讀一次會讓「一直開著的 App」永遠看不到新版 ----
export const RELEASES_MAX_AGE_MS = 30 * 60_000   // 讀成功的資料超過 30 分鐘就算過期
export const RELEASES_COOLOFF_MS = 30_000        // 剛失敗過不連著再讀（切分頁、切前景都會觸發檢查）
export const RELEASES_RETRY_MS = [30_000, 120_000, 300_000, 900_000]   // 讀失敗的背景重試：30 秒、2 分、5 分、15 分，之後每 30 分
export const RELEASES_RETRY_TAIL_MS = 30 * 60_000

// 第 n 次失敗後（n ≥ 1）隔多久再試；n 小於 1 當 1
export const retryDelayMs = failCount => {
  const n = Math.max(1, Math.floor(Number(failCount)) || 1)
  return RELEASES_RETRY_MS[n - 1] ?? RELEASES_RETRY_TAIL_MS
}

// 現在該不該重讀：讀取中不讀；還沒讀過、讀失敗要讀（剛失敗的 30 秒內先不連讀）；讀成功的過了 maxAgeMs 才讀
export function releasesStale(rel, nowMs, maxAgeMs = RELEASES_MAX_AGE_MS) {
  const phase = rel?.phase
  if (phase === 'loading') return false
  if (phase !== 'ok' && phase !== 'idle' && phase !== 'error') return false
  if (rel.failedAt > 0 && nowMs - rel.failedAt < RELEASES_COOLOFF_MS) return false
  if (phase === 'ok') return !(rel.loadedAt > 0) || nowMs - rel.loadedAt >= maxAgeMs
  return true
}

// 讀完一次，把結果跟時間戳合併成新的 rel（不改傳入的物件）：
// 成功 → 記 loadedAt、清失敗紀錄；失敗 → 記 failedAt、失敗次數加一；已經有舊資料時失敗不把舊資料丟掉（紅點照舊，只是下次再試）
export function stampReleases(prev, result, nowMs) {
  const before = prev ?? initialReleases()
  if (result?.phase === 'ok') return { ...result, loadedAt: nowMs, failedAt: 0, failCount: 0 }
  const failCount = (before.failCount || 0) + 1
  const kept = before.phase === 'ok' || (before.entries?.length > 0 && before.loadedAt > 0)
  return kept
    ? { ...before, phase: 'ok', failedAt: nowMs, failCount }
    : { ...(result ?? {}), phase: 'error', entries: [], loadedAt: 0, failedAt: nowMs, failCount }
}

// 重讀的調度（純邏輯，計時器與時鐘都從外面傳入，測試用假的）。
// load＝讀一次並更新 rel 的函式（要自己擋重複讀）；getRel＝取目前 rel；isForeground／enabled＝App 在前景／這個版本需要自動重讀
// check()：過期就讀；onForeground(fg)：回前景時 check（並把退避計時重新掛上），進背景時停計時；stop()：清計時器
export function createReleasesRefresher({ getRel, load, now = () => Date.now(), isForeground = () => true, enabled = () => true, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null
  const clear = () => { if (timer !== null) { clearTimer(timer); timer = null } }
  const schedule = ms => {
    clear()
    timer = setTimer(() => { timer = null; if (enabled() && isForeground()) void run() }, ms)   // 在背景不試：回前景時 onForeground 會補上
  }
  const settle = () => {
    const rel = getRel()
    if (rel?.failCount > 0) schedule(retryDelayMs(rel.failCount))
    else clear()
  }
  async function run() {
    clear()
    await load()
    settle()
  }
  const check = () => {
    if (!enabled() || !releasesStale(getRel(), now())) return false
    void run()
    return true
  }
  const onForeground = fg => {
    if (fg !== true) { clear(); return false }
    if (check()) return true
    if (enabled() && timer === null && getRel()?.failCount > 0 && getRel()?.phase !== 'loading') schedule(retryDelayMs(getRel().failCount))
    return false
  }
  return { check, onForeground, run, stop: clear, pending: () => timer !== null }
}
