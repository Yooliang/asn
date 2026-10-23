// 密碼請求確認窗（#26）的純邏輯：標題、說明文字、倒數秒數。畫面在 askpass.html／askpass.js；Rust 端在 src-tauri/src/askpass/。
// 同一扇確認窗之後也給 #23 的權限詢問用：kind 為 'permission' 時沒有輸入欄，只有「允許」「拒絕」。

/** 後端給的內容整理成畫面要顯示的樣子；缺的欄位用中文預設，kind 認不得就當 secret（要輸入、可取消，最保守） */
export function viewModel(info) {
  const i = info && typeof info === 'object' ? info : {}
  const kind = i.kind === 'permission' ? 'permission' : 'secret'
  const text = (v, empty) => (typeof v === 'string' && v.trim() ? v.trim() : empty)
  return {
    kind,
    // 遠端請求（#26 第二期）：別台電腦／雲端代理要密碼。設備名稱由後台查出，程式與用途是對方自報；核對碼是請求端公鑰指紋
    remote: typeof i.origin === 'string' && i.origin.trim() !== '',
    origin: text(i.origin, ''),
    fingerprint: text(i.fingerprint, ''),
    title: kind === 'permission' ? '有程式要求權限' : (typeof i.origin === 'string' && i.origin.trim() ? '別台電腦在向你要密碼' : '有程式要密碼'),
    program: text(i.program, '（無法辨識）'),
    cwd: text(i.cwd, '（沒有提供）'),
    prompt: text(i.prompt, '（程式沒有提供提示文字）'),
    secondsLeft: Number.isFinite(i.seconds_left) ? Math.max(0, Math.floor(i.seconds_left)) : 0,
    okText: kind === 'permission' ? '允許' : '確定',
    cancelText: kind === 'permission' ? '拒絕' : '取消',
  }
}

/** 倒數說明，例如「還剩 1 分 05 秒，逾時會自動取消」 */
export function countdownText(sec) {
  const s = Math.max(0, Math.floor(sec))
  if (s <= 0) return '時間到，正在取消…'
  const m = Math.floor(s / 60)
  const rest = String(s % 60).padStart(2, '0')
  return `還剩 ${m > 0 ? `${m} 分 ` : ''}${m > 0 ? rest : s} 秒，逾時會自動取消`
}

/** 網址參數 id 要是正整數才採用 */
export function parseId(search) {
  const v = new URLSearchParams(search).get('id')
  return /^[1-9][0-9]{0,15}$/.test(v ?? '') ? Number(v) : null
}
