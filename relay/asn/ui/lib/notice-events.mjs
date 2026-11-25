// 提示與雜項事件的訂閱（#2038 PR-4）：邀請連結、正在聽的歌、這台的終端被誰看。
// 全部從事件中心（hub）訂閱，回傳取消函式；事件內容（payload）由 hub 直接交給函式。
// 注意：term-req-update、window-spool 兩種 Rust 有送、前端沒人接，這裡不接（#2332 處理中）。

/** 收到邀請連結（asn://invite/<碼>）：原樣交給 onCode，碼是否有效的檢查在 onCode（onInviteCode）裡做。 */
export const watchInvite = (hub, onCode) => hub.subscribe('asn:invite', code => onCode(code))

/** 正在聽的歌變了：開關關著就一律清成空字串；歌名一律轉字串。 */
export const watchNowPlaying = (hub, { isOn, setText }) =>
  hub.subscribe('asn:now-playing', p => setText(isOn() ? String(p ?? '') : ''))

/** 這台的終端正被誰看：只收陣列，其他形狀當成沒人看。 */
export const watchBeingViewed = (hub, setList) =>
  hub.subscribe('term-being-viewed', list => setList(Array.isArray(list) ? list : []))
