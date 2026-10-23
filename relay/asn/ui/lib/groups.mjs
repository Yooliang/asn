// 真人好友與群組（第 1b 期，介面）的純邏輯：邀請碼與連結、錯誤文字、可帶進群組的夥伴、邀請預覽、發言者標示（同名加「（2）」）、
// 附件鈕、主持人確認卡片、成員管理清單、後台動作的呼叫包裝。電腦版與手機版共用。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文；一律不顯示節點代號、視窗成員鍵與 x: 代號。
import { isAsnWindow, isRelayRoom } from './roster.mjs'

export const SEED_DEFAULT = 40            // 一對一升級成群組時，複製最後幾則當開頭紀錄（預設）
export const SEED_MAX = 50
export const GROUP_NAME_MAX = 60
export const INVITE_BASE = 'https://asnmessenger.web.app/i/'
export const INVITE_NOTE = '一次性、24 小時內有效。'
export const PRIVACY_NOTE = '群組內的人與他們的 AI 都看得到你在群組說的話。'
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/

// ---------- 邀請碼與連結 ----------
export const inviteLink = code => `${INVITE_BASE}${code}`
export const inviteAsnLink = code => `asn://invite/${code}`
// 使用者貼上的東西（邀請碼、https 連結、asn:// 連結）→ 邀請碼；認不得回空字串
export function parseInviteInput(text) {
  const t = String(text ?? '').trim()
  if (INVITE_CODE_RE.test(t)) return t
  const m = /^(?:asn:\/\/invite\/|https:\/\/asnmessenger\.web\.app\/i\/)([A-Za-z0-9_-]{16,64})(?:[/?#].*)?$/i.exec(t)
  return m ? m[1] : ''
}

// ---------- 錯誤文字（後台代碼、Rust 的訊息 → 中文，不外洩代碼） ----------
const ERR = {
  unauthorized: '請先登入，才能使用群組。',
  forbidden: '這個動作只有使用者本人能做。',
  not_member: '你不在這個群組裡。',
  not_found: '找不到（可能已被移除）。',
  bad_request: '資料格式不對。',
  bad_member: '只能帶自己名下、已上線的夥伴進群組。',
  bad_kind: '不認得的危險操作類別。',
  id_taken: '群組代號重複，請再試一次。',
  room_limit: '你建立或參加的群組已達上限。',
  member_limit: '群組人數已達上限。',
  rate_limited: '操作太頻繁，稍後再試。',
  invalid_invite: '邀請碼不正確。',
  invite_used: '這個邀請已經被使用過了。',
  invite_expired: '這個邀請已過期（只有 24 小時），請邀請人再產生一個。',
  invite_revoked: '這個邀請已被撤銷。',
  own_invite: '不能接受自己發出的邀請。',
  already_member: '你已經在這個群組裡了。',
  no_account: '請先登入 ASN 並建立帳號。',
  host_must_transfer: '你是主持人，群組裡還有其他真人，請先請他們離開或封存群組。',
  already_decided: '這個請求已經處理過了。',
  expired: '這個請求已過期。',
  no_host: '這個群組找不到主持人。',
  external_no_attachments: '這個群組有外部成員，暫不支援附件。',
  internal: '伺服器發生錯誤，晚點再試。',
}
const HTTP_STATUS = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 410: 'invite_expired', 429: 'rate_limited' }
export function groupErrorText(raw) {
  const s = String(raw ?? '')
  for (const code of Object.keys(ERR)) if (new RegExp(`\\b${code}\\b`).test(s)) return ERR[code]
  if (/尚未登入/.test(s)) return ERR.unauthorized
  if (/連線失敗|timeout|逾時/.test(s)) return '連不上收發室，請檢查網路。'
  const h = /HTTP (\d{3})/.exec(s)
  if (h && HTTP_STATUS[h[1]]) return ERR[HTTP_STATUS[h[1]]]
  // Rust 端自己整理的中文格式錯誤（沒有代碼、沒有 HTTP）可以直接給人看
  if (/[一-鿿]/.test(s) && !/HTTP|_/.test(s) && s.length <= 60) return s
  return '群組操作失敗，晚點再試。'
}

// ---------- 可帶進群組的夥伴（只限自己名下的 AI 視窗） ----------
const SEP = '~'
export const windowKeyOf = f => (f && typeof f.node === 'string' && f.node && typeof f.agent === 'string' && f.agent && !f.node.includes(SEP) && !f.agent.includes(SEP) ? `${f.node}${SEP}${f.agent}` : '')
const STATUS_RANK = { online: 0, busy: 1, away: 2, offline: 3 }
export function aiChoices(friends) {
  const out = []
  for (const f of Array.isArray(friends) ? friends : []) {
    if (!f || f.room || f.pending || String(f.id ?? '').startsWith('pending:') || isAsnWindow(f) || isRelayRoom(f.agent)) continue
    const key = windowKeyOf(f)
    if (!key) continue
    out.push({ key, label: String(f.nick || f.agent), device: String(f.device ?? ''), status: f.status || 'offline' })
  }
  return out.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.label.localeCompare(b.label, 'zh-Hant'))
}
// 這位夥伴的一對一對話能不能「邀請別人加入」（要有節點與視窗名，不是群組、不是 ASN 程式本身）
export const canInviteFrom = f => Boolean(f && !f.room && windowKeyOf(f) && !isAsnWindow(f) && !String(f.id ?? '').startsWith('pending:'))

