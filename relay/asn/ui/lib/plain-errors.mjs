// 錯誤轉白話的集中處（#2106 ②）。各畫面檔不再自己寫「把錯誤原文轉成給人看的一句話」，改從這裡拿。
// 純函式，不碰 DOM、不碰 Tauri。原文由 ui/lib/tauri.mjs 的出口寫進 log，這裡只管畫面上顯示什麼。

// 手機「認得的電腦」操作沒成功的通用白話
export const KNOWN_PEER_FAILED_TEXT = '操作沒有成功，請稍後再試。'

/** 預設：沒有對照時，畫面顯示的就是錯誤原文（和以前直接放 e.message 一樣） */
export const plainMessage = e => e.message

/** 設備細部頁安裝 Claude Code 失敗：字串或 Error 都原文顯示（以前 agent-install.mjs 自己的 errText） */
export const agentSetupErrorText = e => (typeof e === 'string' ? e : e?.message || String(e))

/** 改名失敗：後台（Rust）回的是中文說明就原樣顯示，其他一律說白話 */
export function renameErrorText(e) {
  const s = String(e?.message ?? e ?? '').trim()
  return /[一-鿿]/.test(s) && s.length <= 120 ? s : KNOWN_PEER_FAILED_TEXT
}

/** 確認、忘記失敗：只有「沒設螢幕鎖」的說明原樣顯示，其他一律說白話 */
export function knownPeerErrorText(e) {
  const s = String(e?.message ?? e ?? '')
  if (s.includes('螢幕鎖')) return s
  return KNOWN_PEER_FAILED_TEXT
}
