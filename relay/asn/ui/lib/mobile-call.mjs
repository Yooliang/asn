// 手機版的偽通話（#99 的安卓做法）。畫面（CallView）、念出前的整理（speakableText）、分段（speech-split）、
// 每封信前面附的標記與「對方回信怎麼認」都沿用電腦版的共用純邏輯；不一樣的只有「聽」和「念」：
//   聽：安卓內建的語音辨識（SpeechRecognizer，zh-TW），一次聽一句，句子辨識好直接給文字；
//   念：安卓內建的語音合成（TextToSpeech，zh-TW）。電腦版的念出（tts.rs 經後台）是電腦端模組，不能編進手機，所以手機用系統的。
// 兩者都在 Kotlin 外殼（CallVoice.kt），經 window.AsnAndroid 交給網頁；外殼的事件用 native.onEvent 收。
// 這個檔案不碰瀏覽器、不碰 Tauri：外殼（native）、寄信（send）、計時都從外面注入，好測（見 test/mobile-call.test.mjs）。
//   native：{ available(), micState(), requestMic(), listen(), stopListen(), speak(id, text), stopSpeak(), end(), onEvent(fn) → 取消訂閱 }
//   外殼事件：{t:'perm',granted} {t:'level',v} {t:'partial',text} {t:'result',text} {t:'error',kind}
//             {t:'tts-done',id} {t:'tts-error',id,message} {t:'background'}
//   error 的 kind：silence（沒聽到話）｜busy｜denied（沒權限）｜network｜language（不支援中文）｜other
// 階段（phase）：starting 準備｜listening 聽你說｜sending 傳送中｜waiting 等回覆｜speaking 念出中
// 收音規則：只有「聽你說」這一段才開辨識；傳送、等回覆、念出時都不收音（不會聽到自己，也不會一直嗶嗶響）；靜音時不收音。
import { CALL_MARKER, CALL_SPEAK_MAX, ECHO_GUARD_MS, REPLY_TIMEOUT_MS, logKey } from './call-session.mjs'
import { normalize } from './stt-text.mjs'
import { speakableText } from './tts-player.mjs'
import { speechSegments } from './speech-split.mjs'
import { engineKey } from './tabs.mjs'
import { isAsnWindow } from './roster.mjs'

export const MOBILE_PHASE_TEXT = {
  starting: '準備中…',
  listening: '聽你說…',
  sending: '傳送中…',
  waiting: '等回覆中…',
  speaking: '念出中…',
}
export const MIC_DENIED_TEXT = '沒有麥克風權限，不能通話。請到手機的「設定」→「應用程式」→「ASN」→「權限」，允許使用麥克風。'
export const NO_RECOGNIZER_TEXT = '這支手機沒有內建的語音辨識服務，不能通話。'
export const BACKGROUND_TEXT = '通話已結束（螢幕關閉或切到其他程式）。'
export const PERM_TIMEOUT_MS = 120_000   // 等使用者回答權限詢問
export const MAX_SILENT = 20             // 連續這麼多次都沒聽到話，就當作沒人了，自動結束
export const MAX_ERRORS = 3              // 連續這麼多次辨識出錯（連線、其他），自動結束
export const RELISTEN_MS = 250           // 一句聽完（或沒聽到）到重新開始聽之間隔多久
export const BUSY_RELISTEN_MS = 700
export const SPEAK_DOG_BASE_MS = 30_000  // 念出的保險計時：外殼一直沒回報念完時，不讓通話卡在「念出中」
export const SPEAK_DOG_PER_CHAR_MS = 400

/** 只有 AI 夥伴能通話：人、ASN 程式本身、還在開的、離線的都不行（離線的信只會留在收發室，等不到回覆） */
export function canCallPartner(friend) {
  if (!friend || friend.pending) return false
  if (isAsnWindow(friend)) return false
  if (friend.status === 'offline') return false
  return engineKey(friend) !== 'other'   // 沒有已知的 AI 引擎＝不是 AI 夥伴
}

const KIND_NOTE = {
  network: '語音辨識連不上網路，通話已結束。',
  language: '這支手機的語音辨識不支援中文（台灣），通話已結束。',
  other: '語音辨識出了問題，通話已結束。',
  busy: '語音辨識服務忙碌中，通話已結束。',
}

