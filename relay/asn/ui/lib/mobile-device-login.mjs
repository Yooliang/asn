// 手機替電腦登入裝置碼型 CLI（#933 PR-5b，先做 Codex）的純邏輯：按鈕與確認字、狀態對應成畫面、倒數。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文。
// 網址與代碼只在顯示階段拿在記憶體：不寫進對話、不進通知、不存檔、不提供複製；離開畫面、App 進背景、到期就清掉。
import { setupErrorText } from './mobile-setup.mjs'
import { loginLinkHost } from './secret-ask.mjs'

/** 入口還沒開（電腦端與後台要一起放行，入口在之後的 PR 打開） */
export const DEVICE_LOGIN_UI = false
export const POLL_MS = 3000
export const VENDORS = Object.freeze({ codex: 'Codex' })
/** 各家登入頁的主機（完全相等才收）：網址交給畫面之前，除了共同規則（https、ASCII、沒帳密、埠 443、官方網域）還要是這一家的 */
export const VENDOR_HOSTS = Object.freeze({ codex: Object.freeze(['auth.openai.com']) })

/** 網址能不能綁到連結上：只收 https、可見 ASCII、沒有帳密、埠只能 443、主機在這一家的清單裡。vendor 沒給＝只套共同規則 */
export function safeLoginUrl(url, vendor) {
  const host = loginLinkHost(url)
  if (host === null) return ''
  if (vendor !== undefined && !(VENDOR_HOSTS[vendor] ?? []).includes(host)) return ''
  return url
}

export const LOGIN_TEXT = Object.freeze({
  button: name => `從手機替這台登入 ${name}`,
  confirmTitle: (label, name) => `要讓「${label}」登入 ${name} 嗎？`,
  confirmBody: name => `這台電腦會開始登入 ${name}，登入網址和代碼會加密送到這支手機，由你在手機上打開網址、輸入代碼並核准。`,
  confirmNeed: '那台電腦要先在設定的「認得的電腦」裡，勾選這支手機的「允許替這台登入」，並且登入著同一個 ASN 帳號；你在電腦前也可以隨時取消。',
  yes: '開始登入',
  no: '先不要',
  close: '關閉',
  sending: '正在送出要求…',
  waiting: '要求已送出，等這台電腦接手',
  taken: '這台電腦已接手，正在取得登入代碼',
  already: '這台電腦已經有一個安裝或登入正在進行，這次沒有送出。等它結束再試。',
  forWhom: (label, name) => `這是給「${label}」的 ${name} 登入`,
  open: '開啟登入頁',
  howTo: '在登入頁輸入下面的代碼並核准。代碼請用看的輸入，這裡不提供複製。',
  left: s => `剩下 ${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`,
  expired: '要求或代碼已經過期，請重新發起。',
  delivered: '這筆登入代碼已經被取走了（可能是你的另一台設備），請重新發起。',
  untrusted: '這支手機還沒有確認過這台電腦的指紋。請先在這支手機看一次那台的終端，照畫面確認指紋。',
  badUrl: '登入網址不對，沒有顯示',
  bad: '收到的內容驗不過，沒有顯示。請重新發起；如果一直這樣，請告訴開發團隊。',
  gone: '這筆要求已經不在這支手機上了，請重新發起。',
  doneOk: '已完成',
  failed: '沒有完成',
})

export const loginErrorText = e => setupErrorText(e)

/** 設備細部頁要不要出現這個按鈕：入口開了、是支援的種類、對象是別台電腦（installAction 是 remote） */
export const showLoginButton = (vendorKey, action, enabled = DEVICE_LOGIN_UI) => enabled === true && Object.hasOwn(VENDORS, vendorKey) && action?.kind === 'remote'

/** setup_device_request 的回應 → 下一步 */
export function requestView(r) {
  if (r?.already === true) return { stage: 'done', ok: false, text: LOGIN_TEXT.already }
  if (typeof r?.rid === 'string' && r.rid) return { stage: 'waiting', rid: r.rid, text: LOGIN_TEXT.waiting }
  return { stage: 'done', ok: false, text: setupErrorText('') }
}

/** setup_device_fetch 的回應 → 畫面。ready 才帶網址與代碼（只給畫面顯示）；網址不合格就當純文字說明，不給連結。vendor＝這次登入的種類 */
export function fetchView(r, vendor) {
  switch (r?.state) {
    case 'waiting': {
      const status = r.status
      if (status === 'done' || status === 'failed') {
        const detail = String(r.detail ?? '').slice(0, 300)
        return { stage: 'done', ok: status === 'done', text: detail || (status === 'done' ? LOGIN_TEXT.doneOk : LOGIN_TEXT.failed) }
      }
      return { stage: 'waiting', text: status === 'taken' ? LOGIN_TEXT.taken : LOGIN_TEXT.waiting }
    }
    case 'ready': {
      const url = safeLoginUrl(typeof r.url === 'string' ? r.url : '', vendor)
      const code = typeof r.code === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(r.code) ? r.code : ''
      const exp = Number.isFinite(r.code_exp) ? r.code_exp : 0
      if (!url) return { stage: 'done', ok: false, text: LOGIN_TEXT.badUrl }
      if (!code || !exp) return { stage: 'done', ok: false, text: LOGIN_TEXT.bad }
      return { stage: 'show', url, code, exp, name: String(r.name ?? '').slice(0, 80) }
    }
    case 'expired': return { stage: 'done', ok: false, text: LOGIN_TEXT.expired }
    case 'delivered': return { stage: 'done', ok: false, text: LOGIN_TEXT.delivered }
    case 'bad_url': return { stage: 'done', ok: false, text: LOGIN_TEXT.badUrl }
    case 'untrusted': return { stage: 'done', ok: false, text: LOGIN_TEXT.untrusted }
    case 'gone': return { stage: 'done', ok: false, text: LOGIN_TEXT.gone }
    default: return { stage: 'done', ok: false, text: LOGIN_TEXT.bad }
  }
}

/** 剩幾秒（用電腦簽過的代碼到期時間；過期回 0） */
export const secondsLeft = (exp, nowMs = Date.now()) => Math.max(0, Math.floor(exp - nowMs / 1000))