// ---------- 建群組 ----------
export function createError(name, picks) {
  const n = String(name ?? '').trim()
  if (!n) return '請先幫群組取個名字。'
  if ([...n].length > GROUP_NAME_MAX) return `名字太長，最多 ${GROUP_NAME_MAX} 字。`
  if ((picks ?? []).length > 20) return '一次最多帶 20 位夥伴。'
  return ''
}
export const buildCreate = (name, picks) => ({ name: String(name ?? '').trim(), ai: [...new Set(picks ?? [])] })

// ---------- 邀請 ----------
export const clampSeed = v => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), SEED_MAX) : SEED_DEFAULT
}
const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return [...t].length > n ? `${[...t].slice(0, n).join('')}…` : t
}
// 一對一升級時，對方會看到的開頭紀錄預覽：取本機這段對話最後 n 則（系統提示不算）。回 [{ who, text, t }]
export function seedPreview(log, friendName, n) {
  const count = clampSeed(n)
  const rows = (Array.isArray(log) ? log : []).filter(m => m && m.k !== 'sys' && String(m.text ?? '').trim())
  return rows.slice(Math.max(0, rows.length - count)).map(m => ({ who: m.k === 'me' ? '我' : String(m.who || friendName || '夥伴'), text: oneLine(m.text, 120), t: Number(m.t) || 0 }))
}
// 邀請對話框的說明（預覽前的確認）：一對一＝對方會看到最後 N 則；群組＝只看得到加入之後的新訊息
export function inviteLead(target, n) {
  if (target?.type === 'room') return '對方加入後，只看得到加入之後的新訊息，看不到加入前的紀錄。'
  const c = clampSeed(n)
  return c === 0 ? '新群組不會複製這段對話的任何內容，對方從空白開始。' : `對方會看到這段對話最近 ${c} 則（下面是預覽）。原本的一對一對話不會被動到，更早的內容也不會搬過去。`
}
export function inviteBody(target, seed) {
  if (target?.type === 'room') return { kind: 'room', room: target.roomId }
  const f = target?.friend
  return { kind: 'conversation', node: f?.node, agent: f?.agent, seed: clampSeed(seed) }
}
// 後台回的邀請 → 畫面要的樣子（連結、碼、備註）
export function inviteView(res) {
  const code = String(res?.code ?? '')
  return { id: String(res?.id ?? ''), code, link: res?.link ? String(res.link) : inviteLink(code), note: INVITE_NOTE, expiresAt: Date.parse(res?.expires_at) || 0 }
}
// 邀請預覽（接受前）：只有群組名與邀請人，不顯示成員與內容
export function previewView(p) {
  const room = p?.kind === 'room'
  return {
    kind: room ? 'room' : 'conversation',
    title: room ? String(p?.room_name || '群組') : '新群組',
    inviter: String(p?.inviter_name || '對方'),
    lead: room
      ? `${p?.inviter_name || '對方'} 邀請你加入群組「${p?.room_name || '群組'}」。加入後只看得到之後的新訊息。`
      : `${p?.inviter_name || '對方'} 邀請你加入一個新群組。${Number.isInteger(p?.seed_count) && p.seed_count > 0 ? `你會看到他與 AI 夥伴最近 ${p.seed_count} 則對話當作開頭。` : '你會從空白的新群組開始。'}`,
    seed: Number.isInteger(p?.seed_count) ? p.seed_count : 0,
    expiresAt: Date.parse(p?.expires_at) || 0,
  }
}

// ---------- 發言者標示 ----------
const baseLabel = m => String(m?.from_label || m?.label || m?.from_name || m?.name || '').trim()
// 成員與訊息裡的每個發言者（以 from／key 區分）→ 顯示標示。同一個標示出現在不同發言者身上，第二位起加「（2）」「（3）」…
export function speakerLabels(messages, members) {
  const seen = new Map()   // 標示 → 已經有幾位用了
  const out = new Map()    // 發言者鍵 → 最後顯示的標示
  const add = (key, label) => {
    if (typeof key !== 'string' || !key || out.has(key) || !label) return
    const base = label
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    out.set(key, n === 1 ? base : `${base}（${n}）`)
  }
  for (const m of Array.isArray(members) ? members : []) add(m?.key, baseLabel(m))
  for (const m of Array.isArray(messages) ? messages : []) if (m?.from_kind !== 'system' && m?.relation !== 'system') add(m?.from, baseLabel(m))
  return out
}
export const KIND_BADGE = { human: '真人', ai: 'AI' }
export const kindOf = m => (m?.from_kind === 'ai' || m?.from_kind === 'human' ? m.from_kind : '')
// 顯示用的名字只准這些字：避免後台資料夾帶節點代號格式（x: 代號、節點~視窗）
export const safeLabel = s => String(s ?? '').replace(/\bx:[0-9a-f-]{8,}\b/gi, '').replace(/\S+~\S+/g, t => t.slice(t.indexOf('~') + 1)).trim()

