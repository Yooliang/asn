// 手機版「念出訊息」（#2304）：對話裡每則對方訊息旁的喇叭鈕，以及「收到新訊息自動念」。
// 念出用安卓內建的語音合成（ReadAloud.kt，與通話用的 CallVoice.kt 各自一個引擎，互不影響）；
// 念出前的整理沿用電腦版與通話模式同一支 speakableText、同一支 speechSegments，不另寫一份去格式規則。
// 這個檔案不碰瀏覽器、不碰 Tauri：外殼（native）、計時都從外面注入，好測（見 test/mobile-speak.test.mjs）。
//   native：{ speak(id, text, voiceId), stop(), onEvent(fn) → 取消訂閱 }
//   外殼事件：{t:'read-done',id} {t:'read-error',id?,message}
import { speakableText, SPEAK_MAX } from './tts-player.mjs'
import { speechSegments } from './speech-split.mjs'
import { plainMessage } from './plain-errors.mjs'

export const AUTO_FRESH_MS = 5 * 60_000   // 自動念只念這麼近以內寄來的信；更舊的是補收的歷史，不念
export const AUTO_QUEUE_MAX = 3           // 自動念排隊最多幾則，超過丟掉最舊的
export const SPEAK_DOG_BASE_MS = 30_000   // 保險計時：外殼一直沒回報念完時，不讓按鈕卡在「停止」
export const SPEAK_DOG_PER_CHAR_MS = 400

/**
 * 收到一則通知要不要自動念。回 { ok, why }：ok 為真才念；why 是不念的原因（測試與 log 用）。
 * 只念「對方的新訊息」：設定要開（預設關）、App 在前景、不是自己發的、不是補收的歷史、不是合併提示、不在通話中。
 */
export function autoSpeakPlan(notify, { cfg, foreground = true, calling = false, now = Date.now() } = {}) {
  if (!notify || notify.kind !== 'msg') return { ok: false, why: 'not-msg' }
  if (cfg?.tts_auto !== true) return { ok: false, why: 'off' }
  if (!foreground) return { ok: false, why: 'background' }
  if (calling) return { ok: false, why: 'calling' }
  if (notify.mine === true) return { ok: false, why: 'mine' }
  if (notify.digest === true) return { ok: false, why: 'digest' }
  const at = Number(notify.at)
  if (!Number.isFinite(at) || now - at > AUTO_FRESH_MS) return { ok: false, why: 'history' }
  if (!speakableText(notify.line, SPEAK_MAX)) return { ok: false, why: 'empty' }
  return { ok: true, why: '' }
}

export function createMobileSpeaker({
  native, voice = () => '', reactive = x => x,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id), log = () => {},
}) {
  const state = reactive({ tts: { key: '', phase: 'idle', error: '' } })   // 形狀與電腦版 voice-ui 的 state.tts 相同，對話區同一顆喇叭鈕直接用
  const outstanding = new Set()
  let queue = [], seq = 0, dog = null

  const idle = () => state.tts.phase === 'idle'
  function setState(key, phase, error = '') { state.tts.key = key; state.tts.phase = phase; state.tts.error = error }

  function finish() {
    clearTimer(dog); dog = null
    outstanding.clear()
    setState('', 'idle', state.tts.error)
    const next = queue.shift()
    if (next) begin(next.key, next.text)
  }

  function begin(key, raw) {
    const say = speakableText(raw, SPEAK_MAX)
    const segs = say ? speechSegments(say) : []
    if (!segs.length) { setState('', 'idle', ''); return false }
    setState(key, 'speaking', '')
    for (const seg of segs) {
      const id = `s${++seq}`
      outstanding.add(id)
      try { native.speak(id, seg, String(voice() ?? '')) } catch (e) { outstanding.delete(id); log(`念出失敗：${e?.message}`) }
    }
    if (!outstanding.size) { setState('', 'idle', '這支手機現在念不出來。'); return false }
    dog = setTimer(() => { dog = null; try { native.stop() } catch { /* 已停 */ } log('念出保險計時到了，外殼沒回報念完'); finish() }, SPEAK_DOG_BASE_MS + [...say].length * SPEAK_DOG_PER_CHAR_MS)
    return true
  }

  function stop() {
    queue = []
    try { native.stop() } catch { /* 已停 */ }
    finish()
  }

  const unsub = native.onEvent(e => {
    if (!e || typeof e !== 'object') return
    if (e.t === 'read-done') { if (outstanding.delete(e.id) && !outstanding.size) finish(); return }
    if (e.t === 'read-error') {
      log(`念出錯誤：${e.message ?? ''}`)
      const msg = `念不出來：${plainMessage(e, '語音合成失敗')}`
      queue = []; try { native.stop() } catch { /* 已停 */ }
      clearTimer(dog); dog = null; outstanding.clear()
      setState('', 'idle', msg)
    }
  })

  return {
    state,
    /** 喇叭鈕：同一則再按＝停止；按另一則＝換過去 */
    speak(key, raw) {
      if (!idle() && state.tts.key === key) { stop(); return }
      if (!idle()) stop()
      state.tts.error = ''
      begin(key, raw)
    },
    /** 自動念（排隊） */
    speakAuto(key, raw) {
      if (idle()) { state.tts.error = ''; begin(key, raw); return }
      queue.push({ key, text: raw })
      while (queue.length > AUTO_QUEUE_MAX) queue.shift()
    },
    stop,
    dispose() { stop(); unsub?.() },
  }
}
