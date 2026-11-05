// 設定頁「夥伴共用同一個終端服務」開關的說明文字（#868）。純函式，方便測試。
// 給使用者看的字：不出現技術名詞（mux、WezTerm、環境變數名），只講「關掉會怎樣」「什麼時候生效」。

export const TERM_SERVER_ON_NOTE = '開著：夥伴共用同一個在背景跑的終端服務，關掉畫面或關掉 ASN，夥伴都會繼續跑。'
export const TERM_SERVER_OFF_NOTE = '關掉：新開的夥伴各自開一扇視窗，ASN 重開時夥伴不會繼續留著。'
export const TERM_SERVER_RESTART_NOTE = '重開 ASN 後生效。已開著的夥伴不會被搬動，也不會被關掉。'
export const TERM_SERVER_LOCKED_NOTE = '已由系統設定固定，這裡不能改。'

/**
 * 開關底下的說明。
 *   st.termServer：設定頁現在的值；st.termServerActive：這次啟動實際有沒有在用；st.termServerLocked：被系統設定固定關著
 */
export function termServerNote(st) {
  if (!st || typeof st !== 'object') return ''
  if (st.termServerLocked) return `${TERM_SERVER_OFF_NOTE} ${TERM_SERVER_LOCKED_NOTE}`
  const base = `${TERM_SERVER_ON_NOTE} ${TERM_SERVER_OFF_NOTE}`
  // 設定和這次啟動實際在用的不同＝改了還沒生效
  return st.termServer !== st.termServerActive ? `${base} ${TERM_SERVER_RESTART_NOTE}` : base
}
