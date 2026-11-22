// 電腦版設備頁「重新登入 Claude」（#1645）：確認 → 送出 → 看結果。
// 別台：和手機同一套請求（setup_remote_request／setup_remote_status，mode 'relogin'）與同一份結果判斷（mobile-setup.mjs 的純函式），
//   指令與後台把關沒有改；登入網址照 #1599 送到本人的手機（電腦版沒有「要你確認」頁），畫面照實講。
// 本機：本人就在這台電腦前，直接開官方登入終端（ai_cli_login），不送網址、不經手機；開了以後每幾秒讀一次本機帳號，登入好就停，最多 5 分鐘。
// 狀態機只在這裡；手機（m.js）沒動。給人看的文字純繁體中文。
import { makeReloginApi } from './tauri.mjs'
import { reloginErrorText } from './plain-errors.mjs'
import { POLL_MS as SETUP_POLL_MS, RELOGIN_TEXT, SETUP_TEXT, setupErrorText, setupLeadOf, setupStateOf, setupStep } from './mobile-setup.mjs'

export const DESK_RELOGIN_TEXT = Object.freeze({
  button: RELOGIN_TEXT.button,
  remoteTitle: label => RELOGIN_TEXT.confirmTitle(label),
  remoteBody: '這台電腦回報 Claude 的登入失效了。確認後，那台電腦會把登入網址送到你的手機，請在手機上打開網址、貼回授權碼，電腦版這裡不會顯示網址。如果那台目前登入正常，會告訴你不需要重新登入。',
  remoteNeed: RELOGIN_TEXT.confirmNeed,
  remoteYes: RELOGIN_TEXT.yes,
  localTitle: '要在這台電腦重新登入 Claude 嗎？',
  localBody: '會開啟官方的 Claude 登入視窗，請在視窗裡完成登入。不會安裝或更新任何東西，也不會把網址送到手機。',
  localYes: '開始登入',
  no: '先不要',
  close: '關閉',
  sending: '正在送出要求…',
  taken: '那台電腦已接手。登入網址會送到你的手機，請在手機上打開網址並貼回授權碼。',
  expired: '那台電腦沒有接手，要求已過期；請確認它開著 ASN 並登入著同一個 ASN 帳號，再試一次。',
  localOpened: '已開啟登入視窗，請在裡面完成登入；登入完成後這裡會自動變成已登入。',
  localDone: '已登入。',
  localWaitOut: '還沒看到登入完成。如果已經登入了，請稍後再看這一頁；沒有的話可以再按一次重新登入。',
  localFailed: '沒有開始登入',
})

/** 本機登入的觀察：每幾秒讀一次本機帳號，最多 5 分鐘 */
export const LOCAL_POLL_MS = 3000
export const LOCAL_GIVE_UP_MS = 5 * 60 * 1000

// 手機版的結果文字提到「這支手機」「允許從手機安裝並登入」：電腦版換成對應的說法，其餘（失敗原因、完成、沒有回應）原樣
const deskText = t => (t === SETUP_TEXT.taken ? DESK_RELOGIN_TEXT.taken : t === SETUP_TEXT.expired ? DESK_RELOGIN_TEXT.expired : t)

const fresh = () => ({ node: '', kind: 'remote', stage: 'idle', since: 0, saw: false, reached: false, fails: 0, lead: '', text: '', note: '', ok: false })

/**
 * stage：idle（只有按鈕）→ confirm → sending → waiting → done。kind：'remote'（別台）｜'local'（本機）。
 * checkLoggedIn：本機用，回 true＝這台 Claude 已經登入且沒有失效旗標。
 */
export function createReloginFlow({ invoke, reactive, checkLoggedIn = async () => false, onDone = () => {}, now = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  const api = makeReloginApi(invoke)   // 指令名與參數在 tauri.mjs；invoke 仍由呼叫端注入（測試換假的）
  const s = reactive(fresh())
  let timer = null
  const stopTimer = () => { if (timer !== null) { clearIntervalFn(timer); timer = null } }
  const reset = () => { stopTimer(); Object.assign(s, fresh()) }
  const finish = (text, ok, note = '') => { stopTimer(); Object.assign(s, { stage: 'done', ok, text, note }); try { onDone(ok, s.node) } catch (e) { console.info('[重新登入] 完成後重讀列表失敗', String(e)) } }

  const ask = (node, kind = 'remote') => {
    if (s.stage === 'sending' || s.stage === 'waiting') return   // 進行中不重來
    reset()
    Object.assign(s, { node: String(node ?? ''), kind: kind === 'local' ? 'local' : 'remote', stage: 'confirm' })
  }
  const no = () => { if (s.stage === 'confirm') reset() }
  const close = () => { if (s.stage === 'done') reset() }

  const pollRemote = async () => {
    const node = s.node
    if (!node || s.kind !== 'remote' || s.stage !== 'waiting') return
    let res = { ok: true, st: null }
    try { res = { ok: true, st: setupStateOf((await api.remoteStatus())?.nodes, node) } } catch { res = { ok: false } }
    if (s.node !== node || s.stage !== 'waiting') return
    const { next, view } = setupStep({ since: s.since, saw: s.saw, reached: s.reached, fails: s.fails }, res, now())
    Object.assign(s, { saw: next.saw, reached: next.reached, fails: next.fails })
    if (!view) return
    if (view.done) return finish(deskText(view.text), view.ok, view.note)
    Object.assign(s, { text: deskText(view.text), note: view.note, ok: view.ok })
  }

  const pollLocal = async () => {
    if (s.kind !== 'local' || s.stage !== 'waiting') return
    let ok = false
    try { ok = (await checkLoggedIn()) === true } catch { ok = false }
    if (s.kind !== 'local' || s.stage !== 'waiting') return
    if (ok) return finish(DESK_RELOGIN_TEXT.localDone, true)
    if (now() - s.since > LOCAL_GIVE_UP_MS) finish(DESK_RELOGIN_TEXT.localWaitOut, false)
  }

  const yes = async () => {
    if (s.stage !== 'confirm') return
    const node = s.node
    if (s.kind === 'local') {
      s.stage = 'sending'; s.text = DESK_RELOGIN_TEXT.sending
      try { await api.cliLogin('claude') } catch (e) { return finish(`${DESK_RELOGIN_TEXT.localFailed}：${reloginErrorText(e)}`, false) }
      Object.assign(s, { stage: 'waiting', since: now(), text: DESK_RELOGIN_TEXT.localOpened })
      timer = setIntervalFn(() => void pollLocal(), LOCAL_POLL_MS)
      return
    }
    s.stage = 'sending'; s.text = DESK_RELOGIN_TEXT.sending
    let sent = null
    try { sent = await api.remoteRequest(node) } catch (e) {
      if (s.node !== node) return
      return finish(setupErrorText(e), false)
    }
    if (s.node !== node) return
    Object.assign(s, { stage: 'waiting', since: now(), text: SETUP_TEXT.pending, lead: setupLeadOf(sent) })
    timer = setIntervalFn(() => void pollRemote(), SETUP_POLL_MS)
    void pollRemote()
  }

  return { state: s, ask, no, yes, close, stop: stopTimer, pollRemote, pollLocal }
}

/** 給設備細部頁的資料（純資料）。畫面用 target 對照現在看的那台，不是這一輪要求的那台就當沒有 */
export const reloginSnap = s => ({ target: s.node, kind: s.kind, stage: s.stage, lead: s.lead, text: s.text, note: s.note, ok: s.ok })
