// 語音設定頁的純邏輯（介面與測試共用）。設定本身存在 Rust 端的 voice.json（voice_cfg_get／voice_cfg_set），
// 這裡只放選項、標籤與「收到新訊息要不要自動念」的判斷。
export const STT_LANGS = ['zh', 'auto', 'en']
export const STT_LANG_LABEL = { zh: '中文', auto: '自動判斷', en: '英文' }
export const STT_MODELS = ['small', 'base']
export const STT_MODEL_LABEL = { small: '較準（約 190 MB）', base: '較快（約 60 MB）' }
export const AUTO_CHOICES = ['off', 'on']
export const AUTO_LABEL = { off: '關', on: '開' }

export const DEFAULT_CFG = Object.freeze({ tts_voice: '', tts_auto: false, stt_lang: 'zh', stt_model: 'small' })

/** 讀回的設定：每個欄位各自驗證，壞值退回預設 */
export function normalizeCfg(c) {
  const o = c && typeof c === 'object' ? c : {}
  return {
    tts_voice: typeof o.tts_voice === 'string' ? o.tts_voice : DEFAULT_CFG.tts_voice,
    tts_auto: o.tts_auto === true,
    stt_lang: STT_LANGS.includes(o.stt_lang) ? o.stt_lang : DEFAULT_CFG.stt_lang,
    stt_model: STT_MODELS.includes(o.stt_model) ? o.stt_model : DEFAULT_CFG.stt_model,
  }
}

/** 收到一則通知要不要自動念：只有「對方的新訊息」、設定開著、自己不是忙碌中才念；震動、登入提示不念 */
export const shouldAutoSpeak = (notify, cfg, myStatus) => notify?.kind === 'msg' && cfg?.tts_auto === true && myStatus !== 'busy' && !!String(notify.line ?? '').trim()

/** 設定頁語音辨識那一行的說明 */
export function sttStatusText(st) {
  if (!st) return ''
  if (st.installing) return '正在下載…'
  if (st.ready) return '已準備好，對話裡按麥克風就能說話。聲音只在這台電腦上辨識。'
  if (st.engine) return '辨識引擎已下載，還差這個模型。'
  return '還沒下載。第一次按對話裡的麥克風時會問你要不要下載。'
}
