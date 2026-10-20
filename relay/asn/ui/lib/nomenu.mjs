// 關掉網頁預設的右鍵選單（重新整理、檢查元素…）；可輸入文字的欄位保留（複製、貼上）。
// 自訂的右鍵選單（例如大頭貼）用 @contextmenu.prevent 自己處理，不受影響。
export function keepNativeMenu(el) {
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
}

export function blockContextMenu(doc) {
  doc.addEventListener('contextmenu', e => { if (!keepNativeMenu(e.target)) e.preventDefault() })
}
