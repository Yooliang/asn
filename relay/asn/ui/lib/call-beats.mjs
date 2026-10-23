// 分開模式下，通話在對話視窗、「收到新訊息自動念」在名單視窗，兩邊是不同的網頁：通話中名單視窗不能再自動念同一則回信，
// 不然會念兩次。對話視窗通話時每 20 秒廣播一次「我在通話」（asn:call），名單視窗記下來；超過 60 秒沒聽到就當作結束了（視窗被直接關掉也不會卡住）。
// 純函式＋注入時間，好測。
export const CALL_BEAT_MS = 20_000
export const CALL_BEAT_EXPIRE_MS = 60_000

export function createCallBeats({ now = () => Date.now(), isLocalCall = () => false } = {}) {
  const beats = new Map()
  return {
    /** 收到 asn:call 廣播 */
    onBeat(p) { if (!p?.id) return; if (p.active) beats.set(String(p.id), now()); else beats.delete(String(p.id)) },
    /** 這一位的對話現在有沒有在通話（對話視窗的廣播還沒過期）：給「關閉閒置」判斷分頁忙不忙 */
    isCalling(id) {
      const t = beats.get(String(id))
      if (t === undefined) return false
      if (now() - t >= CALL_BEAT_EXPIRE_MS) { beats.delete(String(id)); return false }
      return true
    },
    /** 現在有沒有任何通話（本視窗內的，或別的視窗廣播過來還沒過期的） */
    anyCall() {
      if (isLocalCall()) return true
      for (const [id, t] of beats) { if (now() - t >= CALL_BEAT_EXPIRE_MS) beats.delete(id) }
      return beats.size > 0
    },
  }
}
