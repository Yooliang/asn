// 帳號類事件的訂閱（#2038 PR-3）：Claude 外掛安裝完成、Claude／Grok 背景自動加入帳號。
// 從事件中心（hub）訂閱，回傳一個取消全部的函式；事件內容（payload）由 hub 直接交給函式。

/** accounts：createAccountsUi 的回傳（要有 state、onAuto） */
export const watchAccountEvents = (hub, accounts) => {
  const offs = [
    hub.subscribe('claude-mod-status', p => { accounts.state.mod = p ?? null }),   // Rust 背景安裝 Claude 外掛完成
    hub.subscribe('claude-account-auto', p => void accounts.onAuto(p)),
    hub.subscribe('grok-account-auto', p => void accounts.onAuto(p)),   // Grok 自動加入也走同一支：重抓清單並回報
  ]
  return () => { for (const off of offs) off() }
}
