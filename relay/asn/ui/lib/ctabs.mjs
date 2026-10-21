// 整合模式對話分頁：固定、排序、右鍵選單的批次關閉。純邏輯，介面與測試共用。
import { closeTab, openTab } from './merge.mjs'
import { isPanelTab } from './panels.mjs'

const MAX_PINNED = 40

/** 從 asn-me.json 讀回固定分頁 id 清單（壞值清空；「指引」「設定」分頁不能固定，存檔裡有也丟掉） */
export function normalizePinned(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    if (typeof x !== 'string' || !x || isPanelTab(x) || seen.has(x)) continue
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
  if (isPanelTab(id)) return { pinned: pin, tabs: orderTabs(st.tabs, pin) }   // 指引、設定分頁不能固定
  const on = pin.includes(id)
  const nextPin = on ? pin.filter(x => x !== id) : [...pin, id]
  return { pinned: nextPin, tabs: orderTabs(st.tabs, nextPin) }
}

/** 兩個分頁是否同一區（固定／一般） */
export function chatTabSameZone(idA, idB, pinned) {
  const pinSet = new Set(normalizePinned(pinned))
  return pinSet.has(idA) === pinSet.has(idB)
}

function reorderList(list, dragId, insertBeforeId) {
  if (!list.includes(dragId)) return [...list]
  const rest = list.filter(id => id !== dragId)
  if (insertBeforeId == null || insertBeforeId === '') return [...rest, dragId]
  const i = rest.indexOf(insertBeforeId)
  if (i < 0) return [...rest, dragId]
  const out = [...rest]
  out.splice(i, 0, dragId)
  return out
}

/**
 * 拖曳排序：只能在同一區內移動。insertBeforeId 為目標分頁 id（插在它前面）；null／空字串＝該區最後。
 * 固定區會更新 pinned；一般區只改 tabs 順序（本次執行）。
 */
export function moveChatTab(tabs, pinned, dragId, insertBeforeId) {
  const pin = normalizePinned(pinned)
  const pinSet = new Set(pin)
  const dragPinned = pinSet.has(dragId)
  if (insertBeforeId != null && insertBeforeId !== '' && !chatTabSameZone(dragId, insertBeforeId, pin)) {
    return { tabs: orderTabs(tabs, pin), pinned: pin }
  }
  if (dragPinned) {
    const nextPin = reorderList(pin, dragId, insertBeforeId)
    return { pinned: nextPin, tabs: orderTabs(tabs, nextPin) }
  }
  const ordered = orderTabs(tabs, pin)
  const head = ordered.filter(id => pinSet.has(id))
  const normal = ordered.filter(id => !pinSet.has(id))
  const nextNormal = reorderList(normal, dragId, insertBeforeId)
  return { pinned: pin, tabs: [...head, ...nextNormal] }
}

/**
 * 拖到某個分頁上時要插在哪裡：滑鼠在左半＝插在它前面；右半＝插在它後面，
 * 也就是同一區的下一個分頁前面，沒有下一個就回 ''（＝該區最後，moveChatTab 會放到最後）。
 */
export function dropInsertBefore(tabs, pinned, overId, after) {
  if (!after) return overId
  const pin = normalizePinned(pinned)
  const ordered = orderTabs(tabs, pin)
  const zone = ordered.filter(id => chatTabSameZone(id, overId, pin))
  const i = zone.indexOf(overId)
  return i >= 0 && i + 1 < zone.length ? zone[i + 1] : ''
}
