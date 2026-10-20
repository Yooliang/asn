// 整合模式對話分頁：固定、排序、右鍵選單的批次關閉。純邏輯，介面與測試共用。
import { closeTab, openTab } from './merge.mjs'

const MAX_PINNED = 40

/** 從 asn-me.json 讀回固定分頁 id 清單（壞值清空） */
export function normalizePinned(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    if (typeof x !== 'string' || !x || seen.has(x)) continue
    seen.add(x)
    out.push(x)
    if (out.length >= MAX_PINNED) break
  }
  return out
}

export function isPinned(id, pinned) {
  return normalizePinned(pinned).includes(id)
}

/** 固定 id 排最前（依 pinned 順序），其餘維持原本相對順序 */
export function orderTabs(tabs, pinned) {
  const pin = normalizePinned(pinned)
  const pinSet = new Set(pin)
  const head = pin.filter(id => tabs.includes(id))
  const tail = tabs.filter(id => !pinSet.has(id))
  return [...head, ...tail]
}

/** 開分頁後依固定狀態排序 */
export function openChatTab(st, id, pinned) {
  const next = openTab(st, id)
  return { ...next, tabs: orderTabs(next.tabs, pinned) }
}

/** 關閉單一分頁（含已固定；選單「關閉」用） */
export function closeChatTab(st, id) {
  return closeTab(st, id)
}

function pickActiveAfterRemove(oldTabs, oldActive, removedSet) {
  if (!removedSet.has(oldActive)) return oldActive
  const i = oldTabs.indexOf(oldActive)
  for (let j = i; j < oldTabs.length; j++) {
    const id = oldTabs[j]
    if (!removedSet.has(id)) return id
  }
  for (let j = i - 1; j >= 0; j--) {
    const id = oldTabs[j]
    if (!removedSet.has(id)) return id
  }
  return ''
}

function closeWhere(st, pinned, pred) {
  const pinSet = new Set(normalizePinned(pinned))
  const removedSet = new Set()
  for (const id of st.tabs) {
    if (pinSet.has(id)) continue
    if (pred(id)) removedSet.add(id)
  }
  if (!removedSet.size) return { tabs: [...st.tabs], active: st.active }
  const tabs = st.tabs.filter(id => !removedSet.has(id))
  const active = pickActiveAfterRemove(st.tabs, st.active, removedSet)
  return { tabs, active }
}

/** 關閉其他：保留目前這個與所有已固定 */
export function closeOtherChatTabs(st, id, pinned) {
  return closeWhere(st, pinned, x => x !== id)
}

/** 關閉右側：目前分頁右邊的（不含已固定） */
export function closeRightChatTabs(st, id, pinned) {
  const i = st.tabs.indexOf(id)
  if (i < 0) return { tabs: [...st.tabs], active: st.active }
  return closeWhere(st, pinned, x => st.tabs.indexOf(x) > i)
}

/** 全部關閉：只留已固定 */
export function closeAllChatTabs(st, pinned) {
  const pinSet = new Set(normalizePinned(pinned))
  const tabs = st.tabs.filter(id => pinSet.has(id))
  const active = tabs.includes(st.active) ? st.active : (tabs.at(-1) ?? '')
  return { tabs, active }
}

/** 切換固定；回傳新 pinned 與重排後的 tabs */
export function toggleChatPin(st, id, pinned) {
  const pin = normalizePinned(pinned)
  const on = pin.includes(id)
  const nextPin = on ? pin.filter(x => x !== id) : [...pin, id]
  return { pinned: nextPin, tabs: orderTabs(st.tabs, nextPin) }
}
