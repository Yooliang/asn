// 手機查看電腦終端前的本人確認：叫外殼（AsnBridge.kt 的 confirmViewer）跳生物辨識或螢幕鎖。
// 回傳只有三種：'ok'（通過）｜'cancel'（取消、失敗、逾時，或外殼不存在／出錯）｜'no_lock'（這支手機沒設螢幕鎖）。
// 外殼不存在或出錯一律回 'cancel'，絕不回 'ok'。每次查看都要叫一次，這裡不記住上一次的結果。
export const NO_LOCK_TEXT = '這支手機沒有設定螢幕鎖，請先設定再查看終端'
export const CONFIRM_TIMEOUT_MS = 120_000
const HOOK = '__asnConfirmViewer'   // 外殼把結果交回網頁的函式：window.__asnConfirmViewer(callbackId, result)
const RESULTS = ['ok', 'cancel', 'no_lock']

let seq = 0

export async function confirmViewer(win = globalThis, timeoutMs = CONFIRM_TIMEOUT_MS) {
  const bridge = win?.AsnAndroid
  if (!bridge || typeof bridge.confirmViewer !== 'function') return 'cancel'
  const id = `cv${Date.now().toString(36)}-${++seq}`
  return new Promise(resolve => {
    let done = false
    let timer = null
    const prev = win[HOOK]
    const finish = r => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      win[HOOK] = prev
      resolve(RESULTS.includes(r) ? r : 'cancel')
    }
    win[HOOK] = (cbId, r) => {
      if (cbId === id) finish(r)
      else if (typeof prev === 'function') prev(cbId, r)
    }
    timer = setTimeout(() => finish('cancel'), timeoutMs)
    try { bridge.confirmViewer(id) } catch { finish('cancel') }
  })
}
