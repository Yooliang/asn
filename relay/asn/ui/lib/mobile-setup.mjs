// 手機版替電腦「安裝並登入 Claude Code」（todo-next-174 的 F，#650）的純邏輯：按鈕與確認字、後台錯誤代碼對應成人話、
// 送出後每 5 秒查一次狀態、狀態對應成畫面上的字。node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文。
// 真正的安裝與登入在電腦上做（要電腦開著「允許從手機替這台安裝並登入」）；登入網址送到這支手機後，會用既有的「要你確認」頁打開，
// 在那裡開啟網址、貼回授權碼，所以這裡不碰網址與授權碼。
export const POLL_MS = 5000
/** 等太久就不再等：後台 10 分鐘沒被電腦接手會自己當作過期；接手後 40 分鐘沒結果也會當作逾時 */
export const GIVE_UP_MS = 45 * 60 * 1000
/** 送出後這麼久還沒進到 taken／done／failed，就告訴本人那台電腦沒有回應（#1592）。
 *  電腦是跟著在線回報（預設每 60 秒，lib.rs 的 ASN_PRESENCE_MS）才來取請求的，中間沒有東西會叫醒它，所以要大於一個回報週期加餘裕；測試鎖住這個關係 */
export const PENDING_WAIT_MS = 90 * 1000
/** 查狀態連續失敗幾次就告訴本人，不再靜默吞掉（#1592） */
export const POLL_FAIL_MAX = 3

export const SETUP_TEXT = Object.freeze({
  button: '從手機安裝並登入',
  confirmTitle: label => `要讓「${label}」安裝並登入 Claude Code 嗎？`,
  confirmBody: '這台電腦會安裝官方的 Claude Code，再把登入網址送到這支手機，由你在手機上打開網址、貼回授權碼。已經裝好的不會重裝，已經登入的不會重新登入。',
  confirmNeed: '電腦那邊要先打開「允許從手機替這台安裝並登入」（在那台電腦的設備頁），並且登入著同一個 ASN 帳號；你在電腦前也可以隨時取消。',
  yes: '確認安裝',
  no: '先不要',
  close: '關閉',
  sending: '正在送出要求…',
  pending: '要求已送出，等這台電腦來取（最多約 1 分鐘）',
  taken: '這台電腦已接手，正在安裝並登入。登入網址送到這支手機後會跳出頁面，請打開網址並貼回授權碼。',
  expired: '這台電腦沒有接手，要求已過期；請確認電腦開著 ASN 並打開了「允許從手機替這台安裝並登入」，再試一次。',
  gaveUp: '等太久了，沒有收到結果。請到那台電腦上看看目前的狀況。',
  doneOk: '已完成',
  failed: '沒有完成',
  replaced: '另外',
  unknown: '送不出去，請稍後再試',
  noReply: '這台電腦沒有回應，請確認它的 ASN 開著，稍後再試',
  pollFail: '暫時讀不到狀態，請稍後再試',
  already: '這台電腦已經有一個進行中的要求',
})

// 從手機要別台「重新登入 Claude」（#1512 C、#1592）：送的是同一種要求，加上 mode 'relogin'。
// 重新登入不受「允許從手機安裝並登入」限制，那台電腦改確認是本人（登入著同一個 ASN 帳號）；它只重新登入，不會安裝或更新任何東西，
// 所以 Claude Code 要先裝好。要不要真的重新登入由那台電腦決定：看起來登入正常、本機也沒有失效的證據，就只回報不需要重新登入
export const RELOGIN_TEXT = Object.freeze({
  button: '重新登入 Claude',
  confirmTitle: label => `要讓「${label}」重新登入 Claude 嗎？`,
  confirmBody: '這台電腦回報 Claude 的登入失效了。確認後，那台電腦會把登入網址送到這支手機，由你在手機上打開網址、貼回授權碼。如果那台目前登入正常，會告訴你不需要重新登入。',
  confirmNeed: '那台電腦要開著 ASN、登入著同一個 ASN 帳號，而且已經裝好 Claude Code（重新登入不會替它安裝）；你在電腦前也可以隨時取消。',
  yes: '確認重新登入',
})

