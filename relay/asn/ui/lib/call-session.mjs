// 偽通話（#99）：對話視窗按「通話」後，麥克風一直開著，說完一句（停頓約 1 秒）就在本機辨識、經現有的寄信路徑寄給這位夥伴；
// 對方回信一到就用現有的念出功能念出來，念完回到聆聽。再按掛斷結束。
// 不碰瀏覽器與 Tauri：麥克風、辨識、念出、寄信、計時都從外面注入，好測（見 test/call-session.test.mjs）。
//   mic：{ start({ onChunk }) → Promise<void>, stop() → Promise<…>, rate }（lib/mic.mjs 的 createMic）
//   transcribe(wavBase64) → Promise<string>；sttStatus() → Promise<{ ready }>
//   player：TtsPlayer（enqueue／stop／phase／error）；onTts(fn) → 取消訂閱函式：念出狀態改變時通知
//   send(text)：寄出（對話區的 send 事件，也就是現有的寄信路徑，含本人簽章）
// 階段（phase）：starting 準備麥克風｜listening 聆聽中｜recognizing 辨識中｜waiting 等對方回信｜speaking 念出中
// 收音規則：念出回覆時不收音（不會聽到自己，也不做插話）；靜音時不收音；其餘時間（含等回信）都在聽。
import { SILENCE_PEAK, analyze, peakOf, secondsOf, trim } from './voice-activity.mjs'
import { isHallucination, normalize } from './stt-text.mjs'
import { takeToWavBase64 } from './wav.mjs'
import { speakableText } from './tts-player.mjs'
import { createEndpointer, rmsOf } from './call-vad.mjs'

/** 每封信前面附的一行，請對方用適合念出來的口氣回答 */
export const CALL_MARKER = '（語音通話中，請簡短口語回答）'
export const CALL_SPEAK_MAX = 300           // 通話中一則回覆最多念這麼多字，其餘照常留在對話裡
export const PRE_ROLL_SECONDS = 0.5         // 開始說話前先留的一小段，不吃掉字頭
export const START_SKIP_SECONDS = 0.5      // 通話剛開始的這段聲音不收（按「通話」的點擊聲、麥克風剛開的爆音）
export const MIN_TAKE_SECONDS = 0.5         // 一句短於這個就不送辨識（太短只會讓辨識念出提示詞）
export const MIN_VOICED_SECONDS_CALL = 0.3   // 有聲音的部分短於這個（一聲喀、碰到麥克風）不送辨識
export const ECHO_GUARD_MS = 600            // 念完之後再等一下才開始聽，避免喇叭尾音被當成人聲
export const REPLY_TIMEOUT_MS = 180_000     // 寄出後這麼久對方都沒回，就不再顯示「思考中」
export const RECOGNIZE_TIMEOUT_MS = 75_000
export const START_TIMEOUT_MS = 30_000      // 開麥克風（含授權視窗）最久等多久

export const PHASE_TEXT = {
  starting: '準備麥克風…',
  listening: '聆聽中…請說話',
  recognizing: '辨識中…',
  waiting: '對方思考中…',
  speaking: '對方說話中…',
}

/** 計時顯示：65 → 01:05；超過一小時 → 1:02:03 */
export function formatCallTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0))
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 一則收到的訊息的識別（有 id 用 id，沒有就用時間加內文） */
export const logKey = m => (m?.id ? `id:${m.id}` : `${m?.t}|${m?.text}`)

let activeSession = null
/** 現在有沒有通話在進行（語音輸入的麥克風鈕據此讓路） */
export const isCallActive = () => activeSession !== null