export function createMobileCall({
  native, send, reactive = x => x,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id),
  setTick = (f, ms) => setInterval(f, ms), clearTick = id => clearInterval(id), now = () => Date.now(), log = () => {},
  canStart = () => '',
}) {
  const state = reactive({ active: false, phase: 'idle', muted: false, seconds: 0, note: '', level: 0, heard: '', reply: '' })
  let gen = 0, t0 = 0, tick = null, unsub = null
  let listening = false, sending = false, awaiting = 0, guard = false
  let silent = 0, errors = 0, busyCount = 0, spoken = 0
  const outstanding = new Set()
  let seen = new Set()
  let relistenTimer = null, guardTimer = null, replyTimer = null, speakDog = null, permWait = null

  const speakingNow = () => outstanding.size > 0
  const refresh = () => {
    if (!state.active) { state.phase = 'idle'; return }
    if (!t0) { state.phase = 'starting'; return }
    state.phase = speakingNow() ? 'speaking' : sending ? 'sending' : awaiting > 0 ? 'waiting' : 'listening'
  }
  const canListen = () => state.active && !!t0 && !state.muted && !speakingNow() && !guard && !sending && awaiting === 0 && !relistenTimer

  function listenIfDue() {
    if (listening || !canListen()) return
    listening = true
    try { native.listen() } catch (e) { listening = false; log(`通話開始聽失敗：${e?.message}`) }
  }
  function stopListening() {
    if (!listening) return
    listening = false
    state.level = 0
    try { native.stopListen() } catch { /* 已停 */ }
  }
  const relistenSoon = ms => {
    clearTimer(relistenTimer)
    relistenTimer = setTimer(() => { relistenTimer = null; listenIfDue() }, ms)
  }

  async function handleResult(raw, my) {
    const text = normalize(raw)
    if (!text) { silent++; return silentCheck() }
    silent = 0; errors = 0; busyCount = 0
    state.note = ''; state.heard = text
    sending = true; awaiting++
    clearTimer(replyTimer)
    replyTimer = setTimer(() => { awaiting = 0; state.note = '對方還沒回信，你可以繼續說。'; refresh(); relistenSoon(RELISTEN_MS) }, REPLY_TIMEOUT_MS)
    refresh()
    try { await send(`${CALL_MARKER}\n${text}`, { voice: true }) } catch (e) {
      if (my !== gen) return
      awaiting = Math.max(0, awaiting - 1); clearTimer(replyTimer)
      state.note = `寄不出去：${e?.message || '失敗'}`
    }
    if (my !== gen) return
    sending = false
    refresh(); relistenSoon(RELISTEN_MS)
  }
  function silentCheck() {
    if (silent >= MAX_SILENT) { state.note = '很久沒聽到聲音，通話已結束。'; void end({ keepNote: true }); return }
    relistenSoon(RELISTEN_MS)
  }

  function onError(kind) {
    switch (kind) {
      case 'silence': silent++; return silentCheck()
      case 'denied': state.note = MIC_DENIED_TEXT; void end({ keepNote: true }); return
      case 'language': state.note = KIND_NOTE.language; void end({ keepNote: true }); return
      case 'busy':
        if (++busyCount > 5) { state.note = KIND_NOTE.busy; void end({ keepNote: true }); return }
        return relistenSoon(BUSY_RELISTEN_MS)
      default:   // network、other
        if (++errors >= MAX_ERRORS) { state.note = KIND_NOTE[kind] || KIND_NOTE.other; void end({ keepNote: true }); return }
        return relistenSoon(BUSY_RELISTEN_MS)
    }
  }

  function speakDone() {
    clearTimer(speakDog); speakDog = null
    stopListening()
    guard = true
    clearTimer(guardTimer); guardTimer = setTimer(() => { guard = false; refresh(); listenIfDue() }, ECHO_GUARD_MS)
    refresh()
  }

  function onEvent(e) {
    if (!e || typeof e !== 'object') return
    const my = gen
    switch (e.t) {
      case 'perm': if (permWait) permWait(e.granted === true); return
      case 'level': if (state.active && !state.muted && listening) state.level = Math.max(0, Math.min(1, Number(e.v) || 0)); return
      case 'partial': if (state.active && listening && e.text) state.heard = String(e.text); return
      case 'result':
        if (!listening) return   // 靜音、念出、掛斷之後才到的結果丟掉
        listening = false; state.level = 0
        void handleResult(e.text, my); return
      case 'error':
        if (!listening) return
        listening = false; state.level = 0
        if (state.active) onError(e.kind); return
      case 'tts-done':
        if (!outstanding.delete(e.id)) return
        if (!speakingNow()) speakDone()
        return
      case 'tts-error':
        state.note = `念不出來：${e.message || '語音合成失敗'}`
        outstanding.clear(); try { native.stopSpeak() } catch { /* 已停 */ }
        speakDone(); return
      case 'background': if (state.active) { state.note = BACKGROUND_TEXT; void end({ keepNote: true }) } return
      default:
    }
  }

  /** 對話記錄有變就呼叫：新到的「對方」訊息念出來（已看過的不重念） */
  function onLog(entries) {
    if (!state.active || !t0) return
    let fresh = false
    for (const m of entries ?? []) {
      if (m?.k !== 'them') continue
      const key = logKey(m)
      if (seen.has(key)) continue
      seen.add(key)
      const text = String(m.text ?? '').trim()
      if (!text) continue
      fresh = true
      awaiting = 0; clearTimer(replyTimer); state.reply = text; state.note = ''
      const say = speakableText(text, CALL_SPEAK_MAX)
      if (!say) continue
      const segs = speechSegments(say)
      stopListening()
      for (const seg of segs) {
        const id = `c${++spoken}`
        outstanding.add(id)
        try { native.speak(id, seg) } catch (err) { outstanding.delete(id); log(`通話念出失敗：${err?.message}`) }
      }
      clearTimer(speakDog)
      speakDog = setTimer(() => { speakDog = null; if (speakingNow()) { outstanding.clear(); try { native.stopSpeak() } catch { /* 已停 */ } speakDone() } }, SPEAK_DOG_BASE_MS + [...say].length * SPEAK_DOG_PER_CHAR_MS)
    }
    refresh()
    if (fresh && !speakingNow()) relistenSoon(RELISTEN_MS)   // 這則沒有可以念的字：直接回到聽你說
  }

  const waitPermission = () => new Promise(resolve => {
    const timer = setTimer(() => { permWait = null; resolve(false) }, PERM_TIMEOUT_MS)
    permWait = ok => { clearTimer(timer); permWait = null; resolve(ok) }
    try { native.requestMic() } catch { permWait?.(false) }
  })

  async function start(entries = []) {
    if (state.active) return false
    const why = canStart()
    if (why) { state.note = why; return false }
    state.note = ''; state.heard = ''; state.reply = ''
    const my = ++gen
    Object.assign(state, { active: true, phase: 'starting', muted: false, seconds: 0, level: 0 })
    seen = new Set((entries ?? []).filter(m => m?.k === 'them').map(logKey))
    listening = sending = guard = false; awaiting = 0; silent = errors = busyCount = 0; outstanding.clear()
    const fail = async msg => {
      state.note = msg
      if (my === gen) await end({ keepNote: true })
      return false
    }
    if (!native || !native.available()) return fail(NO_RECOGNIZER_TEXT)
    unsub = native.onEvent(onEvent)
    if (native.micState() !== 'granted') {
      const ok = await waitPermission()
      if (my !== gen) return false
      if (!ok) return fail(MIC_DENIED_TEXT)
    }
    if (my !== gen) return false
    t0 = now() || 1
    tick = setTick(() => { state.seconds = Math.floor((now() - t0) / 1000) }, 1000)
    refresh()
    listenIfDue()
    return true
  }

  async function end({ keepNote = false } = {}) {
    if (!state.active) return null
    const seconds = t0 ? Math.floor((now() - t0) / 1000) : 0
    gen++
    state.active = false; state.phase = 'idle'; state.level = 0
    if (!keepNote) state.note = ''
    if (tick) clearTick(tick)
    for (const t of [relistenTimer, guardTimer, replyTimer, speakDog]) clearTimer(t)
    if (permWait) permWait(false)
    if (unsub) unsub()
    tick = unsub = relistenTimer = guardTimer = replyTimer = speakDog = null
    listening = sending = guard = false; awaiting = 0; t0 = 0; outstanding.clear()
    try { native?.end() } catch { /* 已停 */ }
    return { seconds }
  }

  function toggleMute() {
    if (!state.active) return
    state.muted = !state.muted
    if (state.muted) { stopListening(); state.level = 0 } else listenIfDue()
  }

  return { state, start, end, toggleMute, onLog }
}
