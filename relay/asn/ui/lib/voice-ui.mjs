// 對話區的語音功能接線（念出訊息＋語音輸入）。對話視窗與名單視窗（整合模式）各建一份，傳給 ChatPane 的 voice 屬性。
// 全部靠注入：invoke／listen（Tauri）、createMic、createAudio、reactive（Vue），所以可以用假的測。
// 金鑰與網路都在 Rust 端：這裡只送「要念的文字」、拿「base64 音檔」；語音輸入的聲音只交給本機的辨識引擎。
import { TtsPlayer } from './tts-player.mjs'
import { VoiceInput } from './voice-input.mjs'
import { createCallSession, isCallActive } from './call-session.mjs'

const MB = n => `${Math.round(n / 1048576)} MB`

export function createVoiceUi({ invoke, listen, createMic, createAudio, reactive = x => x, log = () => {} }) {
  const state = reactive({
    tts: { key: '', phase: 'idle', error: '' },
    mic: { phase: 'idle' },
    note: '',                 // 輸入框旁的提示（聆聽中、辨識中、錯誤…）
    install: { needed: false, busy: false, text: '' },   // 語音輸入還沒下載辨識引擎／模型時的提示
  })

  const ttsListeners = new Set()   // 通話模式要知道念完了沒
  const player = new TtsPlayer({
    fetchAudio: text => invoke('tts_speak', { text }),
    createAudio,
    onChange: p => { state.tts.key = p.key; state.tts.phase = p.phase; state.tts.error = p.error; for (const f of [...ttsListeners]) f(p) },
  })

  const input = new VoiceInput({
    mic: createMic(),
    transcribe: async wav => {
      try { return await invoke('stt_transcribe', { wav }) }
      catch (e) { if (/還沒下載/.test(e?.message || '')) { sttReady = false; state.install.needed = true }; throw e }
    },
    onCancelRecognize: () => { void Promise.resolve().then(() => invoke('stt_cancel')).catch(() => {}) },   // 請 Rust 端結束正在跑的辨識程式
    onState: s => { state.mic.phase = s },
    onNote: t => { state.note = t },
    log,
  })

  let sttReady = false     // 確認過辨識已下載就記住，之後的點擊不必再問 stt_status
  let checkGen = 0, checking = false   // 開始前的 stt_status 檢查（可被再按一下取消）
  let pendingText = null   // 目前這次錄音辨識完要交給誰（多個面板共用時，交給「按結束」的那個面板）
  input.onText = t => { const f = pendingText; pendingText = null; if (f) f(t) }

  let unlisten = null
  async function trackProgress() {
    if (unlisten) return
    unlisten = await listen('asn:stt-progress', p => {
      if (p.stage === 'done') { state.install.text = ''; return }
      const what = p.stage === 'engine' ? '辨識引擎' : '語音模型'
      state.install.text = p.total ? `正在下載${what}… ${MB(p.done)} / ${MB(p.total)}` : `正在下載${what}… ${MB(p.done)}`
    })
  }

  return {
    state,
    player,
    /** 念出（或停止）一則訊息 */
    speak: (key, text) => player.toggle(key, text),
    /** 自動念（排隊） */
    speakAuto: (key, text) => player.enqueue(key, text),
    stopSpeaking: () => player.stop(),

    /** 麥克風按鈕：第一次用要先下載；之後點一下開始、再點一下結束；準備中或辨識中再點一下＝取消。
     *  辨識完的文字交給 onText（填進輸入框，不送出）。狀態只看 VoiceInput 本身，錄音中的點擊不會再等任何東西。 */
    async toggleMic(onText) {
      if (isCallActive()) { state.note = '通話中，不能同時用語音輸入。'; return undefined }
      if (input.state !== 'idle') { if (onText) pendingText = onText; return input.toggle() }
      if (checking) { checkGen++; checking = false; state.mic.phase = 'idle'; state.note = ''; return undefined }   // 還在檢查時又點＝取消
      if (!sttReady) {
        const g = ++checkGen
        checking = true; state.mic.phase = 'starting'; state.note = '準備中…再按一下取消'
        let st, timer
        try {
          const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('語音功能沒有回應，請再試一次。')), 5000); timer?.unref?.() })
          st = await Promise.race([Promise.resolve().then(() => invoke('stt_status')), late])
        } catch (e) { if (g === checkGen) { checking = false; state.mic.phase = 'idle'; state.note = e.message }; return undefined }
        finally { clearTimeout(timer) }
        if (g !== checkGen) return undefined   // 等的時候被取消了
        checking = false
        if (!st.ready) { state.mic.phase = 'idle'; state.install.needed = true; state.note = ''; return undefined }
        sttReady = true
      }
      state.install.needed = false
      pendingText = onText
      return input.toggle()
    },
    /** 偽通話（#99）：建一個通話（每個對話面板一個）；send 是寄出的路徑（對話區的 send 事件）。同時只能有一個通話在進行 */
    newCall: ({ send }) => createCallSession({
      mic: createMic(),
      player,
      send,
      reactive,
      log,
      onTts: fn => { ttsListeners.add(fn); return () => ttsListeners.delete(fn) },
      sttStatus: async () => {
        const st = await invoke('stt_status')
        if (!st?.ready) state.install.needed = true   // 還沒下載辨識：顯示對話區上方現成的下載提示
        else sttReady = true
        return st
      },
      transcribe: async wav => {
        try { return await invoke('stt_transcribe', { wav }) }
        catch (e) { if (/還沒下載/.test(e?.message || '')) { sttReady = false; state.install.needed = true }; throw e }
      },
      canStart: () => (input.state !== 'idle' || checking ? '語音輸入進行中，請先結束再通話。' : ''),
    }),
    /** 取消（Esc 或再按一下）：準備中／錄音中／辨識中都放棄，結果丟棄 */
    async cancelMic() {
      checkGen++; checking = false
      await input.cancel()
      state.mic.phase = 'idle'
    },
    /** 按下「下載」：抓辨識引擎與目前選的模型（只下載一次） */
    async installStt() {
      if (state.install.busy) return
      state.install.busy = true; state.install.text = '準備下載…'
      await trackProgress()
      try { await invoke('stt_install'); state.install.needed = false; state.note = '語音輸入準備好了，按麥克風開始說話。' }
      catch (e) { state.note = e.message }
      finally { state.install.busy = false; state.install.text = '' }
    },
    dismissInstall: () => { state.install.needed = false },
  }
}
