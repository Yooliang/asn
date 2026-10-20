// 語音輸入的流程（不碰瀏覽器與 Tauri，麥克風與辨識都由外面注入，好測）：
//   toggle()：沒在錄 → 開始錄；正在錄 → 結束（多錄一小段尾巴，不吃掉最後的字）→ 沒人聲就不送 → 修掉頭尾安靜 →
//   送去本機辨識 → 過濾靜音幻覺字、簡轉繁 → 回傳文字。**文字只交給呼叫端填進輸入框，這裡永遠不送信。**
//   mic：{ start() → Promise<void>, stop() → Promise<{samples, rate}> }（失敗丟 Error，訊息是給人看的）
//   transcribe(wavBase64) → Promise<string>
import { SILENCE_PEAK, analyze, peakOf, secondsOf, trim } from './voice-activity.mjs'
import { normalize, isHallucination } from './stt-text.mjs'
import { takeToWavBase64 } from './wav.mjs'

export const MAX_SECONDS = 60       // 錄音上限（與 Rust 端一致）
export const MIN_SECONDS = 0.3      // 短於這個＝按太快，不送
export const TAIL_MS = 280          // 結束後多錄的尾巴（要求 250～300 ms）

export class VoiceInput {
  constructor({ mic, transcribe, onState = () => {}, onNote = () => {}, onText = () => {}, tailMs = TAIL_MS, wait = ms => new Promise(r => setTimeout(r, ms)), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
    Object.assign(this, { mic, transcribe, onState, onNote, onText, tailMs, wait, setTimer, clearTimer, log })
    this.state = 'idle'   // idle | recording | recognizing
    this.lastDropped = null   // 最近一次被當成幻覺丟掉的原文（除錯用）
    this.limitTimer = null
    this.gen = 0
  }

  #set(s) { this.state = s; this.onState(s) }

  async toggle() {
    if (this.state === 'idle') return this.start()
    if (this.state === 'recording') return this.finish()
    return undefined   // 辨識中：忽略
  }

  async start() {
    if (this.state !== 'idle') return false
    const gen = ++this.gen
    this.onNote('')
    try { await this.mic.start() }
    catch (e) { this.onNote(e?.message || '無法使用麥克風'); return false }
    if (gen !== this.gen) { try { await this.mic.stop() } catch { /* 已取消 */ } return false }
    this.#set('recording')
    this.onNote('聆聽中…說完再按一次麥克風')
    this.limitTimer = this.setTimer(() => { void this.finish() }, MAX_SECONDS * 1000)
    return true
  }

  /** 放棄這次錄音，什麼都不送 */
  async cancel() {
    this.gen++
    this.clearTimer(this.limitTimer)
    if (this.state === 'recording') { try { await this.mic.stop() } catch { /* 忽略 */ } }
    if (this.state !== 'idle') this.#set('idle')
    this.onNote('')
  }

  async finish() {
    if (this.state !== 'recording') return null
    const gen = this.gen
    this.clearTimer(this.limitTimer)
    if (this.tailMs > 0) await this.wait(this.tailMs)
    if (gen !== this.gen) return null
    this.#set('recognizing')
    this.onNote('辨識中…')
    let take
    try { take = await this.mic.stop() } catch (e) { return this.#end(e?.message || '錄音失敗') }
    if (gen !== this.gen) return null
    if (secondsOf(take) < MIN_SECONDS) return this.#end('說話時間太短。')
    if (peakOf(take) < SILENCE_PEAK) return this.#end('沒聽到聲音。')
    const r = analyze(take)
    if (!r.hasSpeech) { this.log(`沒人聲：${JSON.stringify({ voiced: r.voicedSeconds, peak: r.peakRms, floor: r.floorRms })}`); return this.#end('沒聽到聲音。') }
    let raw
    try { raw = await this.transcribe(takeToWavBase64(trim(take, r))) }
    catch (e) { return this.#end(e?.message || '辨識失敗') }
    if (gen !== this.gen) return null
    const text = normalize(raw)
    if (!text) {
      this.lastDropped = isHallucination(raw) ? raw : null
      return this.#end('沒聽到聲音。')
    }
    this.lastDropped = null
    this.#set('idle')
    this.onNote('')
    this.onText(text)
    return text
  }

  #end(note) { this.#set('idle'); this.onNote(note); return null }
}
