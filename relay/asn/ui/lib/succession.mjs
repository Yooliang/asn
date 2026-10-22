// 「這是某某的接班」（#153）：新視窗沿用前任夥伴的身分（夥伴 ID 由後台保管，畫面上只有名字）。純函式，瀏覽器與 node 共用。
// 夥伴 ID 只在這裡當選項的值與請求內容，永遠不顯示給使用者；節點代號也不顯示（只顯示設備名）。
import { friendId } from './roster.mjs'

/** 新視窗一直沒被後台認進來／前任視窗一直開著：最久等多久再放棄（毫秒） */
export const SUCCESSION_GIVE_UP_MS = 5 * 60 * 1000

const PID = /^p_[0-9a-f]{20}$/

/**
 * 後台回的夥伴清單 → 下拉選項 [{ value, label }]。
 * - 視窗還開著的不列（後台也會拒絕：前任還開著就不能被接班）；
 * - 排除自己（exceptPartnerId）；
 * - 標籤＝名字（設備名），同名同設備的再加序號區分；最近有動靜的在前（後台已排序，這裡保持順序）。
 */
export function successorOptions(partners, { exceptPartnerId = '' } = {}) {
  const rows = []
  for (const p of Array.isArray(partners) ? partners : []) {
    if (!p || typeof p.partner_id !== 'string' || !PID.test(p.partner_id) || p.partner_id === exceptPartnerId) continue
    if (p.live === true) continue
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (!name) continue
    const device = typeof p.device === 'string' ? p.device.trim() : ''
    rows.push({ value: p.partner_id, base: device ? `${name}（${device}）` : name })
  }
  const seen = new Map()
  for (const r of rows) seen.set(r.base, (seen.get(r.base) ?? 0) + 1)
  const idx = new Map()
  return rows.map(r => {
    if (seen.get(r.base) === 1) return { value: r.value, label: r.base }
    const n = (idx.get(r.base) ?? 0) + 1
    idx.set(r.base, n)
    return { value: r.value, label: `${r.base} ${n}` }
  })
}

/** 一筆等著送出的接班：新視窗（節點＋名字）要接誰 */
export function newSuccession({ node, name, predecessor }, now = Date.now()) {
  return { node, name, predecessor, since: now }
}

/** 新視窗已出現在名單且後台認得它（有夥伴 ID、而且不是前任本人）→ 可以送出了。回 [{ s, friend }]；名單上還沒有的留著 */
export function readySuccessions(pending, friends) {
  const byId = new Map(friends.map(f => [f.id, f]))
  const out = []
  for (const s of pending) {
    const f = byId.get(friendId(s.node, s.name))
    if (f && typeof f.partnerId === 'string' && f.partnerId !== s.predecessor) out.push({ s, friend: f })
  }
  return out
}

/** 已經沿用了前任的身分（名單上這個視窗的夥伴 ID 就是前任）→ 不必再送 */
export function alreadyDone(pending, friends) {
  const byId = new Map(friends.map(f => [f.id, f]))
  return pending.filter(s => byId.get(friendId(s.node, s.name))?.partnerId === s.predecessor)
}

/**
 * 送出失敗怎麼辦（錯誤字串是 Rust 端的「partner_succeed HTTP 409 predecessor_live」格式）：
 * retry＝稍後再試（前任視窗還開著、新視窗還沒被認進來、一時連不上）；drop＝放棄。text 是給使用者看的純中文。
 */
export function succeedOutcome(msg, name = '') {
  const m = String(msg ?? '')
  const who = name ? `「${name}」` : '這位夥伴'
  if (/HTTP 409\b|predecessor_live/.test(m)) return { act: 'retry', text: `前一位夥伴的視窗還開著，請先把它關掉，再指定${who}接班。` }
  if (/HTTP 401\b|尚未登入/.test(m)) return { act: 'drop', text: '要先登入本人的帳號，才能指定接班。' }
  if (/HTTP 403\b/.test(m)) return { act: 'drop', text: '這位夥伴不屬於你的帳號，沒辦法指定接班。' }
  if (/HTTP 400\b/.test(m)) return { act: 'drop', text: `${who}的接班設定格式不對，沒有送出。` }
  return { act: 'retry', text: `${who}的接班還沒設定好，稍後會再試。` }
}

/** 放棄時給使用者看的通知 */
export function giveUpNotice(name, lastText = '') {
  const who = name ? `「${name}」` : '這位夥伴'
  return { title: '接班沒有設定成功', body: `${who}沒有成功接班。${lastText ? `\n${lastText}` : ''}\n之後可以在名單上對它按右鍵，再選一次「這是誰的接班」。` }
}

/** 名單上哪些視窗可以在右鍵選單設定「這是誰的接班」：在名單上（線上）、而且後台已經認得它（有夥伴 ID） */
export function canMarkSuccessor(friend) {
  return Boolean(friend && friend.onRoster === true && typeof friend.partnerId === 'string' && PID.test(friend.partnerId))
}
