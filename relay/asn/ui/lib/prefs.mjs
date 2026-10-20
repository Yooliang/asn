// 視窗外框與音效兩個設定的純邏輯（介面與測試共用，不碰 DOM、不碰 Tauri）。

// 視窗外框：custom＝ASN 自己畫的 Aero 風標題列與邊框（預設，不用 Windows 原生外框）；native＝Windows 原生外框
export const FRAMES = ['custom', 'native']
export const FRAME_LABEL = { custom: '自訂（Aero 風）', native: 'Windows 原生' }
// 讀回存檔：只有明確寫 native 才算原生；沒有這個欄位的舊存檔、壞值一律是自訂
export const normalizeFrame = v => (v === 'native' ? 'native' : 'custom')
export const isNativeFrame = v => normalizeFrame(v) === 'native'

// 音效：存檔裡是布林 sound（舊版就是這樣存的，不改格式）；下拉選單用 on／off 兩個值
export const SOUND_CHOICES = ['on', 'off']
export const SOUND_LABEL = { on: '開', off: '關' }
// 舊存檔沒有這個欄位＝開；只有明確 false 才是關
export const soundFromSaved = v => v !== false
export const soundChoice = on => (on ? 'on' : 'off')
export const soundFromChoice = v => v !== 'off'
