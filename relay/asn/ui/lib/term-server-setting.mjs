// 設定頁「夥伴共用同一個終端服務」開關的說明文字（#868）。純函式，方便測試。
// 給使用者看的字：不出現技術名詞（mux、WezTerm、環境變數名），只講「關掉會怎樣」「什麼時候生效」。

export const TERM_SERVER_ON_NOTE = '開著：夥伴共用同一個在背景跑的終端服務，關掉畫面或關掉 ASN，夥伴都會繼續跑。'
export const TERM_SERVER_OFF_NOTE = '關掉：新開的夥伴各自開一扇視窗，ASN 重開時夥伴不會繼續留著。'
export const TERM_SERVER_RESTART_NOTE = '重開 ASN 後生效。已開著的夥伴不會被搬動，也不會被關掉。'
/** 登入資料和設備金鑰怎麼保護（Windows 不顯示）：用「系統金鑰庫」這個說法，不寫技術名稱 */
export const KEY_PROTECTION_NOTE = {
  keyring: '這台的登入資料和設備金鑰由系統金鑰庫保護。',
  file_only: '這台沒有系統金鑰庫，登入資料只靠檔案權限保護；別台電腦也不能看這台的畫面。',
}
export const keyProtectionNote = v => KEY_PROTECTION_NOTE[v] ?? ''

/**
 * Linux：開關打開後，ASN 會自己去取終端程式。取得中、失敗各有一句給使用者看的話；
 * 網址、雜湊、錯誤碼只寫進 log，這裡不出現。失敗的原因分類（network／disk／mismatch／unsupported／unrunnable／other）各一句，
 * 後兩類重試也沒用，不給「重試」。
 */
export const TERM_FETCH_FETCHING_NOTE = '正在取得終端程式，請稍候。取得後重開 ASN 就會生效。'
export const TERM_FETCH_FAIL_NOTES = {
  network: '終端程式取得失敗：網路連不上或太慢，請確認網路後按重試。',
  disk: '終端程式取得失敗：磁碟空間不夠，請清出空間後按重試。',
  mismatch: '終端程式取得失敗：下載的檔案不完整或不對，請稍後按重試；一直不行的話，請改用套件管理員安裝 wezterm 後重開 ASN。',
  unsupported: '這台 Linux 還不支援自動取得終端程式，請用套件管理員安裝 wezterm 後重開 ASN。',
  unrunnable: '終端程式取得了，但在這台電腦跑不起來（可能缺少系統元件），請用套件管理員安裝 wezterm 後重開 ASN。',
  other: '終端程式取得失敗，請稍後按重試。',
}
/** 這幾類按「重試」可能有用 */
export const TERM_FETCH_RETRYABLE = ['network', 'disk', 'mismatch', 'other']
/** 缺少的系統函式庫名（後端已過濾；這裡再擋一次，不合格式就當沒有，怪字不能進畫面）：英數開頭、只含英數與 . _ + -、最長 40 字元 */
export const safeLibName = v => (typeof v === 'string' && v.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(v) ? v : '')
/** 跑不起來而且知道缺哪個函式庫：點名，裝好後按重試有機會成功 */
export const termFetchMissingLibNote = lib => `終端程式取得失敗：缺少系統函式庫 ${lib}，請用套件管理員安裝後按重試。`
/** 開關底下的取得狀態：回 { text, canRetry }。開關關著、或沒事就是空字串 */
export function termFetchLine(st) {
  const none = { text: '', canRetry: false }
  if (!st || typeof st !== 'object' || st.termServer !== true) return none
  if (st.termFetch === 'fetching') return { text: TERM_FETCH_FETCHING_NOTE, canRetry: false }
  if (st.termFetch === 'failed') {
    const kind = Object.hasOwn(TERM_FETCH_FAIL_NOTES, st.termFetchKind) ? st.termFetchKind : 'other'
    const lib = kind === 'unrunnable' ? safeLibName(st.termFetchDetail) : ''
    if (lib) return { text: termFetchMissingLibNote(lib), canRetry: true }
    return { text: TERM_FETCH_FAIL_NOTES[kind], canRetry: TERM_FETCH_RETRYABLE.includes(kind) }
  }
  return none
}

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

// 這次 ASN 的啟動方式會讓夥伴跟著一起關閉，所以夥伴改開在一般視窗時，告訴使用者怎麼恢復（不出現工作群組、旗標這些字）
export const TERM_SERVER_WHY_HINT = '從開始選單或桌面捷徑重新開啟 ASN，通常就能回到共用的終端服務。'
// 設定頁那一行（西川二審）：開關關著就不講（使用者自己關的，原因已不相干）；原因本身已經教了怎麼重開，就不再重複提示
export const termServerWhyLine = b => {
  const why = typeof b?.termServerWhy === 'string' ? b.termServerWhy.trim() : ''
  if (!why || b?.termServer !== true) return ''
  return why.includes('重開') ? `${why}。` : `${why}。${TERM_SERVER_WHY_HINT}`
}
