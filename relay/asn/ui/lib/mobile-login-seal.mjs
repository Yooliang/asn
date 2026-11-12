// 手機的登入資料沒能用系統金鑰庫加密、暫時用明文備援保存時，設定頁的帳號區塊提醒一句（Rust 命令 android_login_sealed）。
// 只有手機有這個命令；讀不到、命令不存在、回傳不是 false 一律不顯示（沒有東西要提醒）

export const LOGIN_UNSEALED_TEXT = '登入資料暫時沒有加密保存，下次開啟會再試'

/** invoke：和 tauri.mjs 的 invoke 同介面。回提醒文字；沒有要提醒就回空字串 */
export async function loginUnsealedNote(invoke) {
  try {
    return (await invoke('android_login_sealed')) === false ? LOGIN_UNSEALED_TEXT : ''
  } catch {
    return ''
  }
}
