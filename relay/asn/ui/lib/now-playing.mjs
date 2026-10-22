// 「顯示正在聽的歌」的純邏輯（開關預設關；實際讀系統媒體與組字串在 Rust 端 nowplaying.rs，這裡只管存檔值與顯示字）。
export const NOW_PLAYING_PREFIX = '♪ 正在聽：'

// 存檔值：只有明確存了 true 才開；沒這個欄位的舊存檔、壞值一律是關（隱私預設）
export const normalizeNowPlaying = v => v === true

// 自己名單頭的那一行：沒在聽就是空字串（不顯示）
export const nowPlayingLine = text => {
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim()
  return s ? NOW_PLAYING_PREFIX + s : ''
}
