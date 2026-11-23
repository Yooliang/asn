import { unnamedClue } from './device-identity.mjs'
import { isPhoneNode } from './node-platform.mjs'
// 設備名規則（和後台一致）與「設備列表 × 認得的電腦」的對應。純函式，node 也能載入（測試）。
export const NAME_MAX = 40
export const NAME_RULE_HINT = '名字不合規則：1～40 字，不能含「指紋」兩個字，也不能像指紋（8 個英數字連在一起，或 4 碼＋空白＋4 碼）'

const CTRL = /[\u0000-\u001f\u007f-\u009f]/
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/
// 和後台 relay.device_name_ok、Edge 的 device_rename.ts 同一套（任一段 8 碼含數字；4 碼＋一個空白＋4 碼且含數字）
const HEX8 = /(?=[a-f]{0,7}[0-9])[0-9a-f]{8}/i
const HEX44 = /(?=[a-f\s\u3000]{0,8}[0-9])[0-9a-f]{4}[\s\u3000][0-9a-f]{4}/i
const looksLikeFingerprint = s => HEX8.test(s) || HEX44.test(s)

/** 顯示用（#1388）：後台給的名字不可信，含「指紋」或像指紋的名字當成沒有名字（呼叫端改顯示「未命名」，指紋另外顯示）。和 Rust 的 display_name_ok 同一套 */
export const displayDeviceName = name => {
  const s = String(name ?? '').trim()
  return s && !s.includes('指紋') && !looksLikeFingerprint(s) && !LEGACY_UNNAMED.includes(s) ? s : ''
}
// 舊版畫面上的「沒名字」字樣：讀回來若被當成名字存著，一律當沒有名字，改走辨認線索（#1829）
export const LEGACY_UNNAMED = ['未命名設備', '未命名的電腦']

/**
 * 名單成員 → { 節點: 後台記的設備名（nodes.name）}。名字是每台設備自己的，不靠它底下有沒有夥伴（#1803：手機沒有夥伴列）。
 * 只做清理（去頭尾空白、非字串丟掉），要不要顯示由 deviceNameOf 判斷
 */
export function nodeNamesOf(members) {
  const out = {}
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.id !== 'string' || typeof m.name !== 'string') continue
    const n = m.name.trim()
    if (n) out[m.id] = n
  }
  return out
}

/**
 * 名單成員 → { 節點: { createdMs, seenMs } }：後台記的建立時間與最後在線時間（毫秒，沒有＝0）。
 * 辨認區（device-identity.mjs）讀這份；兩個都沒有的節點不放
 */
export function nodeFactsOf(members) {
  const ms = v => { const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(t) && t > 0 ? t : 0 }   // 後台給 ISO 字串；給毫秒數字也收
  const out = {}
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.id !== 'string') continue
    const createdMs = ms(m.created_at), seenMs = ms(m.last_seen_at)
    if (createdMs || seenMs) out[m.id] = { createdMs, seenMs }
  }
  return out
}

/**
 * 一台設備要顯示的名字（電腦版、手機版所有地方都只用這一個函式讀）：先看後台記的名字（nodeNames），
 * 沒有再借這台底下夥伴帶的 device（舊後台、名單還沒讀到時的退路），再沒有用 fallback；都不合格回空字串
 * （呼叫端自己決定寫「未命名」或「這支手機」）
 */
export function deviceNameOf(node, { nodeNames = null, friends = [], fallback = '' } = {}) {
  return displayDeviceName(nodeNames?.[node]) || displayDeviceName((friends ?? []).find(f => f?.node === node && f.device)?.device) || displayDeviceName(fallback)
}

/**
 * 名字空白時的顯示名（電腦版、手機版所有地方共用，#1829）：這台有夥伴標手機就寫「手機（代號末 4 碼）」，否則「電腦（…）」；手機還是電腦只由 node-platform.mjs 判斷。
 * 有名字的地方一律先走 deviceNameOf，只有它回空字串才呼叫這個
 */
export const unnamedLabelOf = (node, { friends = [], platform = '', phone = null } = {}) =>
  unnamedClue({ node, phone: typeof phone === 'boolean' ? phone : isPhoneNode(node, { platform, friends }) })

/** 設備名檢查：合規回空字串，不合規回中文提示 */
export function deviceNameError(name) {
  const raw = String(name ?? '')
  if (INVISIBLE.test(raw)) return NAME_RULE_HINT   // 要在 trim 之前查：JS 的 trim 會吃掉 BOM
  const s = raw.trim()
  if (!s || [...s].length > NAME_MAX) return NAME_RULE_HINT
  if (CTRL.test(s)) return NAME_RULE_HINT
  if (s.includes('指紋')) return NAME_RULE_HINT
  if (looksLikeFingerprint(s)) return NAME_RULE_HINT
  return ''
}

/**
 * 設備列表（畫面上畫出來的列）和認得的電腦對起來：列的 key 就是紀錄的 node。
 * 回 { byNode: { node: 紀錄 }, old: 不在任何一列裡的紀錄（含已永久移除的設備，要有地方能取消授權或忘記） }
 */
export function joinKnown(devs, peers) {
  const inList = new Set((devs ?? []).map(d => d?.key).filter(Boolean))
  const byNode = {}, old = []
  for (const p of Array.isArray(peers) ? peers : []) {
    if (!p?.node) continue
    byNode[p.node] = p
    if (!inList.has(p.node)) old.push(p)
  }
  return { byNode, old }
}

/**
 * 「已移除的設備」一塊（電腦、手機同一個函式，#1860）：
 *  - 使用者永久移除、還能恢復的設備列（rows 裡 removed）→ kind 'restore'（按「恢復」）
 *  - 只剩認得紀錄、沒有任何一列的 → kind 'forget'（按「忘記」，只寫名稱和第一次連線的日期，不寫指紋）
 * 正在用的設備一律不進來：紀錄的節點只要在 rows 裡（不論有沒有被移除）就不算「只剩紀錄」；
 * 同名的紀錄（同一台重裝後換了節點，舊紀錄沒清）併回現在那一列，不另外列
 */
export function removedDevices(rows, peers) {
  const list = Array.isArray(rows) ? rows : []
  const inRows = new Set(list.map(d => d?.key).filter(Boolean))
  const live = new Set(list.filter(d => d && !d.removed && d.label).map(d => d.label))
  const restore = list.filter(d => d?.removed).map(d => ({ key: d.key, label: d.label, kind: 'restore', firstSeen: '' }))
  // 名單還沒讀到（一台設備都沒有）時，不要把所有紀錄暫時當成「只剩紀錄」
  const forget = (!list.length ? [] : Array.isArray(peers) ? peers : []).filter(p => p?.node && !inRows.has(p.node) && !live.has(p.label))
    .map(p => ({ key: p.node, label: p.label, kind: 'forget', firstSeen: dateText(p.firstSeenMs), peer: p }))
  return { items: [...restore, ...forget], count: restore.length + forget.length }
}

/** 「第一次連線」的日期：YYYY/MM/DD（本地時間）；沒有時間就回空字串（已移除的設備區用，#1860） */
export const dateText = ms => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/** 手機列顯示的短指紋：前 8 字，4 個一組 */
export const shortFp = fp => String(fp ?? '').replace(/\s+/g, '').slice(0, 8).replace(/(.{4})(?=.)/, '$1 ')
