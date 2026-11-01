// 手機上確認「別台電腦／雲端代理要密碼」的請求（#26 第二期，設計見 docs/design/SECRET-REMOTE.md）的畫面邏輯。
// 密碼只存在畫面的輸入欄與 invoke 的參數：不寫瀏覽器儲存、不放網址、不印出來。加密在 Rust 端（android_secret_reply），這裡不碰任何金鑰。

export const POLL_MS = 30_000
export const SECRET_MAX_BYTES = 1024

// 後台的錯誤代碼（Rust 端的錯誤字串形如「secret_reply HTTP 410 expired」）→ 中文
const ERR = [
  ['expired', '這筆請求已經過期了'],
  ['already_answered', '這筆請求已經有人回覆過了'],
  ['not_found', '這筆請求已經結束（過期或已處理）'],
  ['forbidden', '只有你本人登入的設備能確認'],
  ['unauthorized', '請先登入再確認'],
  ['尚未登入', '請先登入再確認'],
  ['已經結束', '這筆請求已經結束（過期或已處理）'],
  ['bad_cipher', '送出的內容格式不對，請再試一次'],
]
export function errorText(e) {
  const s = String(e?.message ?? e ?? '')
  for (const [k, t] of ERR) if (s.includes(k)) return t
  return '送出失敗，請稍後再試'
}

// 登入網址（#628）：請求可以附一個官方登入頁的網址，讓本人在手機上打開、授權、把授權碼貼回。
// 不信 Rust 端或後台回來的內容，這裡再驗一次（與 Rust 的 secret_remote/link.rs、資料庫約束、Edge Function 同一條規則）：
// 只收 https；主機是官方登入網域本身或其子網域；埠只能 443；不能帶帳號密碼；整串只許可見 ASCII 且沒有反斜線。
export const LOGIN_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com']
export function loginLinkHost(url) {
  if (typeof url !== 'string' || url.length < 12 || url.length > 2048) return null
  if (!url.startsWith('https://')) return null
  for (let i = 0; i < url.length; i++) { const c = url.charCodeAt(i); if (c < 0x21 || c > 0x7e || c === 0x5c) return null }
  const rest = url.slice('https://'.length)
  const end = rest.search(/[/?#]/)
  const authority = end < 0 ? rest : rest.slice(0, end)
  if (!authority || authority.includes('@')) return null
  let host = authority
  const colon = authority.indexOf(':')
  if (colon >= 0) { if (authority.slice(colon + 1) !== '443') return null; host = authority.slice(0, colon) }
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  const ok = LOGIN_HOSTS.some(h => host === h || (host.endsWith('.' + h) && !host.startsWith('.') && !host.slice(0, -h.length).includes('..')))
  return ok ? host : null
}

// Rust 端已清理過文字；這裡只收需要的欄位與型別，其餘丟掉。
// 有附網址但不是官方登入網域：整筆不顯示（寧可不顯示，也不讓本人點到不明網址）
export function normalizeList(raw) {
  const list = Array.isArray(raw?.requests) ? raw.requests : []
  return list
    .filter(r => r && typeof r.id === 'string' && typeof r.fingerprint === 'string')
    .filter(r => r.link == null || loginLinkHost(r.link) !== null)
    .map(r => ({
      id: r.id,
      nodeName: String(r.node_name ?? ''),
      program: String(r.program ?? ''),
      purpose: String(r.purpose ?? ''),
      fingerprint: r.fingerprint,
      // 打開登入頁的網址與畫面上顯示的網域（只顯示網域，網址的其他部分不顯示）
      link: r.link == null ? '' : r.link,
      linkHost: r.link == null ? '' : loginLinkHost(r.link),
      secondsLeft: Number.isFinite(r.seconds_left) ? Math.max(0, Math.floor(r.seconds_left)) : 0,
    }))
    .filter(r => r.secondsLeft > 0)
}

// 下一筆要問本人的：跳過「先不處理」的
export const nextToAsk = (list, dismissed) => list.find(r => !dismissed.has(r.id)) ?? null

export function countdownText(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `剩 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// 密碼不能是空的、不能超過上限（以位元組算，與 Rust 端同一條）
export function secretError(s) {
  if (!s) return '請輸入密碼'
  if (new TextEncoder().encode(s).length > SECRET_MAX_BYTES) return `密碼太長（最多 ${SECRET_MAX_BYTES} 位元組）`
  return ''
}

// 畫面上的標題與提示（全中文）
export const TEXT = {
  title: '有程式在向你要密碼',
  lead: '請確認是你要的，再輸入密碼。密碼會在這支手機上加密後才送出，中間經過的伺服器看不到。',
  deviceLabel: '哪台電腦',
  programLabel: '哪個程式（對方自報）',
  purposeLabel: '要做什麼（對方自報）',
  fpLabel: '核對碼',
  fpNote: '若請求端畫面也顯示同一組核對碼，才表示是同一個請求。',
  linkLabel: '登入頁的網域',
  openLink: '開啟登入頁',
  linkLead: '這台電腦正在登入。請先開啟登入頁、完成授權，再把頁面上顯示的授權碼貼到下面。',
  codeLabel: '授權碼',
  inputLabel: '密碼',
  ok: '送出',
  deny: '拒絕',
  later: '先不處理',
}
