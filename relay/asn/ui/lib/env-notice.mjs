// 夥伴清單上的提醒：使用者環境變數裡有看起來像金鑰的變數（共用終端服務開著才有）。句子由後端組好，只含變數名字。

/** 向後端要這句話；沒有、查不到、舊版後端沒有這個命令，一律回空字串（不顯示） */
export async function loadEnvNotice(transport) {
  try {
    const t = await transport?.termEnvNotice?.()
    return typeof t === 'string' ? t.trim() : ''
  } catch {
    return ''
  }
}
