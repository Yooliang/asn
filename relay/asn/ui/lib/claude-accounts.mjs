// 設定頁「Claude 帳號」：存成帳號、切換、刪除。檔案操作全在 Rust（claude_accounts.rs），這裡只呼叫指令並整理訊息。
// 介面只會拿到 名稱／email／方案／是否使用中；權杖不經過前端。
export const SWITCH_NOTICE = '開著的 Claude 視窗要關掉重開，才會用新帳號。'

export function accountLine(a) {
  return [a.email, a.plan].filter(Boolean).join(' · ')
}

export function createAccountsUi({ invoke, reactive }) {
  const s = reactive({ list: [], name: '', msg: '', busy: false, confirmDel: '' })
  const refresh = async () => {
    try { s.list = await invoke('claude_accounts_list') } catch (e) { s.msg = e.message || String(e) }
  }
  const run = async fn => {
    if (s.busy) return
    s.busy = true
    try { s.msg = await fn() } catch (e) { s.msg = typeof e === 'string' ? e : e.message || String(e) }
    s.busy = false
    s.confirmDel = ''
    await refresh()
  }
  return {
    state: s,
    refresh,
    save: () => run(async () => { const a = await invoke('claude_account_save', { name: s.name.trim() }); s.name = ''; return `已存成帳號「${a.name}」。` }),
    switchTo: name => run(async () => { const r = await invoke('claude_account_switch', { name }); return `已切換到「${r.name}」。${SWITCH_NOTICE}` }),
    // 刪除要按兩次（第一次變成「確認刪除」），避免誤觸
    remove: name => {
      if (s.confirmDel !== name) { s.confirmDel = name; s.msg = ''; return }
      return run(async () => { await invoke('claude_account_delete', { name }); return `已刪除「${name}」。` })
    },
  }
}
