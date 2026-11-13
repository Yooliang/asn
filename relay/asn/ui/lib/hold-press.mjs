// 按住一秒才算數（#1445）：手機確認框裡，危險或看不出全貌時的放行類選項、所有「不再詢問」都要按住。
// 只是畫面上的防呆：真正的保證在後台與電腦端的雜湊、選項編號檢查（設計稿 asn-security/design-1445-phone-perm-danger.md 第 4 節）。
// 純邏輯：計時器可以換掉（測試用），畫面只讀 state.key（正在按住哪一顆）。
//   指標：pointerdown 開始；pointerup、pointerleave、pointercancel 都取消（沒按滿就什麼都不送）。
//   鍵盤：Enter 或空白鍵按下開始（自動重複的 keydown 不重算），放開取消。
//   按滿：叫 onDone(key) 一次，並在有的時候震一下。
export const HOLD_MS = 1000

export function createHold({ ms = HOLD_MS, setTimer = (f, t) => setTimeout(f, t), clearTimer = id => clearTimeout(id), onDone, vibrate = () => {}, state = { key: null } } = {}) {
  let timer = 0
  function cancel() {
    if (timer) clearTimer(timer)
    timer = 0
    state.key = null
  }
  function start(key) {
    if (key === null || key === undefined) return
    if (state.key === key && timer) return   // 已經在按住（鍵盤自動重複、重複的 pointerdown）
    cancel()
    state.key = key
    timer = setTimer(() => {
      timer = 0
      const k = state.key
      state.key = null
      if (k !== null) {
        try { vibrate(30) } catch { /* 沒有震動也沒關係 */ }
        onDone?.(k)
      }
    }, ms)
  }
  /** 鍵盤：只有 Enter、空白鍵算；自動重複的不重算。回 true＝這個鍵由按住處理（呼叫端要擋掉預設的 click） */
  function keyDown(key, e) {
    if (e?.key !== 'Enter' && e?.key !== ' ') return false
    if (!e.repeat) start(key)
    return true
  }
  function keyUp(e) {
    if (e?.key === 'Enter' || e?.key === ' ') cancel()
  }
  return { state, start, cancel, keyDown, keyUp }
}
