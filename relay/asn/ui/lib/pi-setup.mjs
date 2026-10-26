// 設定頁「啟動設定」裡的「pi 與 ASN 互通」區塊（#240 方案 A）的純邏輯與文案（node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri）。
// 經使用者同意，ASN 用 pi 官方的 `pi install` 替他的 pi 加裝 ASN 擴充，之後他自己開的 pi 會自動連上 ASN；可隨時移除，設定還原。
// 給人看的文字：純繁體中文，不出現「收發室」（對使用者說「我們這套軟體」「ASN」）。

export const PI_SETUP_TEXT = {
  title: 'pi 與 ASN 互通',
  off: '你自己開的 pi 目前不會出現在 ASN 的名單上，也不能在 ASN 收信、回信。',
  offAuto: '已關閉自動安裝：ASN 不會再替你的 pi 裝擴充。要用的話，按下面的「啟用」。',
  on: '已替你的 pi 安裝 ASN 擴充，可在此關閉。你之後自己開的 pi 會自動連上 ASN（出現在名單上、能收信回信、能切換模型）；已經開著的 pi 要重開才會生效。',
  stale: '設定裡有一筆已經不存在的舊擴充（ASN 搬過家或重裝過），重新安裝時會順便清掉。',
  consent:
    '同意之後，ASN 會用 pi 官方的安裝指令，替你的 pi 加裝一個小擴充（程式就在這台電腦上，不會上傳）。裝好後，你之後開的 pi 會自動出現在 ASN 的名單上，能收信、回信，也能從 ASN 切換模型；已經開著的 pi 要重開才會生效。' +
    '這會修改 pi 的設定檔（packages 清單）；你隨時可以在這裡移除，設定會還原。',
  noExt: '找不到 ASN 附的 pi 擴充（安裝可能不完整），請重新安裝 ASN。',
  ask: '啟用…',
  agree: '同意並安裝',
  cancel: '取消',
  remove: '關閉並移除',
  reinstall: '清理並重新安裝',
  busy: '處理中，請稍候…',
  installed: '已啟用。之後你開的 pi 就會連上 ASN。',
  removed: '已關閉並移除，pi 的設定已還原；ASN 不會再自動裝回。',
  failed: '沒有成功：',
}

/** 後端回來的狀態 → 乾淨的物件（壞值當保守預設） */
export function normalizePiSetup(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return { pi: r.pi === true, ext: r.ext === true, installed: r.installed === true, stale: Number.isInteger(r.stale) && r.stale > 0 ? r.stale : 0, auto: r.auto !== false }
}

/**
 * 畫面要的樣子。raw＝後端狀態（還沒查到＝null）；ui＝{ busy, confirm, msg }。
 * 這台電腦找不到 pi、而且也沒裝過擴充＝不顯示這一區（回 null），沒裝 pi 的人不會被打擾。
 */
export function piSetupView(raw, ui = {}) {
  if (!raw) return null
  const s = normalizePiSetup(raw)
  if (!s.pi && !s.installed) return null
  const busy = ui.busy === true
  const confirm = ui.confirm === true && !s.installed && !busy
  const lines = [s.installed ? PI_SETUP_TEXT.on : s.auto ? PI_SETUP_TEXT.off : PI_SETUP_TEXT.offAuto]
  if (s.stale > 0) lines.push(PI_SETUP_TEXT.stale)
  if (!s.ext && !s.installed) lines.push(PI_SETUP_TEXT.noExt)
  if (busy) lines.push(PI_SETUP_TEXT.busy)
  return {
    title: PI_SETUP_TEXT.title,
    installed: s.installed,
    lines,
    consent: confirm ? PI_SETUP_TEXT.consent : '',
    msg: typeof ui.msg === 'string' ? ui.msg : '',
    busy,
    // 哪些按鈕要出現（畫面各自對應固定的指令，不用動態 op，守門測試才對得上）
    showAsk: !s.installed && !confirm && s.ext,
    showAgree: confirm && s.ext,
    showCancel: confirm,
    showRemove: s.installed,
    showReinstall: s.installed && s.stale > 0 && s.ext,
    askLabel: PI_SETUP_TEXT.ask,
    agreeLabel: PI_SETUP_TEXT.agree,
    cancelLabel: PI_SETUP_TEXT.cancel,
    removeLabel: PI_SETUP_TEXT.remove,
    reinstallLabel: PI_SETUP_TEXT.reinstall,
  }
}

/** 後端錯誤 → 給人看的一句話 */
export const piSetupError = e => `${PI_SETUP_TEXT.failed}${String(e?.message ?? e ?? '').slice(0, 200)}`
