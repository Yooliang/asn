// 手機查看電腦終端前的本人確認：叫外殼（AsnBridge.kt 的 confirmViewer）跳生物辨識或螢幕鎖。
// 回傳只有三種：'ok'（通過）｜'cancel'（取消、失敗、逾時，或外殼不存在／出錯）｜'no_lock'（這支手機沒設螢幕鎖）。
// 外殼不存在或出錯一律回 'cancel'，絕不回 'ok'。每次查看都要叫一次，這裡不記住上一次的結果。
export const NO_LOCK_TEXT = '這支手機沒有設定螢幕鎖，請先設定再查看終端'
export const CONFIRM_TIMEOUT_MS = 120_000
const HOOK = '__asnConfirmViewer'   // 外殼把結果交回網頁的函式：window.__asnConfirmViewer(callbackId, result)
const RESULTS = ['ok', 'cancel', 'no_lock']
// 掃 QR code 核對指紋（外殼的 scanFingerprint）多出來的狀態字；掃到的字不會交回網頁，只有這些狀態
const SCAN_RESULTS = [...RESULTS, 'denied', 'no_camera', 'bad_qr']

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

/**
 * 用相機掃電腦設定頁上的指紋 QR code（外殼的 scanFingerprint）：challenge 是 Rust 剛發的 scan 憑證。
 * 外殼開相機、掃到後跳本人確認，通過才把掃到的字存進 App 私有資料夾給 Rust 讀；**這裡只拿得到狀態字，拿不到掃到的字**。
 * 回 'ok'（掃到而且本人確認過）｜'cancel'｜'no_lock'｜'denied'（相機權限被拒）｜'no_camera'（沒有相機）｜'bad_qr'（掃到的字太長，不是 ASN 的 QR code）；
 * 外殼不存在、憑證格式不對、任何意外一律 'cancel'
 */
export async function scanFingerprint(challenge, win = globalThis, timeoutMs = CONFIRM_TIMEOUT_MS) {
  if (!/^[0-9a-f]{64}$/.test(String(challenge ?? ''))) return 'cancel'
  return run(win, timeoutMs, 'scanFingerprint', String(challenge), SCAN_RESULTS)
}

async function run(win, timeoutMs, method, token, allowed = RESULTS) {
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
      resolve(allowed.includes(r) ? r : 'cancel')
    }
    win[HOOK] = (cbId, r) => {
      if (cbId === id) finish(r)
      else if (typeof prev === 'function') prev(cbId, r)
    }
    timer = setTimeout(() => finish('cancel'), timeoutMs)
    try { if (token === undefined) bridge[method](id); else bridge[method](id, token) } catch { finish('cancel') }
  })
}
