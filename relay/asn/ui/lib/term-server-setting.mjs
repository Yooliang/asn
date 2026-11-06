// 設定頁「夥伴共用同一個終端服務」開關的說明文字（#868）。純函式，方便測試。
// 給使用者看的字：不出現技術名詞（mux、WezTerm、環境變數名），只講「關掉會怎樣」「什麼時候生效」。

export const TERM_SERVER_ON_NOTE = '開著：夥伴共用同一個在背景跑的終端服務，關掉畫面或關掉 ASN，夥伴都會繼續跑。'
export const TERM_SERVER_OFF_NOTE = '關掉：新開的夥伴各自開一扇視窗，ASN 重開時夥伴不會繼續留著。'
export const TERM_SERVER_RESTART_NOTE = '重開 ASN 後生效。已開著的夥伴不會被搬動，也不會被關掉。'
/** Linux：沒裝 WezTerm 就沒有這個開關，改說一句怎麼裝 */
export const TERM_SERVER_MISSING_NOTE = '要讓夥伴共用同一個在背景跑的終端服務，請先用套件管理員安裝 wezterm（例如 sudo apt install wezterm），再重開 ASN。'
export const TERM_SERVER_LOCKED_NOTE = '已由系統設定固定，這裡不能改。'
/** 設定關掉、重開之後，原本的夥伴還在背景跑，ASN 這次不管它們：人數數得出來就寫人數，數不出來也要提示 */
export const termServerBackgroundNote = n => (n > 0
  ? `還有 ${n} 位夥伴在背景跑，這次 ASN 沒有在管它們。要管理它們，請打開這個開關並重開 ASN。`
  : '還有夥伴在背景跑，這次 ASN 沒有在管它們。要管理它們，請打開這個開關並重開 ASN。')

/**
 * 開關底下的說明。
 *   st.termServer：設定頁現在的值；st.termServerActive：這次啟動實際有沒有在用；st.termServerLocked：被系統設定固定關著
 */
export function termServerNote(st) {
  if (!st || typeof st !== 'object') return ''
  if (st.termServerLocked) {
    // 固定關著時開關開不了，不能叫使用者去打開；有夥伴留在背景就只說有幾位、這裡管不到
    const left = st.termServerBackground > 0 ? ` 還有 ${st.termServerBackground} 位夥伴在背景跑，這次 ASN 沒有在管它們。` : st.termServerBackground < 0 ? ' 還有夥伴在背景跑，這次 ASN 沒有在管它們。' : ''
    return `${TERM_SERVER_OFF_NOTE} ${TERM_SERVER_LOCKED_NOTE}${left}`
  }
  // 開關關著（這次也沒在用），而共用服務裡還有夥伴在背景跑：使用者看不到也關不掉，要明說（asn真 #872）
  const bg = !st.termServer && !st.termServerActive && st.termServerBackground !== 0 && st.termServerBackground != null ? ` ${termServerBackgroundNote(st.termServerBackground)}` : ''
  const base = `${TERM_SERVER_ON_NOTE} ${TERM_SERVER_OFF_NOTE}`
  // 設定和這次啟動實際在用的不同＝改了還沒生效
  return (st.termServer !== st.termServerActive ? `${base} ${TERM_SERVER_RESTART_NOTE}` : base) + bg
}
