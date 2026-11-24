// 設定存檔的共用做法（#2162 ⑦）：個人設定、引導旗標改成「只送自己擁有的欄位」（settings_patch），
// 不認得的欄位由後端原樣保留。電腦版（list.js）、手機版（m.js）、引導（onboard.mjs）、設備改名（device-rename.mjs）共用。
// 判斷靠 invoke 出口從後端錯誤開頭 `[settings:代號]` 拆出來的 `e.code`，不比對文字。純函式，不碰 DOM、不碰 Tauri。

export const CODE_MERGE = 'settings:merge'
export const CODE_UNREADABLE = 'settings:unreadable'
/** 被其他程式占用時，等這麼久再試一次（只試一次） */
export const UNREADABLE_WAIT_MS = 3000

/** 錯誤訊息（字串、Error、帶 message 的物件都行）；取不到就是空字串。invoke 出口已把代號拆到 `e.code`，這裡的 message 沒有代號 */
const rawOf = e => (typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : '')
/** 只認 `e.code`（由 lib/tauri.mjs 的 invoke 出口設定），不比對文字 */
export const hasCode = (e, code) => e?.code === code

const sleepMs = ms => new Promise(r => setTimeout(r, ms))
// 每個存檔物件各記一份「欠著的欄位」：碰到 unreadable、正在等 3 秒的呼叫，把它還沒存進去的欄位登記在這裡（欄位名 → { 值, 呼叫編號 }）。
// 之後進來的新呼叫會把欠著的欄位併進自己這次要送的欄位（同一欄以新值為準），送出去就等於幫舊呼叫存了；舊呼叫等完發現欄位已被接手（或被新值蓋掉）就不再重試。
// 這樣連續 patch 不同欄位（先 { done }、再 { pendingDeviceName }）時，舊的欄位不會因為「有更新的呼叫」而丟掉；同一欄的舊值也不會蓋掉新值。
// 頂層欄位值是 undefined：JSON.stringify 會把它拿掉，整份存時這一欄會跟著從檔案消失；改成 patch 之後它只是「沒送」，舊值會留在檔案裡
// （例如取消置頂後 pinnedChat 變成 undefined，重開置頂又回來）。所以送出前把頂層的 undefined 轉成 null，後端收到 null 就刪掉那一欄。
// 只處理頂層：後端的合併是頂層逐欄覆蓋，巢狀物件整個換掉，裡面的 undefined 跟以前整份存時一樣由 JSON 拿掉，結果相同，不需要特別處理。
const undefinedToNull = f => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, v === undefined ? null : v]))
// 整份存的內容：base 再蓋上 over；over 裡值是 null 的欄位代表刪欄，整份存時直接拿掉（寫進去會變成值 null）
const wholeWith = (base, over) => {
  const out = { ...(base ?? {}), ...over }
  for (const [k, v] of Object.entries(over)) if (v === null) delete out[k]
  return out
}
const state = new WeakMap()
const stateOf = store => { let st = state.get(store); if (!st) { st = { n: 0, owed: new Map() }; state.set(store, st) } return st }

/**
 * 把 `fields` 用 patch 存進 `store`（`store.patch`、`store.save` 來自 tauri.mjs 的 store(name)）。
 *   - 成功：回 true。
 *   - `settings:merge`（舊檔真的壞了、合併不了）：退回整份 `store.save` 一次。整份內容＝`full`（物件，或回傳物件的函式；沒給就用這次送的欄位），
 *     再補上被併進來的舊欄位。整份存也失敗就把那個錯誤丟出去。
 *   - `settings:unreadable`（被別的程式占用）：等 3 秒再 patch 一次；**不退回整份存、不連續重試**。
 *     第二次還是失敗就放棄（console.warn 一行、回 false），欄位仍欠著，下一次正常存檔會一起帶上。
 *     等的期間若有新呼叫進來：新呼叫把這次的欄位併進去送；欄位已被接手或蓋掉，這一次就不重試（回 true，因為不會丟）。
 *   - 其他錯誤：原樣丟出去（跟以前 `store.save` 失敗時一樣由呼叫端處理）；被併進來的舊欄位退回欠著，下一次再帶。
 * opts：{ wait, warn }，測試注入。
 */
export async function patchWithFallback(store, fields, full, { wait = sleepMs, warn = console.warn } = {}) {
  fields = undefinedToNull(fields)
  const st = stateOf(store)
  const id = ++st.n
  // 接手別的呼叫欠著的欄位（新值優先：這次有送的欄位，舊值直接作廢）
  const carried = {}
  for (const [k, o] of st.owed) if (!(k in fields)) carried[k] = o.value
  const taken = [...st.owed]
  st.owed.clear()
  const send = { ...carried, ...fields }
  const giveBack = () => { for (const [k, o] of taken) if (!(k in fields) && !st.owed.has(k)) st.owed.set(k, o) }
  try {
    await store.patch(send)
    return true
  } catch (e) {
    if (hasCode(e, CODE_MERGE)) {
      try {
        const whole = typeof full === 'function' ? full() : full
        await store.save(wholeWith(whole ?? null, whole ? carried : send))
        return true
      } catch (e2) { giveBack(); throw e2 }
    }
    if (!hasCode(e, CODE_UNREADABLE)) { giveBack(); throw e }
  }
  for (const [k, v] of Object.entries(send)) st.owed.set(k, { value: v, id })
  await wait(UNREADABLE_WAIT_MS)
  const mine = {}
  for (const [k, o] of st.owed) if (o.id === id) mine[k] = o.value
  if (Object.keys(mine).length === 0) return true   // 欄位已被新的呼叫接手（或被新值蓋掉）
  try {
    await store.patch(mine)
    for (const k of Object.keys(mine)) if (st.owed.get(k)?.id === id) st.owed.delete(k)
    return true
  } catch (e) {
    warn('[ASN] 設定檔暫時讀不到，這次沒存成，下次存檔會再試', rawOf(e))
    return false
  }
}
