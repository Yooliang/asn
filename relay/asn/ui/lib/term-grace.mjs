// 電腦版看終端：離開分頁後的寬限。看別台的終端（要對方同意、對方有紅條）離開分頁時不馬上結束，
// 寬限內切回來照舊在；超過寬限就在到期那一刻結束（不等切回來），切回來才會看到「已結束」。
// 時間與計時器都可以換（測試、探測不用真的等）；預設每次呼叫時才去拿全域的 setTimeout，探測可以事後換掉它。
/** 離開分頁後最多保留多久（毫秒） */
export const TERM_GRACE_MS = 5 * 60 * 1000
/** 寬限到了、觀看已結束時，狀態列的字 */
export const GRACE_ENDED_TEXT = '已結束觀看（離開超過 5 分鐘）'
/** 打字中離開分頁、打字馬上結束時，切回來狀態列的字 */
export const TYPING_ENDED_TEXT = '已結束打字（離開了這個分頁）'
/** 狀態列上，結束後重新開始的按鈕字 */
export const GRACE_AGAIN_LABEL = '重新看'

/**
 * 離開分頁的寬限計時。
 * - leave()：離開分頁，開始計時（已經在計時就不重來）
 * - back()：回到分頁。回 'none'（本來就沒離開）、'kept'（寬限內，觀看還在）、'expired'（這段離開期間已經結束）
 * - cancel()：不用計了（觀看自己收掉了）
 * 到期的那一刻呼叫 onExpire，同一段離開只呼叫一次；切回來時若時間已超過（計時器被節流或電腦睡眠）也補呼叫一次。
 */
export function createGrace({ ms = TERM_GRACE_MS, now = () => Date.now(), set = (f, t) => globalThis.setTimeout(f, t), clear = h => globalThis.clearTimeout(h), onExpire } = {}) {
  let leftAt = null, timer = null, fired = false
  const fire = () => { timer = null; if (leftAt === null || fired) return; fired = true; onExpire?.() }
  return {
    leave() {
      if (leftAt !== null) return
      leftAt = now(); fired = false
      timer = set(fire, ms)
    },
    back() {
      if (leftAt === null) return 'none'
      if (timer !== null) { clear(timer); timer = null }
      if (!fired && now() - leftAt >= ms) fire()
      const expired = fired
      leftAt = null; fired = false
      return expired ? 'expired' : 'kept'
    },
    cancel() {
      if (timer !== null) { clear(timer); timer = null }
      leftAt = null; fired = false
    },
    away: () => leftAt !== null,
  }
}
