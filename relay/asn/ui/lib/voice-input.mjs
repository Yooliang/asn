// 語音輸入的流程（不碰瀏覽器與 Tauri，麥克風與辨識都由外面注入，好測）：
//   toggle()：沒在錄 → 開始錄；準備麥克風中／辨識中 → 取消（丟棄結果）；正在錄 → 結束（多錄一小段尾巴，不吃掉最後的字）→
//   沒人聲就不送 → 修掉頭尾安靜 → 送去本機辨識 → 過濾靜音幻覺字、簡轉繁 → 回傳文字。**文字只交給呼叫端填進輸入框，這裡永遠不送信。**
//   每一個會等外部的步驟（開麥克風、停麥克風、辨識）都有逾時，而且任何時候再按一下都停得下來，不會卡在某個狀態。
//   mic：{ start() → Promise<void>, stop() → Promise<{samples, rate}> }（失敗丟 Error，訊息是給人看的；stop 也要能中斷還在等的 start）
//   transcribe(wavBase64) → Promise<string>
import { SILENCE_PEAK, analyze, peakOf, secondsOf, trim } from './voice-activity.mjs'
import { normalize, isHallucination } from './stt-text.mjs'
import { takeToWavBase64 } from './wav.mjs'

export const MAX_SECONDS = 60       // 錄音上限（與 Rust 端一致）
export const MIN_SECONDS = 0.3      // 短於這個＝按太快，不送
export const TAIL_MS = 280          // 結束後多錄的尾巴（要求 250～300 ms）
export const START_TIMEOUT_MS = 30_000       // 開麥克風（含授權視窗）最久等多久
export const STOP_TIMEOUT_MS = 5_000         // 停麥克風最久等多久
export const RECOGNIZE_TIMEOUT_MS = 75_000   // 辨識最久等多久（Rust 端 60 秒就會自己結束）

const CANCELLED = Symbol('cancelled')

export class VoiceInput {
  constructor({ mic, transcribe, onState = () => {}, onNote = () => {}, onText = () => {}, onCancelRecognize = () => {}, tailMs = TAIL_MS, wait = ms => new Promise(r => setTimeout(r, ms)), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), log = () => {}, startTimeoutMs = START_TIMEOUT_MS, stopTimeoutMs = STOP_TIMEOUT_MS, recognizeTimeoutMs = RECOGNIZE_TIMEOUT_MS }) {
    Object.assign(this, { mic, transcribe, onState, onNote, onText, onCancelRecognize, tailMs, wait, setTimer, clearTimer, log, startTimeoutMs, stopTimeoutMs, recognizeTimeoutMs })
    this.state = 'idle'   // idle | starting | recording | recognizing
    this.lastDropped = null   // 最近一次被當成幻覺丟掉的原文（除錯用）
    this.limitTimer = null
    this.gen = 0
    this.finishing = 0        // 正在「結束」流程（含尾巴期間）時是那一輪的編號；期間的重複點擊忽略
    this.aborters = new Set() // 取消時把正在等的步驟全部放掉
  }

  #set(s) { this.state = s; this.onState(s) }

  /** 等外部的一步：逾時或被取消就放棄（原本的 Promise 之後怎麼結束都不再理它） */
  #race(p, ms, msg) {
    let t, abort
    const stop = new Promise((_, rej) => {
      t = this.setTimer(() => rej(new Error(msg)), ms)
      abort = () => rej(CANCELLED)
      this.aborters.add(abort)
    })
    return Promise.race([p, stop]).finally(() => { this.clearTimer(t); this.aborters.delete(abort) })
  }

  async toggle() {
    if (this.state === 'idle') return this.start()
    if (this.state === 'recording') return this.finishing ? undefined : this.finish()
    return this.cancel()   // 準備麥克風中／辨識中：再按一下＝取消
  }

  async start() {
    if (this.state !== 'idle') return false
    const gen = ++this.gen
    this.#set('starting')
    this.onNote('準備麥克風…再按一下取消')
    try { await this.#race(this.mic.start(), this.startTimeoutMs, '麥克風沒有回應，請再試一次。') }
    catch (e) {
      if (gen !== this.gen) return false   // 已被取消（取消時已放掉麥克風）
      Promise.resolve().then(() => this.mic.stop()).catch(() => {})   // 逾時或失敗：放掉可能晚到的麥克風
      this.#set('idle')
      this.onNote(e?.message || '無法使用麥克風')
      return false
    }
    if (gen !== this.gen) return false
    this.#set('recording')
    this.onNote('聆聽中…說完再按一下麥克風（Esc 取消）')
    this.limitTimer = this.setTimer(() => { void this.finish() }, MAX_SECONDS * 1000)
    return true
  }

  /** 放棄這次（準備中／錄音中／辨識中都行），什麼都不送；辨識中會通知後端結束辨識程式 */
  async cancel() {
    const was = this.state
    this.gen++
    this.finishing = 0
    this.clearTimer(this.limitTimer)
    for (const f of [...this.aborters]) f()
    let stopping = null
    if (was === 'starting' || was === 'recording') { try { stopping = this.mic.stop() } catch { /* 忽略 */ } }
    if (was === 'recognizing') { try { this.onCancelRecognize() } catch { /* 忽略 */ } }
    if (was !== 'idle') this.#set('idle')
    this.onNote(was === 'recognizing' ? '已取消辨識。' : '')
    if (stopping) { try { await this.#race(Promise.resolve(stopping), this.stopTimeoutMs, '') } catch { /* 忽略 */ } }
  }

  async finish() {
    if (this.state !== 'recording' || this.finishing) return null
    const gen = this.gen
    this.finishing = gen
    this.clearTimer(this.limitTimer)
    try { return await this.#finish(gen) }
    catch (e) { if (e === CANCELLED || gen !== this.gen) return null; return this.#end(e?.message || '辨識失敗') }
    finally { if (this.finishing === gen) this.finishing = 0 }
  }

  async #finish(gen) {
    if (this.tailMs > 0) await this.#race(this.wait(this.tailMs), this.tailMs + this.stopTimeoutMs, '錄音沒有回應，請再試一次。')
    if (gen !== this.gen) return null
    this.#set('recognizing')
    this.onNote('辨識中…按一下取消（Esc 也可以）')
    let take
    try { take = await this.#race(this.mic.stop(), this.stopTimeoutMs, '錄音沒有回應，請再試一次。') }
    catch (e) { if (e === CANCELLED || gen !== this.gen) return null; return this.#end(e?.message || '錄音失敗') }
    if (gen !== this.gen) return null
    if (secondsOf(take) < MIN_SECONDS) return this.#end('說話時間太短。')
    if (peakOf(take) < SILENCE_PEAK) return this.#end('沒聽到聲音。')
    const r = analyze(take)
    if (!r.hasSpeech) { this.log(`沒人聲：${JSON.stringify({ voiced: r.voicedSeconds, peak: r.peakRms, floor: r.floorRms })}`); return this.#end('沒聽到聲音。') }
    let raw
    try { raw = await this.#race(Promise.resolve(this.transcribe(takeToWavBase64(trim(take, r)))), this.recognizeTimeoutMs, '辨識逾時，請再試一次。') }
    catch (e) {
      if (e === CANCELLED || gen !== this.gen) return null
      if (/逾時/.test(e?.message || '')) { try { this.onCancelRecognize() } catch { /* 忽略 */ } }   // 前端先到期：也請後端結束辨識程式
      return this.#end(e?.message || '辨識失敗')
    }
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
