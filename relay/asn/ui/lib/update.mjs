// 自動更新的純邏輯（介面、發版腳本與測試共用，不碰 DOM、不碰 Tauri）。

// 啟動時檢查一次，之後每 6 小時一次
export const CHECK_MS = 6 * 60 * 60 * 1000

// 版本號比較：只認 x.y.z 三段數字（可帶 v 開頭）；格式不對回 null。回 1／0／-1
export const parseVersion = v => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
export const compareVersions = (a, b) => {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}
export const isNewer = (remote, current) => compareVersions(remote, current) === 1

// 設定頁「自動檢查更新」：預設開；只有存檔明確寫 false 才是關（舊存檔沒有這個欄位＝開）
export const autoCheckFromSaved = v => v !== false

// 說明只取第一個非空行，並限制長度（通知列只有一行）
export const firstLine = (notes, max = 60) => {
  const line = String(notes ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// 名單上方通知列的文字：「有新版本 x.y.z：<說明第一行>」；沒有說明就不加冒號
export const updateNoticeText = info => {
  if (!info?.version) return ''
  const line = firstLine(info.notes)
  return line ? `有新版本 ${info.version}：${line}` : `有新版本 ${info.version}`
}

// 下載進度：total 不明時只顯示已下載的 MB；百分比最多 100
export const progressText = (done, total) => {
  const mb = n => (n / 1048576).toFixed(1)
  if (!Number.isFinite(done) || done < 0) return '下載中…'
  if (Number.isFinite(total) && total > 0) return `下載中 ${Math.min(100, Math.floor((done / total) * 100))}%（${mb(done)} / ${mb(total)} MB）`
  return `下載中 ${mb(done)} MB`
}

// 通知列的狀態機：idle（沒新版）／available（有新版，等按更新）／installing（下載與安裝中）／failed（失敗，顯示原因，可再按更新重試）
export const initialUpdateState = () => ({ phase: 'idle', info: null, done: 0, total: null, error: '' })
export const withAvailable = (st, info) => (st.phase === 'installing' ? st : info ? { phase: 'available', info, done: 0, total: null, error: '' } : initialUpdateState())
export const withInstalling = st => (st.info ? { ...st, phase: 'installing', done: 0, total: null, error: '' } : st)
export const withProgress = (st, p) => (st.phase === 'installing' ? { ...st, done: Number(p?.done) || 0, total: Number.isFinite(p?.total) ? p.total : null } : st)
export const withFailure = (st, message) => ({ ...st, phase: 'failed', error: String(message || '更新失敗') })

// 手動「立即檢查」後設定頁顯示的結果
export const manualResultText = (info, current) => (info ? `有新版本 ${info.version}（目前 ${current}），請按名單上方的「更新」。` : `目前已是最新版（${current}）。`)

// 最後檢查時間：今天只顯示「今天 時:分」，其他天顯示「月/日 時:分」；沒檢查過回空字串
export const formatCheckTime = (ms, now = Date.now()) => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms), p = x => String(x).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// 設定「更新」頁卡片右邊的狀態：tone（顏色）＋標題＋兩行小字（目前版本、最後檢查）。
// 參數：{ checking, installing, phase, info, lastCheck, error, current }
export const updateStatus = ({ checking, installing, phase, info, lastCheck, error, current } = {}, now = Date.now()) => {
  const when = formatCheckTime(lastCheck, now)
  const lines = [`目前版本 ${current ?? ''}`.trim(), when ? `最後檢查：${when}` : '尚未檢查過']
  if (checking) return { tone: 'busy', head: '檢查中…', lines }
  if (installing || phase === 'installing') return { tone: 'busy', head: '下載安裝中…', lines }
  if (error) return { tone: 'err', head: `檢查失敗：${error}`, lines }
  if (phase === 'available' && info?.version) return { tone: 'new', head: `有新版 ${info.version}，請按名單上方的「更新」`, lines }
  if (phase === 'failed') return { tone: 'err', head: '上次更新失敗，可按名單上方的「更新」重試', lines }
  return lastCheck ? { tone: 'ok', head: '已是最新版', lines } : { tone: 'idle', head: '按「立即檢查」看有沒有新版', lines }
}
