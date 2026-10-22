// 視窗外框與音效兩個設定的純邏輯（介面與測試共用，不碰 DOM、不碰 Tauri）。
import { withoutAsn } from './roster.mjs'

// 視窗外框：custom＝ASN 自己畫的 Aero 風標題列與邊框（預設，不用 Windows 原生外框）；native＝Windows 原生外框
export const FRAMES = ['custom', 'native']
export const FRAME_LABEL = { custom: '自訂（Aero 風）', native: 'Windows 原生' }
// 讀回存檔：只有明確寫 native 才算原生；沒有這個欄位的舊存檔、壞值一律是自訂
export const normalizeFrame = v => (v === 'native' ? 'native' : 'custom')
export const isNativeFrame = v => normalizeFrame(v) === 'native'

// 通知（原「音效」）：四個獨立開關，存檔欄位 notify＝{ toast, msg, nudge, file }。
// 預設全開（維持原行為）。舊存檔只有布林 sound：false＝三個聲音都關（右下角通知原本不受影響，維持開）；沒寫或 true＝全開。
export const NOTIFY_ITEMS = [
  { key: 'toast', label: '右下角通知' },
  { key: 'msg', label: '通知聲音' },
  { key: 'nudge', label: '震動聲音' },
  { key: 'file', label: '收到檔案聲音' },
]
export const NOTIFY_KEYS = NOTIFY_ITEMS.map(i => i.key)
export function notifyFromSaved(saved) {
  const s = saved && typeof saved === 'object' ? saved : {}
  const legacy = s.sound !== false
  const n = s.notify && typeof s.notify === 'object' && !Array.isArray(s.notify) ? s.notify : null
  const out = {}
  for (const k of NOTIFY_KEYS) out[k] = n && typeof n[k] === 'boolean' ? n[k] : (k === 'toast' ? true : legacy)
  return out
}
export const notifyWith = (prefs, key, on) => (NOTIFY_KEYS.includes(key) ? { ...prefs, [key]: on === true } : prefs)
export const notifySummary = p => {
  const on = NOTIFY_ITEMS.filter(i => p?.[i.key]).map(i => i.label)
  return on.length ? on.join('、') : '全部關閉'
}
// 一則提示該做什麼：n＝core 發出的 notify（kind、sound、toast、hasFile）。忙碌中不出聲（原行為）。
// 帶檔案的信用「收到檔案聲音」取代一般通知聲音；登入提示音歸「通知聲音」。
export function notifyPlan(n, prefs, status) {
  const key = n?.sound === 'nudge' ? 'nudge' : (n?.hasFile ? 'file' : 'msg')
  const sound = n?.sound && status !== 'busy' && prefs?.[key] ? (key === 'file' ? 'file' : n.sound) : null
  return { sound, toast: Boolean(n?.toast) && prefs?.toast !== false }
}

// 關閉視窗時：tray＝縮到系統匣（預設，程式與收信照常）／quit＝結束程式；存在 asn-me.json 的 closeTo，Rust 開機時讀同一份
export const CLOSE_CHOICES = ['tray', 'quit']
export const CLOSE_LABEL = { tray: '縮到系統匣', quit: '結束程式' }
// 讀回存檔：只有明確寫 quit 才結束；沒有這個欄位的舊存檔、壞值一律縮到系統匣
export const normalizeClose = v => (v === 'quit' ? 'quit' : 'tray')

// 系統匣圖示上的未讀總數：只算正整數，其餘（壞值、負數、小數）當 0
export const totalUnread = friends => withoutAsn(friends).reduce((n, f) => n + (Number.isInteger(f?.unread) && f.unread > 0 ? f.unread : 0), 0)
