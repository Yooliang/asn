// 網頁核准頁的純邏輯（不碰畫面、不碰網路，node 也能載入測試）。
// 規矩：不寫 console；憑證只出現在請求標頭；短碼以外的東西不進網址。
import { AUTH_BASE, RELAY_URL, SITE_ORIGIN, ANON_KEY } from './config.mjs'

const ALPHABET_RE = /^[A-HJ-NP-Z2-9]{8}$/
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const PROVIDERS = ['google', 'github']

// 短碼正規化（同後台 normalizeUserCode）：不分大小寫，容忍空白與連字號；不合格回 null
export function normalizeUserCode(v) {
  if (typeof v !== 'string') return null
  const raw = v.toUpperCase().replace(/[\s-]+/g, '')
  return ALPHABET_RE.test(raw) ? raw.slice(0, 4) + '-' + raw.slice(4) : null
}

export function parseUserCode(search) {
  return normalizeUserCode(new URLSearchParams(search).get('code') ?? '')
}

// 網址分類：短碼進站、登入完成回來（授權碼＋state）、供應商回報失敗、什麼都沒有
export function classifyReturn(search) {
  const q = new URLSearchParams(search)
  const code = q.get('code') ?? ''
  const state = q.get('state') ?? ''
  if (q.get('error') && state) return { kind: 'oauth_error' }
  const uc = normalizeUserCode(code)
  if (uc) return { kind: 'code', userCode: uc }
  if (code && state) return { kind: 'oauth', authCode: code, state }
  return { kind: 'none' }
}

const TEXTS = {
  invalid_code: '短碼不對，或已經過期（15 分鐘有效）。請看主機上顯示的短碼，確認後再試一次',
  rate_limited: '輸錯太多次了，這個帳號請 15 分鐘後再試',
  id_taken: '這個節點代號已經有人用了，請換一個',
  bad_id_prefix: '節點代號的開頭不符合這個帳號的規則，請留空讓系統自動取，或改用帳號指定的開頭',
  too_many: '節點（電腦、雲端代理、無畫面主機）已達上限，請先到 ASN 撤銷用不到的',
  tenant_inactive: '這個帳號目前停用中',
  unauthorized: '還沒登入或登入已失效，請重新登入',
  bad_request: '送出的內容不合格，請檢查短碼與名字',
  internal: '伺服器暫時有問題，請稍後再試',
  network: '連不上伺服器，請檢查網路後再試',
}
export function errorText(code) {
  return TEXTS[code] ?? '沒有成功，請稍後再試'
}
export const isLoginProblem = code => code === 'unauthorized'

const hasControl = s => /[\u0000-\u001f\u007f-\u009f]/.test(s)

// 核准請求：憑證只放標頭；網址與內容只有短碼、名字、可選代號。不合格回 { error }
export function buildApproveRequest({ token, userCode, name, nodeId }) {
  if (!token) return { error: '請先登入' }
  const uc = normalizeUserCode(userCode)
  if (!uc) return { error: '請輸入主機上顯示的 8 碼短碼（例如 ABCD-2345）' }
  const nm = String(name ?? '').trim()
  const n = [...nm].length
  if (n < 1 || n > 40 || hasControl(nm)) return { error: '請輸入這台主機的名字（1 到 40 個字）' }
  const id = String(nodeId ?? '').trim()
  if (id && !NODE_ID_RE.test(id)) return { error: '節點代號只能用英文、數字、-、_，最多 32 個字' }
  const body = { user_code: uc, name: nm }
  if (id) body.node_id = id
  return {
    url: `${RELAY_URL}?action=device_code_approve`,
    init: { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  }
}

// 後台回應 → { ok, id, name } 或 { ok:false, code, text }。status 0＝連不上
export function readApproveReply(status, body) {
  if (status === 0) return { ok: false, code: 'network', text: errorText('network') }
  if (status === 200 && body && typeof body.id === 'string' && body.id) return { ok: true, id: body.id, name: typeof body.name === 'string' ? body.name : '' }
  const code = typeof body?.error === 'string' ? body.error : status === 401 ? 'unauthorized' : status >= 500 ? 'internal' : status === 200 ? 'internal' : ''
  return { ok: false, code, text: errorText(code) }
}

// ---------- 登入（Supabase OAuth，PKCE） ----------

const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)))
export const newVerifier = () => rand(32)
export const newState = () => rand(16)
export async function challengeOf(verifier) {
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

// 登入完成導回的網址：不含短碼（短碼放在本頁的暫存裡）
export const redirectTo = state => `${SITE_ORIGIN}/link/?state=${state}`

export function buildAuthorizeUrl({ provider, state, challenge }) {
  if (!PROVIDERS.includes(provider)) return null
  return `${AUTH_BASE}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectTo(state))}&code_challenge=${challenge}&code_challenge_method=s256`
}

export function buildTokenRequest({ authCode, verifier }) {
  return {
    url: `${AUTH_BASE}/auth/v1/token?grant_type=pkce`,
    init: { method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ auth_code: authCode, code_verifier: verifier }) },
  }
}

export function tokenFromReply(status, body) {
  const t = body?.access_token
  return status === 200 && typeof t === 'string' && t ? t : null
}

// 常數時間比較
function same(a, b) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// 登入回來：暫存的驗證碼與 state 都要在，且 state 相符
export function checkReturn(stash, state) {
  if (!stash || !stash.v || !stash.s || !state) return { ok: false }
  return same(String(stash.s), String(state)) ? { ok: true } : { ok: false }
}
