// 錯誤轉白話的集中處（#2106 ②）。各畫面檔不再自己寫「把錯誤原文轉成給人看的一句話」，改從這裡拿。
// 純函式，不碰 DOM、不碰 Tauri。原文由 ui/lib/tauri.mjs 的出口寫進 log，這裡只管畫面上顯示什麼。

// 手機「認得的電腦」操作沒成功的通用白話
export const KNOWN_PEER_FAILED_TEXT = '操作沒有成功，請稍後再試。'

/**
 * 預設：沒有對照時，畫面顯示的就是錯誤原文。
 * Tauri 的 Err(String) 若沒經過 lib/tauri.mjs 會以「字串」拋出（e.message 是 undefined），所以字串、Error、
 * 帶 message 的物件都取得出文字；取不到（undefined、null、空字串、沒有 message 的物件）就回通用白話，絕不回空字串。
 */
export const plainMessage = (e, fallback) => {
  const raw = typeof e === 'string' ? e : e?.message
  const s = typeof raw === 'string' ? raw.trim() : ''
  return s || (typeof fallback === 'string' && fallback.trim()) || KNOWN_PEER_FAILED_TEXT
}

/** 設備細部頁安裝 Claude Code 失敗：字串或 Error 都原文顯示（以前 agent-install.mjs 自己的 errText） */
export const agentSetupErrorText = e => (typeof e === 'string' ? e : e?.message || String(e))

/** 引導頁「完成」失敗：字串或 Error 都原文顯示（以前 onboard.js 自己的 String(e?.message ?? e)） */
export const onboardErrorText = e => String(e?.message ?? e)

/** 本機重新登入失敗：字串或 Error 都原文顯示（以前 relogin-flow.mjs 自己的 errText） */
export const reloginErrorText = e => (typeof e === 'string' ? e : e?.message || String(e))

/** 讀取用量失敗：畫面只給白話，Rust 原文不顯示（出口已寫進 ui.log）。參數留著只是跟其他白話函式同形 */
export const USAGE_FAILED_TEXT = '暫時讀不到用量，稍後再試一次。'
export const usageErrorText = _e => USAGE_FAILED_TEXT

/** 帳號卡各操作失敗：字串或 Error 都原文顯示（以前 claude-accounts.mjs 自己的 errText） */
export const accountsErrorText = e => (typeof e === 'string' ? e : e?.message || String(e))

/** 改名失敗：後台（Rust）回的是中文說明就原樣顯示，其他一律說白話 */
export function renameErrorText(e) {
  const s = String(e?.message ?? e ?? '').trim()
  return /[一-鿿]/.test(s) && s.length <= 120 ? s : KNOWN_PEER_FAILED_TEXT
}

/** 終端遠端（代答、代送手機確認）失敗：字串或 Error 都原文顯示（以前 list.js 自己寫的 String(e?.message ?? e)） */
export const termRemoteErrorText = e => String(e?.message ?? e)

/** 確認、忘記失敗：只有「沒設螢幕鎖」的說明原樣顯示，其他一律說白話 */
export function knownPeerErrorText(e) {
  const s = String(e?.message ?? e ?? '')
  if (s.includes('螢幕鎖')) return s
  return KNOWN_PEER_FAILED_TEXT
}

/** 查詢代碼操作失敗：後台說「尚未登入」就請使用者先登入，其他一律說白話；原文由出口寫進 ui.log。文字表由呼叫端傳入（避免跟 quota-readers 互相引用） */
export const quotaShareErrorText = (e, text) => (/尚未登入/.test(typeof e === 'string' ? e : e?.message ?? '') ? text.failLogin : text.failShare)
