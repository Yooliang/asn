// 對話區的語音功能接線（念出訊息＋語音輸入）。對話視窗與名單視窗（整合模式）各建一份，傳給 ChatPane 的 voice 屬性。
// 全部靠注入：invoke／listen（Tauri）、createMic、createAudio、reactive（Vue），所以可以用假的測。
// 金鑰與網路都在 Rust 端：這裡只送「要念的文字」、拿「base64 音檔」；語音輸入的聲音只交給本機的辨識引擎。
import { TtsPlayer } from './tts-player.mjs'
import { VoiceInput } from './voice-input.mjs'

const MB = n => `${Math.round(n / 1048576)} MB`

export function createVoiceUi({ invoke, listen, createMic, createAudio, reactive = x => x, log = () => {} }) {
  const state = reactive({
    tts: { key: '', phase: 'idle', error: '' },
    mic: { phase: 'idle' },
    note: '',                 // 輸入框旁的提示（聆聽中、辨識中、錯誤…）
    install: { needed: false, busy: false, text: '' },   // 語音輸入還沒下載辨識引擎／模型時的提示
  })

  const player = new TtsPlayer({
    fetchAudio: text => invoke('tts_speak', { text }),
    createAudio,
    onChange: p => { state.tts.key = p.key; state.tts.phase = p.phase; state.tts.error = p.error },
  })

  const input = new VoiceInput({
    mic: createMic(),
    transcribe: wav => invoke('stt_transcribe', { wav }),
    onState: s => { state.mic.phase = s },
    onNote: t => { state.note = t },
    log,
  })

  let pendingText = null   // 目前這次錄音辨識完要交給誰
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

    /** 麥克風按鈕：第一次用要先下載；之後點一下開始、再點一下結束。辨識完的文字交給 onText（填進輸入框，不送出） */
    async toggleMic(onText) {
      if (state.mic.phase === 'idle') {
        let st
        try { st = await invoke('stt_status') } catch (e) { state.note = e.message; return }
        if (!st.ready) { state.install.needed = true; state.note = ''; return }
        state.install.needed = false
        pendingText = onText
      }
      return input.toggle()
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
