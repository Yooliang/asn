// 進度類事件的訂閱（#2038 PR-2）：更新下載（電腦、手機）與語音辨識引擎下載。
// 全部從事件中心（hub）訂閱，回傳取消函式；事件內容（payload）由 hub 直接交給函式。

/** 電腦版「更新下載進度」：收到就套用到更新狀態（withProgress 只在 installing 階段才會改）。 */
export const watchUpdateProgress = (hub, { getUpd, setUpd, withProgress }) =>
  hub.subscribe('update-progress', p => setUpd(withProgress(getUpd(), p)))

/** 手機「更新下載進度」：只有還在「下載中」才套用——下載完才到的進度事件不能把畫面又拉回「下載中」。 */
export const watchAndroidUpdateProgress = (hub, { upd, withProgress }) =>
  hub.subscribe('android-update-progress', p => { if (upd.phase === 'downloading') Object.assign(upd, withProgress(upd, p)) })

const MB = n => `${Math.round(n / 1048576)} MB`

/** 語音辨識引擎／模型下載進度 → 提示文字（空字串＝下載完了，不用再顯示）。 */
export const sttProgressText = p => {
  if (p?.stage === 'done') return ''
  const what = p?.stage === 'engine' ? '辨識引擎' : '語音模型'
  return p?.total ? `正在下載${what}… ${MB(p.done)} / ${MB(p.total)}` : `正在下載${what}… ${MB(p?.done)}`
}
