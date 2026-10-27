// 設定頁「啟動設定」裡的「額度回報」區塊（#228）的純邏輯與文案（node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri）。
// 經使用者同意，ASN 把 `asn-cli claude-quota --chain` 接在 Claude Code 的狀態列上，記下目前帳號的 5 小時與每週剩餘額度，
// 讓手機的「設備與帳號」看得到；可隨時取消，設定還原。預設不接。後端見 src-tauri/src/statusline_hook.rs。
// 給人看的文字：純繁體中文。

export const QUOTA_HOOK_TEXT = {
  title: '額度回報',
  off: '目前沒有接上：手機的「設備與帳號」看不到這台 Claude 帳號還剩多少額度。',
  on: '已接上：每次 Claude Code 更新狀態列時，ASN 會記下目前帳號的剩餘額度，手機就看得到。',
  stale: '之前接上的 ASN 位置對不上了（搬過或重裝過），按「重新接上」就會修好。',
  blocked: '目前的狀態列不是「執行指令」型，或設定檔讀不懂，ASN 不敢去改它。',
  hasOriginal: '你原本的狀態列會照常顯示，ASN 只是在它前面多記一筆。',
  consent:
    '同意之後，ASN 會修改 Claude Code 的設定檔（~/.claude/settings.json）裡「狀態列」那一個欄位，改成先讓 ASN 記下額度數字（只讀額度與登入的 email，不連網），再執行你原本的狀態列指令；其他設定都不動。' +
    '原本的指令與設定檔會先備份，你隨時可以按「取消接上」還原。如果某個專案自己設了狀態列，那個專案裡不會回報額度；解除安裝 ASN 前請先按「取消接上」。',
  ask: '接上…',
  agree: '同意並接上',
  cancel: '取消',
  reconnect: '重新接上',
  disconnect: '取消接上',
  busy: '處理中，請稍候…',
  connected: '已接上。下次 Claude Code 更新狀態列時就會開始記額度。',
  disconnected: '已取消接上，狀態列還原。',
  failed: '沒有成功：',
}

const STATES = new Set(['off', 'on', 'stale', 'blocked'])

/** 後端狀態 → 乾淨的物件（壞值當保守預設：blocked，不讓人去按） */
export function normalizeQuotaHook(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    state: STATES.has(r.state) ? r.state : 'blocked',
    current: typeof r.current === 'string' ? r.current.slice(0, 160) : '',
    hasOriginal: r.hasOriginal === true,
  }
}

/** 畫面要的樣子。raw＝後端狀態（還沒查到＝null，不顯示這一區）；ui＝{ busy, confirm, msg } */
export function quotaHookView(raw, ui = {}) {
  if (!raw) return null
  const s = normalizeQuotaHook(raw)
  const busy = ui.busy === true
  const confirm = ui.confirm === true && (s.state === 'off' || s.state === 'stale') && !busy
  const lines = [s.state === 'on' ? QUOTA_HOOK_TEXT.on : s.state === 'stale' ? QUOTA_HOOK_TEXT.stale : s.state === 'blocked' ? QUOTA_HOOK_TEXT.blocked : QUOTA_HOOK_TEXT.off]
  if (s.hasOriginal && s.state !== 'blocked') lines.push(QUOTA_HOOK_TEXT.hasOriginal)
  if (busy) lines.push(QUOTA_HOOK_TEXT.busy)
  const canConnect = s.state === 'off' || s.state === 'stale'
  return {
    title: QUOTA_HOOK_TEXT.title,
    state: s.state,
    lines,
    current: confirm && s.current ? s.current : '',   // 確認時讓使用者看到目前的狀態列指令（截短）
    consent: confirm ? QUOTA_HOOK_TEXT.consent : '',
    msg: typeof ui.msg === 'string' ? ui.msg : '',
    busy,
    // 哪些按鈕要出現（畫面各自對應固定的指令，不用動態 op，守門測試才對得上）
    showAsk: canConnect && !confirm,
    showAgree: canConnect && confirm,
    showCancel: confirm,
    showDisconnect: s.state === 'on' || s.state === 'stale',
    askLabel: s.state === 'stale' ? QUOTA_HOOK_TEXT.reconnect : QUOTA_HOOK_TEXT.ask,
    agreeLabel: QUOTA_HOOK_TEXT.agree,
    cancelLabel: QUOTA_HOOK_TEXT.cancel,
    disconnectLabel: QUOTA_HOOK_TEXT.disconnect,
  }
}

export const quotaHookError = e => `${QUOTA_HOOK_TEXT.failed}${String(e?.message ?? e ?? '').slice(0, 200)}`
