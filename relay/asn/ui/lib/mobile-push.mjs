// 手機推播（#797 PR③）的前端流程：App 關著也要響。權杖由外殼（Kotlin，FirebaseMessaging）向 Firebase 取得，經這裡交給 Rust（android_push_register），Rust 再交給後台。
// 規則（設計見私有文件 todo-next-797-push.md 的 ③）：
//   * 權杖不寫 log、不存任何地方（Firebase 自己存）、不進錯誤訊息；這個檔案的 log 只寫固定的字。
//   * 第一次在線回報成功之後才註冊：Rust 還沒回報過會回 not_ready，這裡隔一會兒再取一次權杖重試（最多 PUSH_MAX_RETRY 次）。
//   * 系統通知權限只問一次（外殼記下已問過）：被拒之後不再問，使用者要自己到系統設定開。
//   * 登出、換帳號：先取消後台的權杖，再請外殼刪掉 Firebase 的權杖；取消失敗也照樣刪。
//   * 沒有 Firebase（沒放 google-services.json 的建置、沒有 Google 服務的手機）：state 是 unavailable，什麼都不做。
// 這個檔案不碰瀏覽器、不碰 Tauri：外殼（native）、註冊與取消（register／unregister）、計時都從外面注入，好測（見 test/mobile-push.test.mjs）。
//   native：{ state() → unavailable|ask|granted|denied, askPermission(), requestToken(), deleteToken(), onEvent(fn) → 取消訂閱 }
//   外殼事件：{t:'perm',granted} {t:'token',token} {t:'token-error'} {t:'refresh'}（Firebase 換了新權杖，要重新取）
export const PUSH_RETRY_MS = 15_000
export const PUSH_MAX_RETRY = 8
export const PUSH_SYNC_MIN_MS = 60_000   // 回到前景很頻繁：同一段時間內不重複同步

// 和後台、Rust 一致：只看長度與字元集，不信任內容
const TOKEN_RE = /^[A-Za-z0-9_:-]{32,1024}$/
export const isPushToken = t => typeof t === 'string' && TOKEN_RE.test(t)

export function createPushSync({ native, register, unregister, signedIn = () => true, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let lastTry = -Infinity, retries = 0, timer = 0, off = null, stopped = false
  const stopTimer = () => { clearTimer(timer); timer = 0 }
  const retryLater = () => {
    if (retries >= PUSH_MAX_RETRY || timer) return
    retries++
    timer = setTimer(() => { timer = 0; if (!stopped && signedIn()) native.requestToken() }, PUSH_RETRY_MS)
  }
  async function onToken(token) {
    if (!isPushToken(token)) { log('push: 權杖格式不對，不送'); return }
    try {
      await register(token)
      retries = 0; stopTimer()
      log('push: 已註冊')
    } catch (e) {
      const code = String(e?.message ?? e)
      if (code === 'not_ready') { log('push: 在線回報還沒成功，稍後再試'); retryLater() } else log('push: 註冊失敗')
    }
  }
  function onEvent(e) {
    if (!e || stopped) return
    if (e.t === 'token') void onToken(e.token)
    else if (e.t === 'perm') { if (e.granted === true) sync(true) }
    else if (e.t === 'refresh') sync(true)
    else if (e.t === 'token-error') { log('push: 取不到權杖'); retryLater() }
  }
  /** 回到前景、登入完成、第一次收信之後呼叫。force＝不看間隔（權限剛給、權杖換新） */
  function sync(force = false) {
    if (stopped || !signedIn()) return
    const t = now()
    if (!force && t - lastTry < PUSH_SYNC_MIN_MS) return
    lastTry = t
    const st = native.state()
    if (st === 'ask') native.askPermission()   // 結果用 perm 事件回來；外殼只問一次
    else if (st === 'granted') native.requestToken()
    // unavailable／denied：什麼都不做
  }
  /** 登出、換帳號：先取消後台的，再刪 Firebase 的權杖。取消失敗也照樣刪（後台的清除規則會補） */
  async function logout() {
    stopTimer(); retries = 0
    try { await unregister() } catch { log('push: 取消註冊沒成功，後台會自己清') }
    try { native.deleteToken() } catch { /* 外殼沒有就算了 */ }
  }
  function start() { off = native.onEvent(onEvent); return api }
  function stop() { stopped = true; stopTimer(); off?.(); off = null }
  const api = { sync, logout, start, stop, onEvent }
  return api
}
