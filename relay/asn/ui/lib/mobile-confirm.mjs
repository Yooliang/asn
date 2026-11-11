// 手機查看電腦終端前的本人確認：叫外殼（AsnBridge.kt 的 confirmViewer）跳生物辨識或螢幕鎖。
// 回傳只有三種：'ok'（通過）｜'cancel'（取消、失敗、逾時，或外殼不存在／出錯）｜'no_lock'（這支手機沒設螢幕鎖）。
// 外殼不存在或出錯一律回 'cancel'，絕不回 'ok'。每次查看都要叫一次，這裡不記住上一次的結果。
export const NO_LOCK_TEXT = '這支手機沒有設定螢幕鎖，請先設定再查看終端'
export const CONFIRM_TIMEOUT_MS = 120_000
const HOOK = '__asnConfirmViewer'   // 外殼把結果交回網頁的函式：window.__asnConfirmViewer(callbackId, result)
const RESULTS = ['ok', 'cancel', 'no_lock']

let seq = 0

export async function confirmViewer(win = globalThis, timeoutMs = CONFIRM_TIMEOUT_MS) {
  return run(win, timeoutMs, 'confirmViewer')
}

/**
 * 「記住這台」「忘記」前的本人確認：challenge 是 Rust 剛發的一次性憑證（64 個小寫十六進位字元）。
 * 外殼只開生物辨識或螢幕鎖，驗證通過的那一刻才由外殼寫憑證檔；Rust 之後核對檔案才算數。這裡沒有任何能寫檔的呼叫。
 * 回傳和 confirmViewer 一樣：'ok'｜'cancel'｜'no_lock'；外殼不存在、憑證格式不對一律 'cancel'
 */
export async function confirmWithToken(challenge, win = globalThis, timeoutMs = CONFIRM_TIMEOUT_MS) {
  if (!/^[0-9a-f]{64}$/.test(String(challenge ?? ''))) return 'cancel'
  return run(win, timeoutMs, 'confirmWithToken', String(challenge))
}

async function run(win, timeoutMs, method, token) {
  const bridge = win?.AsnAndroid
  if (!bridge || typeof bridge[method] !== 'function') return 'cancel'
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
    try { if (token === undefined) bridge[method](id); else bridge[method](id, token) } catch { finish('cancel') }
  })
}
