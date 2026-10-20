// 念出訊息的播放器（不碰瀏覽器與 Tauri：取音檔與播放都由外面注入，好測）。
//   fetchAudio(text) → Promise<{ mime, audio（base64） }>（金鑰與 HTTP 都在 Rust 端）
//   createAudio(b64, mime) → { play(): Promise<void>, stop(), onended: fn 可設 }
// 同一時間只播一則；再按同一則＝停止；按另一則＝換過去。自動念的信排隊（最多 3 則，超過丟掉最舊的）。
import { EMO } from './text.mjs'

export const SPEAK_MAX = 900   // 一次最多念這麼多字（後台上限 1000）

const EMO_CODES = EMO.map(([k]) => k)

/** 訊息內文 → 適合念的文字：拿掉程式碼區塊、網址、表情代碼與排版符號，太長就在句子邊界截斷 */
export function speakableText(raw, max = SPEAK_MAX) {
  let s = String(raw ?? '')
  s = s.replace(/```[\s\S]*?```/g, ' ')                 // 程式碼區塊念出來沒意義
  s = s.replace(/https?:\/\/\S+/g, ' ')                 // 網址
  for (const c of EMO_CODES) s = s.split(c).join(' ')   // :) (L) 這類舊式表情代碼
  s = s.replace(/[`*_~#>|]+/g, ' ').replace(/^\s*[-+]\s+/gm, '')
  s = s.replace(/\s+/g, ' ').trim()
  const chars = [...s]
  if (chars.length <= max) return s
  const cut = chars.slice(0, max).join('')
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('. '), cut.lastIndexOf('\n'))
  return (at > max * 0.5 ? cut.slice(0, at + 1) : cut).trim()
}

export class TtsPlayer {
  constructor({ fetchAudio, createAudio, onChange = () => {} }) {
    Object.assign(this, { fetchAudio, createAudio, onChange })
    this.key = ''          // 正在處理（取音檔或播放）的是哪一則
    this.phase = 'idle'    // idle | loading | playing
    this.error = ''
    this.audio = null
    this.queue = []
    this.gen = 0
  }

  #set(key, phase, error = '') { this.key = key; this.phase = phase; this.error = error; this.onChange(this) }

  /** 按鈕：同一則正在處理就停止，否則（停掉別的）播這一則 */
  async toggle(key, text) {
    if (this.phase !== 'idle' && this.key === key) { this.stop(); return }
    this.queue = []
    await this.play(key, text)
  }

  async play(key, raw) {
    this.#halt()
    const text = speakableText(raw)
    if (!text) { this.#set('', 'idle', '這則訊息沒有可以念的文字。'); return false }
    const gen = ++this.gen
    this.#set(key, 'loading')
    let res
    try { res = await this.fetchAudio(text) }
    catch (e) { if (gen === this.gen) this.#set('', 'idle', e?.message || '念出訊息失敗。'); return false }
    if (gen !== this.gen) return false
    let audio
    try { audio = this.createAudio(res.audio, res.mime) } catch { this.#set('', 'idle', '無法播放聲音。'); return false }
    this.audio = audio
    audio.onended = () => { if (gen === this.gen) this.#finish() }
    try { await audio.play() } catch { if (gen === this.gen) { this.#halt(); this.#set('', 'idle', '無法播放聲音。') } return false }
    if (gen === this.gen) this.#set(key, 'playing')
    return true
  }

  /** 自動念：忙碌中就排隊（最多 3 則，滿了丟最舊的） */
  enqueue(key, text) {
    if (this.phase === 'idle') { void this.play(key, text); return }
    this.queue.push({ key, text })
    while (this.queue.length > 3) this.queue.shift()
  }

  stop() { this.queue = []; this.#halt(); this.gen++; this.#set('', 'idle') }

  #halt() { const a = this.audio; this.audio = null; if (a) { a.onended = null; try { a.stop() } catch { /* 已停 */ } } }

  #finish() {
    this.#halt()
    const next = this.queue.shift()
    this.#set('', 'idle')
    if (next) void this.play(next.key, next.text)
  }
}

/** 瀏覽器版的音檔：base64 → Blob 網址 → Audio；播完或停止就釋放網址 */
export function browserAudio(b64, mime = 'audio/mpeg') {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const a = new Audio(url)
  let freed = false
  const free = () => { if (!freed) { freed = true; URL.revokeObjectURL(url) } }
  const h = { onended: null, play: () => a.play(), stop() { a.pause(); free() } }
  a.addEventListener('ended', () => { free(); h.onended?.() })
  return h
}