// 後台錯誤代碼（Rust 端的錯誤字串形如 `setup:asn_outdated`）→ 中文
const ERR = [
  ['unsupported_platform', '手機不能安裝 Claude Code'],
  ['asn_outdated', '那台電腦的 ASN 版本太舊，請先在那台電腦更新 ASN'],
  ['asn_offline', '那台電腦的 ASN 目前沒有開著，等它上線再試'],
  ['rate_limited', '要求太頻繁了，請稍候幾分鐘再試'],
  ['not_found', '找不到這台設備（它不在你的帳號底下）'],
  ['unauthorized', '請先登入 ASN 帳號'],
  ['尚未登入', '請先登入 ASN 帳號'],
]
export function setupErrorText(e) {
  const s = String(e?.message ?? e ?? '')
  for (const [k, t] of ERR) if (s.includes(k)) return t
  // 連不上之類沒有代碼的錯誤，Rust 端已經是人話
  return /^[一-鿿]/.test(s) && s.length <= 60 ? s : SETUP_TEXT.unknown
}

/** 這台設備的請求狀態項目（node_setup_status 的 nodes 之一）→ 畫面上的狀態；沒有請求是 null */
export function setupStateOf(nodes, node) {
  const row = Array.isArray(nodes) ? nodes.find(n => n && n.id === node) : null
  const st = row?.setup
  if (!st || typeof st !== 'object') return null
  const state = ['pending', 'taken', 'done', 'failed'].includes(st.state) ? st.state : null
  return state ? { state, detail: String(st.detail ?? '').slice(0, 300), replaced: String(st.replaced ?? '').slice(0, 300) } : null
}

/** 查到的狀態 → 畫面（done：是否已經結束）。`since` ＝這次要求送出的時間（毫秒），`now` ＝現在；
 *  `reached` ＝曾經看到 taken／done／failed（電腦有接手）。沒接手、而且送出已超過 PENDING_WAIT_MS，就說電腦沒有回應 */
export function setupView(st, { since = 0, now = Date.now(), sawRequest = false, reached = false } = {}) {
  if (!reached && (!st || st.state === 'pending') && since && now - since > PENDING_WAIT_MS) return { done: true, ok: false, text: SETUP_TEXT.noReply, note: '' }
  if (!st) {
    // 查不到：剛送出一下下還沒寫進去就繼續等；曾經看過它、後來不見了＝過期了
    return sawRequest ? { done: true, ok: false, text: SETUP_TEXT.expired, note: '' } : { done: false, ok: false, text: SETUP_TEXT.pending, note: '' }
  }
  if (st.state === 'pending') return { done: false, ok: false, text: SETUP_TEXT.pending, note: '' }
  if (st.state === 'taken') {
    if (since && now - since > GIVE_UP_MS) return { done: true, ok: false, text: SETUP_TEXT.gaveUp, note: '' }
    return { done: false, ok: false, text: SETUP_TEXT.taken, note: '' }
  }
  const text = st.detail || (st.state === 'done' ? SETUP_TEXT.doneOk : SETUP_TEXT.failed)
  return { done: true, ok: st.state === 'done', text, note: st.replaced }
}

/** 每輪查狀態的一步（純函式，m.js 只負責呼叫與套用）。`s` ＝ { since, saw, reached, fails }；`res` ＝ { ok: false }（這輪查不到）或 { ok: true, st }。
 *  連續 POLL_FAIL_MAX 輪查不到就結束並說「暫時讀不到狀態」；查到就清掉失敗次數。view 是 null ＝這輪畫面不變 */
export function setupStep(s, res, now = Date.now()) {
  if (!res?.ok) {
    const fails = (s.fails || 0) + 1
    return { next: { ...s, fails }, view: fails >= POLL_FAIL_MAX ? { done: true, ok: false, text: SETUP_TEXT.pollFail, note: '' } : null }
  }
  const st = res.st ?? null
  const next = { ...s, fails: 0, saw: !!s.saw || !!st, reached: !!s.reached || (!!st && st.state !== 'pending') }
  return { next, view: setupView(st, { since: s.since, now, sawRequest: next.saw, reached: next.reached }) }
}

/** 送出要求後的回應 → 畫面要先說的話：後台說這台已經有進行中的要求（already）時明說，再顯示它的狀態 */
export const setupLeadOf = res => (res?.already === true ? SETUP_TEXT.already : '')
