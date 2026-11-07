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
export const PUSH_MAX_RETRY = 8   // 用完就不再自己重試：之後靠「回到前景」的同步再試一次就夠了（見 sync），不用一直計時
export const PUSH_UNREGISTER_MS = 5_000   // 登出、關掉時等後台取消的上限：不讓按鈕卡住。取消沒等到也照樣刪 Firebase 的權杖（刪權杖本身就會讓它失效，後台再靠失效回報或每天的清除收）
export const PUSH_SYNC_MIN_MS = 60_000   // 回到前景很頻繁：同一段時間內不重複同步

// 設定頁「通知」分頁的文字（只寫白話；內容要打開 App 才看得到）
export const PUSH_TEXT = {
  label: 'App 關著時也通知我',
  note: 'App 關著時，有新訊息會在手機上跳通知，只告訴你「有新訊息」，內容要打開 App 才看得到。',
  denied: '手機的通知權限是關的。要收到通知，請到手機的「設定」→「應用程式」→「ASN」→「通知」打開，再回到這裡。',
}

/** 設定頁這一列要怎麼顯示。state 是外殼回報的 unavailable／ask／granted／denied；on 是使用者的選擇。
 *  unavailable（沒有 Firebase）整列不顯示；開著但權限被拒時打勾仍留著，另外說明怎麼打開；還沒問過權限時勾著就是「第一次會問」。 */
export function pushSettingView(state, on) {
  if (state !== 'ask' && state !== 'granted' && state !== 'denied') return { show: false, checked: false, note: '', denied: '' }
  return { show: true, checked: on === true, note: PUSH_TEXT.note, denied: on === true && state === 'denied' ? PUSH_TEXT.denied : '' }
}

// 和後台、Rust 一致：只看長度與字元集，不信任內容
const TOKEN_RE = /^[A-Za-z0-9_:-]{32,1024}$/
export const isPushToken = t => typeof t === 'string' && TOKEN_RE.test(t)

export function createPushSync({ native, register, unregister, signedIn = () => true, enabled = () => true, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let lastTry = -Infinity, retries = 0, timer = 0, off = null, stopped = false
  const stopTimer = () => { clearTimer(timer); timer = 0 }
  const retryLater = () => {
    if (retries >= PUSH_MAX_RETRY || timer) return
    retries++
    timer = setTimer(() => { timer = 0; if (!stopped && signedIn() && enabled()) native.requestToken() }, PUSH_RETRY_MS)
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
    if (e.t === 'perm') onChange()
    if (!enabled()) return   // 使用者關掉了：不管外殼推什麼進來都不註冊
    if (e.t === 'token') void onToken(e.token)
    else if (e.t === 'perm') { if (e.granted === true) sync(true) }
    else if (e.t === 'refresh') sync(true)
    else if (e.t === 'token-error') { log('push: 取不到權杖'); retryLater() }
  }
  /** 回到前景、登入完成、第一次收信之後呼叫。force＝不看間隔（權限剛給、權杖換新） */
  function sync(force = false) {
    if (stopped || !signedIn() || !enabled()) return
    const t = now()
    if (!force && t - lastTry < PUSH_SYNC_MIN_MS) return
    lastTry = t
    const st = native.state()
    if (st === 'ask') native.askPermission()   // 結果用 perm 事件回來；外殼只問一次
    else if (st === 'granted') native.requestToken()
    // unavailable／denied：什麼都不做
  }
  /** 先取消後台的（最多等 PUSH_UNREGISTER_MS），再刪 Firebase 的權杖。取消失敗或逾時也照樣刪（後台的清除規則會補） */
  async function teardown(skipIfEnabled = false) {
    stopTimer(); retries = 0
    let giveUp = 0
    try {
      await Promise.race([unregister(), new Promise((_, rej) => { giveUp = setTimer(() => rej(new Error('timeout')), PUSH_UNREGISTER_MS) })])
    } catch { log('push: 取消註冊沒成功，後台會自己清') } finally { clearTimer(giveUp) }
    // 設定頁快速「關→開」：取消等了一陣子，這段時間使用者又打開了、新的權杖也可能已經註冊，這時刪權杖會把剛註冊的刪掉，所以還開著就不刪
    if (skipIfEnabled && enabled()) return
    try { native.deleteToken() } catch { /* 外殼沒有就算了 */ }
  }
  /** 登出、換帳號：取消並刪權杖，之後這個物件就停了（登出後畫面會重新載入，不再同步） */
  async function logout() {
    stopped = true
    await teardown()
  }
  /** 使用者在設定頁關掉：先取消後台的、再刪 Firebase 的權杖（和登出同一套，只是不「停掉」，之後還能再打開） */
  async function disable() { await teardown(true); onChange() }
  /** 使用者在設定頁打開：馬上同步（沒問過權限就在這時問，只問一次） */
  function enable() { lastTry = -Infinity; sync(true); onChange() }
  function start() { off = native.onEvent(onEvent); return api }
  function stop() { stopped = true; stopTimer(); off?.(); off = null }
  const api = { sync, logout, disable, enable, start, stop, onEvent }
  return api
}
