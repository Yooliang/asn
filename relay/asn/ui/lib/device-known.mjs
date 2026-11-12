// 設備名規則（和後台一致）與「設備列表 × 認得的電腦」的對應。純函式，node 也能載入（測試）。
export const NAME_MAX = 40
export const NAME_RULE_HINT = '名字不合規則：1～40 字，不能含「指紋」兩個字，也不能像指紋（8 個英數字連在一起，或 4 碼＋空白＋4 碼）'

const CTRL = /[\u0000-\u001f\u007f-\u009f]/
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/
// 和後台 relay.device_name_ok、Edge 的 device_rename.ts 同一套（任一段 8 碼含數字；4 碼＋一個空白＋4 碼且含數字）
const HEX8 = /(?=[a-f]{0,7}[0-9])[0-9a-f]{8}/i
const HEX44 = /(?=[a-f\s\u3000]{0,8}[0-9])[0-9a-f]{4}[\s\u3000][0-9a-f]{4}/i
const looksLikeFingerprint = s => HEX8.test(s) || HEX44.test(s)

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
 * 設備列表（devs＋已永久移除）和認得的電腦對起來：列的 key 就是紀錄的 node。
 * 回 { byNode: { node: 紀錄 }, old: 不在任何一列裡的紀錄 }
 */
export function joinKnown(devs, removedDevs, peers) {
  const inList = new Set([...(devs ?? []), ...(removedDevs ?? [])].map(d => d?.key).filter(Boolean))
  const byNode = {}, old = []
  for (const p of Array.isArray(peers) ? peers : []) {
    if (!p?.node) continue
    byNode[p.node] = p
    if (!inList.has(p.node)) old.push(p)
  }
  return { byNode, old }
}

/** 手機列顯示的短指紋：前 8 字，4 個一組 */
export const shortFp = fp => String(fp ?? '').replace(/\s+/g, '').slice(0, 8).replace(/(.{4})(?=.)/, '$1 ')
