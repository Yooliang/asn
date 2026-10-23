// 手機版的語音輸入（純輸入法）：按一下開始聽，講完自動停（或再按一次停），辨識出的字接在輸入框後面，不自動送出。
// 聽用的是通話同一套外殼（CallVoice.kt 的 SpeechRecognizer，zh-TW，含名字偏向）；權限沿用 RECORD_AUDIO，沒有就先詢問。
// 不限對象（AI 夥伴與人都能用）。不碰瀏覽器、不碰 Tauri，也完全不認識「寄信」：沒有 send 可呼叫，結果只會交給 onText（放進輸入框）。
// 外殼同一時間只有一個事件接收者，所以語音輸入與通話互斥（畫面上通話中不給按、語音輸入中不給通話）。
//   native：與 mobile-call.mjs 相同的外殼橋 { available(), micState(), requestMic(), listen(namesJson), stopListen(), end(), onEvent(fn) → 取消訂閱 }
// 階段（phase）：idle｜starting 等權限｜listening 聆聽中
import { normalize } from './stt-text.mjs'

export const DICT_PHASE_TEXT = { starting: '準備中…', listening: '聆聽中…' }
export const DICT_TIP = { idle: '語音輸入：用說的打字，辨識完放進輸入框，由你確認後再送出', starting: '準備中…按一下取消', listening: '聆聽中…說完會自動停，也可以按一下結束' }
export const DICT_DENIED = '沒有麥克風權限，不能語音輸入。請到手機的「設定」→「應用程式」→「ASN」→「權限」，允許使用麥克風。'
export const DICT_NOTES = {
  silence: '沒聽到聲音，請再說一次。',
  busy: '語音辨識服務忙碌中，請稍後再試。',
  denied: DICT_DENIED,
  network: '語音辨識連不上網路，請稍後再試。',
  language: '這支手機的語音辨識不支援中文（台灣）。',
  other: '語音辨識出了問題，請再試一次。',
}
export const DICT_BACKGROUND = '語音輸入已停止（螢幕關閉或切到其他程式）。'
export const DICT_PERM_TIMEOUT_MS = 120_000
export const DICT_MAX_MS = 60_000   // 保險：外殼一直沒回報時，最久聽這麼久就自己收掉

/** 這支手機能不能語音輸入（有外殼、也有語音辨識服務）。不能就不顯示按鈕 */
export function canDictate(native) {
  try { return !!native && native.available() === true } catch { return false }
}

/** 辨識出的字接在輸入框現有文字後面：空的直接放；前後都是英數字才補一個空格（中文之間不加） */
export function appendDictation(draft, text) {
  const add = String(text ?? '').trim()
  const cur = String(draft ?? '')
  if (!add) return cur
  if (!cur) return add
  const need = /[A-Za-z0-9]$/.test(cur) && /^[A-Za-z0-9]/.test(add)
  return cur + (need ? ' ' : '') + add
}

export function createMobileDictation({
  native, onText, hints = () => [], reactive = x => x,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id), log = () => {},
}) {
  const state = reactive({ phase: 'idle', note: '', heard: '' })
  let unsub = null, permWait = null, guardTimer = null, listening = false, gen = 0

  const namesJson = () => { try { const v = hints(); return JSON.stringify(Array.isArray(v) ? v : []) } catch { return '[]' } }

  function finish() {   // 收尾：放掉外殼的辨識器、取消訂閱、回到 idle
    gen++
    clearTimer(guardTimer); guardTimer = null
    if (permWait) permWait(false)
    if (unsub) unsub()
    unsub = null; listening = false
    state.phase = 'idle'; state.heard = ''
    try { native?.end() } catch { /* 已停 */ }
  }

  function deliver(raw) {
    const text = normalize(raw)
    finish()
    if (!text) { state.note = DICT_NOTES.silence; return }
    state.note = ''
    try { onText?.(text) } catch (e) { log(`語音輸入放入輸入框失敗：${e?.message}`) }
  }

  function onEvent(e) {
    if (!e || typeof e !== 'object') return
    switch (e.t) {
      case 'perm': if (permWait) permWait(e.granted === true); return
      case 'partial': if (listening && e.text) state.heard = String(e.text); return
      case 'result': if (listening) deliver(e.text); return
      case 'error':
        if (!listening) return
        { const kind = DICT_NOTES[e.kind] ? e.kind : 'other'; finish(); state.note = DICT_NOTES[kind] }
        return
      case 'background': if (state.phase !== 'idle') { finish(); state.note = DICT_BACKGROUND } return
      default:
    }
  }

  const waitPermission = () => new Promise(resolve => {
    const timer = setTimer(() => { permWait = null; resolve(false) }, DICT_PERM_TIMEOUT_MS)
    permWait = ok => { clearTimer(timer); permWait = null; resolve(ok) }
    try { native.requestMic() } catch { permWait?.(false) }
  })

  async function start() {
    if (state.phase !== 'idle') return false
    state.note = ''; state.heard = ''
    if (!canDictate(native)) { state.note = '這支手機沒有內建的語音辨識服務，不能語音輸入。'; return false }
    const my = ++gen
    state.phase = 'starting'
    unsub = native.onEvent(onEvent)
    if (native.micState() !== 'granted') {
      const ok = await waitPermission()
      if (my !== gen) return false
      if (!ok) { finish(); state.note = DICT_DENIED; return false }
    }
    if (my !== gen) return false
    state.phase = 'listening'; listening = true
    guardTimer = setTimer(() => { guardTimer = null; stop() }, DICT_MAX_MS)
    try { native.listen(namesJson()) } catch (e) { log(`語音輸入開始聽失敗：${e?.message}`); finish(); state.note = DICT_NOTES.other; return false }
    return true
  }

  /** 再按一次：已經聽到的字（partial）照樣放進輸入框；一個字都沒有就單純取消 */
  function stop() {
    if (state.phase === 'idle') return
    const heard = state.phase === 'listening' ? state.heard : ''
    try { native.stopListen() } catch { /* 已停 */ }
    if (heard) deliver(heard); else { finish(); state.note = '' }
  }

  const toggle = () => (state.phase === 'idle' ? start() : (stop(), Promise.resolve(false)))
  return { state, start, stop, toggle }
}