const concat = chunks => {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

const safeNames = f => { try { const v = f(); return Array.isArray(v) ? v : [] } catch { return [] } }

export function createCallSession({
  mic, transcribe, sttStatus, player, onTts, send,
  reactive = x => x, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id),
  setTick = (f, ms) => setInterval(f, ms), clearTick = id => clearInterval(id), now = () => Date.now(), log = () => {},
  canStart = () => '',
  hints = () => [],   // 這次通話要偏向的名字（通話對象＋名單上的夥伴）；每句辨識時現取
}) {
  const state = reactive({ active: false, phase: 'idle', muted: false, seconds: 0, note: '', level: 0, heard: '', reply: '' })
  const ep = createEndpointer()
  let gen = 0, rate = 48000, t0 = 0, tick = null, heardSec = 0
  let preroll = [], prerollLen = 0, utter = null
  let pending = 0, awaiting = 0, chain = Promise.resolve()
  let speakFlag = false, guard = false, guardTimer = null, replyTimer = null, spoken = 0
  let seen = new Set()
  let unsub = null

  const refresh = () => {
    if (!state.active) { state.phase = 'idle'; return }
    if (!t0) { state.phase = 'starting'; return }
    state.phase = speakFlag ? 'speaking' : pending > 0 ? 'recognizing' : awaiting > 0 ? 'waiting' : 'listening'
  }
  const dropUtterance = () => { utter = null; preroll = []; prerollLen = 0; ep.reset() }

  function onChunk(f32) {
    if (!state.active || !t0) return
    state.level = Math.min(1, rmsOf(f32) * 8)
    heardSec += f32.length / rate
    if (heardSec <= START_SKIP_SECONDS) return   // 剛開始的按鍵聲不收
    if (state.muted || speakFlag || guard) { dropUtterance(); return }
    const dt = f32.length / rate
    const ev = ep.push(rmsOf(f32), dt)
    if (ev === 'start') { utter = [...preroll, f32]; preroll = []; prerollLen = 0; return }
    if (ep.speaking) { utter?.push(f32); return }
    if (ev === 'end') {
      utter?.push(f32)
      const take = { samples: concat(utter ?? []), rate }
      utter = null
      submit(take)
      return
    }
    preroll.push(f32); prerollLen += dt
    while (prerollLen > PRE_ROLL_SECONDS && preroll.length > 1) prerollLen -= preroll.shift().length / rate
  }

  function submit(take) {
    const my = gen
    pending++; refresh()
    chain = chain
      .then(() => recognize(take, my))
      .catch(e => { log(`通話辨識出錯：${e?.message}`) })
      .finally(() => { if (my === gen) pending = Math.max(0, pending - 1); refresh() })
  }

  async function recognize(take, my) {
    if (my !== gen || secondsOf(take) < MIN_TAKE_SECONDS || peakOf(take) < SILENCE_PEAK) return
    const r = analyze(take)
    if (!r.hasSpeech || r.voicedSeconds < MIN_VOICED_SECONDS_CALL) return   // 咳嗽、碰桌子：不送
    let raw, timer
    const names = safeNames(hints)
    try {
      const late = new Promise((_, rej) => { timer = setTimer(() => rej(new Error('辨識逾時，這句沒有送出。')), RECOGNIZE_TIMEOUT_MS) })
      raw = await Promise.race([Promise.resolve(transcribe(takeToWavBase64(trim(take, r)), names)), late])
    } catch (e) {
      if (my !== gen) return
      if (/還沒下載/.test(e?.message || '')) { state.note = '語音辨識還沒準備好，通話已結束。'; void end({ keepNote: true }); return }
      state.note = `這句沒辨識成功：${e?.message || '辨識失敗'}`
      return
    } finally { clearTimer(timer) }
    if (my !== gen) return
    const text = normalize(raw, names)
    if (!text) { if (isHallucination(raw, names)) log('通話：丟掉靜音幻覺'); return }
    state.note = ''
    state.heard = text
    awaiting++
    clearTimer(replyTimer)
    replyTimer = setTimer(() => { awaiting = 0; state.note = '對方還沒回信，你可以繼續說。'; refresh() }, REPLY_TIMEOUT_MS)
    try { send(`${CALL_MARKER}\n${text}`) } catch (e) { awaiting = Math.max(0, awaiting - 1); state.note = `寄不出去：${e?.message || '失敗'}` }
    refresh()
  }

  /** 對話記錄有變就呼叫：新到的「對方」訊息念出來（已看過的不重念） */
  function onLog(entries) {
    if (!state.active || !t0) return
    for (const m of entries ?? []) {
      if (m?.k !== 'them') continue
      const key = logKey(m)
      if (seen.has(key)) continue
      seen.add(key)
      const text = String(m.text ?? '').trim()
      if (!text) continue
      awaiting = 0; clearTimer(replyTimer); state.reply = text; state.note = ''
      const say = speakableText(text, CALL_SPEAK_MAX)
      if (!say) continue
      speakFlag = true; dropUtterance()
      player.enqueue(`call:${++spoken}`, say, { stream: true })   // 切句分段，第一句好了就先念
    }
    refresh()
  }

  function onPlayer() {
    if (!speakFlag || player.phase !== 'idle') return
    // 一則念完到下一則開始之間會短暫回到 idle：等這一輪事情做完再確認真的沒在念了
    void Promise.resolve().then(() => {
      if (!speakFlag || !state.active || player.phase !== 'idle') return
      speakFlag = false
      if (player.error) state.note = `念不出來：${player.error}`
      dropUtterance(); guard = true
      clearTimer(guardTimer); guardTimer = setTimer(() => { guard = false }, ECHO_GUARD_MS)
      refresh()
    })
  }

  async function start(entries = []) {
    if (state.active) return false
    const why = activeSession ? '另一個通話正在進行。' : canStart()
    if (why) { state.note = why; return false }
    state.note = ''; state.heard = ''; state.reply = ''
    const my = ++gen
    activeSession = api
    Object.assign(state, { active: true, phase: 'starting', muted: false, seconds: 0, level: 0 })
    seen = new Set((entries ?? []).filter(m => m?.k === 'them').map(logKey))
    const fail = msg => { state.note = msg; state.active = false; state.phase = 'idle'; if (activeSession === api) activeSession = null; return false }
    let st
    try { st = await sttStatus() } catch (e) { return my === gen ? fail(e?.message || '語音功能沒有回應，請再試一次。') : false }
    if (my !== gen) return false
    if (!st?.ready) return fail('通話需要語音辨識。請先下載辨識引擎與語音模型，再按一次通話。')
    let timer
    try {
      const late = new Promise((_, rej) => { timer = setTimer(() => rej(new Error('麥克風沒有回應，請再試一次。')), START_TIMEOUT_MS) })
      await Promise.race([mic.start({ onChunk }), late])
    } catch (e) {
      Promise.resolve().then(() => mic.stop()).catch(() => {})
      return my === gen ? fail(e?.message || '無法使用麥克風。') : false
    } finally { clearTimer(timer) }
    if (my !== gen) { Promise.resolve().then(() => mic.stop()).catch(() => {}); return false }   // 等麥克風的時候已經掛斷了
    rate = mic.rate > 0 ? mic.rate : 48000
    heardSec = 0
    t0 = now()
    unsub = onTts(onPlayer)
    tick = setTick(() => { state.seconds = Math.floor((now() - t0) / 1000) }, 1000)
    refresh()
    return true
  }

  async function end({ keepNote = false } = {}) {
    if (!state.active) return null
    const seconds = t0 ? Math.floor((now() - t0) / 1000) : 0
    gen++
    state.active = false; state.phase = 'idle'
    if (!keepNote) state.note = ''
    if (tick) clearTick(tick)
    clearTimer(replyTimer); clearTimer(guardTimer)
    if (unsub) unsub()
    tick = unsub = replyTimer = guardTimer = null
    if (speakFlag) player.stop()
    speakFlag = false; guard = false; pending = 0; awaiting = 0; t0 = 0; dropUtterance()
    if (activeSession === api) activeSession = null
    try { await mic.stop() } catch { /* 已停 */ }
    return { seconds }
  }

  function toggleMute() {
    if (!state.active) return
    state.muted = !state.muted
    if (state.muted) dropUtterance()
  }

  const api = { state, start, end, toggleMute, onLog }
  return api
}
