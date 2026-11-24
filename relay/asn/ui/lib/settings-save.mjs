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
// 同一個存檔物件上，後來的呼叫會讓還在等的舊呼叫放棄重試（舊的內容已經過時，不能蓋掉新的）
const latest = new WeakMap()

/**
 * 把 `fields` 用 patch 存進 `store`（`store.patch`、`store.save` 來自 tauri.mjs 的 store(name)）。
 *   - 成功：回 true。
 *   - `[settings:merge]`（舊檔真的壞了、合併不了）：退回整份 `store.save` 一次。整份內容＝`full`（物件，或回傳物件的函式）；
 *     沒給 `full` 就用 `fields` 本身。整份存也失敗就把那個錯誤丟出去。
 *   - `[settings:unreadable]`（被別的程式占用）：等 3 秒再 patch 一次；**不退回整份存、不連續重試**。
 *     第二次還是失敗就放棄（console.warn 一行、回 false），下一次正常存檔自然會再試。等的期間又有新的存檔進來，這一次就不重試了（回 false）。
 *   - 其他錯誤：原樣丟出去（跟以前 `store.save` 失敗時一樣由呼叫端處理）。
 * opts：{ wait, warn }，測試注入。
 */
export async function patchWithFallback(store, fields, full, { wait = sleepMs, warn = console.warn } = {}) {
  const mine = (latest.get(store) ?? 0) + 1
  latest.set(store, mine)
  try {
    await store.patch(fields)
    return true
  } catch (e) {
    if (hasCode(e, CODE_MERGE)) {
      const whole = typeof full === 'function' ? full() : full
      await store.save(whole ?? fields)
      return true
    }
    if (!hasCode(e, CODE_UNREADABLE)) throw e
  }
  await wait(UNREADABLE_WAIT_MS)
  if (latest.get(store) !== mine) return false
  try {
    await store.patch(fields)
    return true
  } catch (e) {
    warn('[ASN] 設定檔暫時讀不到，這次沒存成，下次存檔會再試', rawOf(e))
    return false
  }
}