// ---------- 附件 ----------
// 群組裡能不能傳附件：只有 external=true（有外部成員＝別人的帳號）才隱藏；只有本人與自己的 AI 的群組照常能傳
export const roomAttachAllowed = f => !f?.room || f.external !== true

// ---------- 主持人確認 ----------
export const CONFIRM_STATUS_TEXT = { pending: '等待主持人確認', approved: '主持人已同意', denied: '主持人已拒絕', expired: '已過期' }
export function confirmCards(list) {
  const rows = (Array.isArray(list) ? list : []).filter(c => c && typeof c.id === 'string').map(c => {
    const owner = c.requester_owner ? `（${safeLabel(c.requester_owner)}）` : ''
    return {
      id: c.id, short: String(c.short ?? c.id.slice(0, 8)), kind: String(c.kind ?? 'other'), kindLabel: String(c.kind_label ?? '其他不可回復的操作'),
      summary: String(c.summary ?? ''), requester: `${safeLabel(c.requester_name || 'AI 夥伴')}${owner}`,
      status: c.status, statusText: CONFIRM_STATUS_TEXT[c.status] ?? '', canDecide: c.status === 'pending' && c.is_host === true,
      at: Date.parse(c.created_at) || 0,
    }
  })
  // 待處理的在前（新的在前）；已處理的只留最近 3 則當紀錄
  const pending = rows.filter(r => r.status === 'pending').sort((a, b) => b.at - a.at)
  const done = rows.filter(r => r.status !== 'pending').sort((a, b) => b.at - a.at).slice(0, 3)
  return [...pending, ...done]
}
export const pendingCount = list => confirmCards(list).filter(c => c.status === 'pending').length

// ---------- 成員管理 ----------
// 成員清單 → 畫面：真人在前、AI 在後；只顯示標示與種類，不顯示任何鍵。mine＝自己的（自己的 AI 才能進出與設開關）
export function memberRows(members) {
  const labels = speakerLabels([], members)   // 同名的成員第二位起加「（2）」
  const rows = (Array.isArray(members) ? members : []).filter(Boolean).map(m => ({
    ref: String(m.key ?? ''), label: safeLabel(labels.get(m.key) || m.label || m.name) || '未知的成員', kind: m.member_kind === 'ai' || (m.member_kind !== 'human' && (m.kind === 'window' || m.kind === 'ai')) ? 'ai' : 'human',
    host: m.role === 'owner', mine: m.mine === true, allowOthers: m.allow_others !== false,
  }))
  return [...rows.filter(r => r.kind === 'human'), ...rows.filter(r => r.kind === 'ai')]
}
// 還能帶進這個群組的、自己名下的夥伴（扣掉已經在裡面的）。members 是後台的成員清單（自己的成員才有真實鍵）
export function addableAi(friends, members) {
  const inside = new Set((Array.isArray(members) ? members : []).filter(m => m?.mine === true).map(m => m.key))
  return aiChoices(friends).filter(a => !inside.has(a.key))
}
// 自己帶進群組的 AI 成員的真實鍵，用來呼叫「移出」與「接受點名」（只在 Rust 呼叫用，畫面不顯示）
export const myAiKey = (members, ref) => (Array.isArray(members) ? members : []).find(m => m?.mine === true && m.key === ref)?.key ?? ''
export const isHostRoom = r => r?.is_host === true

// ---------- 後台動作的呼叫包裝（invoke 由頁面帶進來；測試換成假的） ----------
export function createGroupApi(invoke) {
  const act = (action, body) => invoke('relay_group', { action, body })
  return {
    create: body => act('group_create', body),
    inviteCreate: body => act('group_invite_create', body),
    inviteRevoke: id => act('group_invite_revoke', { id }),
    invitePreview: code => act('group_invite_preview', { code }),
    inviteAccept: code => act('group_invite_accept', { code }),
    leave: room => act('group_leave', { room }),
    aiAdd: (room, keys) => act('group_ai_add', { room, keys }),
    aiRemove: (room, key) => act('group_ai_remove', { room, key }),
    allowOthers: (room, key, allow) => act('group_allow_others', { room, key, allow }),
    confirmDecide: (room, id, approve) => act('group_confirm_decide', { room, id, approve }),
    confirmList: room => act('group_confirm_list', { room }),
  }
}
// ---------- 複製到剪貼簿（WebView 的剪貼簿 API 不一定能用，退回選取＋複製指令） ----------
export async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) { await globalThis.navigator.clipboard.writeText(text); return }
  } catch { /* 往下退回 */ }
  const doc = globalThis.document
  if (!doc) throw new Error('no clipboard')
  const ta = doc.createElement('textarea')
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  doc.body.appendChild(ta); ta.select()
  const ok = doc.execCommand?.('copy')
  ta.remove()
  if (!ok) throw new Error('copy failed')
}
