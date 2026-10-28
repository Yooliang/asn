// 設定頁「檢視記錄」（#339）：用系統預設程式開機器資料夾的 ui.log；開不了（例如還沒寫過記錄）就退回開記錄資料夾，
// 並回一句畫面要顯示的說明（空字串＝順利開了檔，不用說什麼）。
// 路徑一律由後端決定：兩個指令都不帶任何參數，前端沒辦法指定要開哪個檔。

export const VIEW_LOG_TEXT = {
  fallback: '記錄檔打不開，已改開記錄資料夾',
  failed: '記錄資料夾也打不開',
}

const reason = e => String(e?.message ?? e)

/** invoke＝Tauri 的指令呼叫；log＝失敗原因寫到哪（預設 console.info，[ASN] 開頭會一併進 ui.log） */
export async function openUiLog(invoke, log = (...a) => console.info(...a)) {
  try {
    await invoke('open_ui_log')
    return ''
  } catch (e) {
    log('[ASN] 開啟記錄檔失敗', reason(e))
  }
  try {
    await invoke('open_machine_log_dir')
    return VIEW_LOG_TEXT.fallback
  } catch (e) {
    log('[ASN] 開啟記錄資料夾失敗', reason(e))
    return VIEW_LOG_TEXT.failed
  }
}
