// 手機版替電腦「安裝並登入 Claude Code」（todo-next-174 的 F，#650）的純邏輯：按鈕與確認字、後台錯誤代碼對應成人話、
// 送出後每 5 秒查一次狀態、狀態對應成畫面上的字。node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文。
// 真正的安裝與登入在電腦上做（要電腦開著「允許從手機替這台安裝並登入」）；登入網址送到這支手機後，會用既有的「要你確認」頁打開，
// 在那裡開啟網址、貼回授權碼，所以這裡不碰網址與授權碼。

export const POLL_MS = 5000
/** 等太久就不再等：後台 10 分鐘沒被電腦接手會自己當作過期；接手後 40 分鐘沒結果也會當作逾時 */
export const GIVE_UP_MS = 45 * 60 * 1000

export const SETUP_TEXT = Object.freeze({
  button: '從手機安裝並登入',
  confirmTitle: label => `要讓「${label}」安裝並登入 Claude Code 嗎？`,
  confirmBody: '這台電腦會安裝官方的 Claude Code，再把登入網址送到這支手機，由你在手機上打開網址、貼回授權碼。已經裝好的不會重裝，已經登入的不會重新登入。',
  confirmNeed: '電腦那邊要先打開「允許從手機替這台安裝並登入」（在那台電腦的設備頁），並且登入著同一個 ASN 帳號；你在電腦前也可以隨時取消。',
  yes: '確認安裝',
  no: '先不要',
  close: '關閉',
  sending: '正在送出要求…',
  pending: '要求已送出，等這台電腦接手',
  taken: '這台電腦已接手，正在安裝並登入。登入網址送到這支手機後會跳出頁面，請打開網址並貼回授權碼。',
  expired: '這台電腦沒有接手，要求已過期；請確認電腦開著 ASN 並打開了「允許從手機替這台安裝並登入」，再試一次。',
  gaveUp: '等太久了，沒有收到結果。請到那台電腦上看看目前的狀況。',
  doneOk: '已完成',
  failed: '沒有完成',
  replaced: '另外',
  unknown: '送不出去，請稍後再試',
})

// 後台錯誤代碼（Rust 端的錯誤字串形如 `setup:asn_outdated`）→ 中文
const ERR = [
  ['unsupported_platform', '手機不能安裝 Claude Code'],
  ['asn_outdated', '那台電腦的 ASN 版本太舊，請先在那台電腦把 ASN 更新後再試'],
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

/** 查到的狀態 → 畫面（done：是否已經結束）。`since` ＝這次要求送出的時間（毫秒），`now` ＝現在 */
export function setupView(st, { since = 0, now = Date.now(), sawRequest = false } = {}) {
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

/** 設備細部頁要不要出現這個按鈕：只有 Claude 區、而且 installAction 說「別台可以裝」（kind 'remote'） */
export const showSetupButton = (vendorKey, action) => vendorKey === 'claude' && action?.kind === 'remote'
