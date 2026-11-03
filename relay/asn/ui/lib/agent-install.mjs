// 設備細部頁「安裝並登入 Claude Code」（todo-next-174 的 E2，#650）：確認窗、進度、取消、結果，以及「允許從手機替這台安裝並登入」開關。
// 真正的安裝、驗證、登入全在 Rust（agent_setup）；這裡只呼叫指令、聽事件、整理成畫面要的資料。
// 事件（agent-setup）的內容全是固定句子，不含網址、授權碼、路徑；本人簽章不經過前端。
import { applyEvent, canCancel, initialView, requestCancel, statusLines } from './setup-progress.mjs'

export const INSTALL_TEXT = Object.freeze({
  button: '安裝並登入 Claude Code',
  needLogin: '請先登入你的 ASN 帳號',
  confirmTitle: '要在這台電腦安裝並登入 Claude Code 嗎？',
  confirmYes: '確認安裝',
  confirmNo: '先不要',
  cancel: '取消',
  close: '關閉',
  openTerminal: '開啟終端機',
  progressNote: '進度也會顯示在螢幕右下角的小視窗。',
  allowRemote: '允許從手機替這台安裝並登入',
  allowRemoteNote: '預設關閉。打開後，用同一個 ASN 帳號從手機要求時，這台電腦會在右下角跳出進度並開始安裝；你人在電腦前可以隨時取消。',
  startFailed: '沒有開始',
})

const errText = e => (typeof e === 'string' ? e : e?.message || String(e))

/** 結果的種類（畫面用來決定顏色與按鈕）：還沒有結果是 '' */
export function resultKind(view) {
  if (!view?.done) return ''
  if (view.cancelled) return 'cancelled'
  if (view.ok) return view.already ? 'already' : view.keptLogin ? 'kept' : 'ok'
  return view.terminal ? 'terminal' : 'failed'
}

/** 按鈕狀態：沒登入 ASN 帳號不能按（旁邊寫原因）；正在做的時候也不能再按 */
export function installButton({ signedIn, running }) {
  if (running) return { disabled: true, hint: '' }
  if (signedIn !== true) return { disabled: true, hint: INSTALL_TEXT.needLogin }
  return { disabled: false, hint: '' }
}

/** stage：idle（只有按鈕）→ confirm（確認窗）→ running（進度）→ done（結果） */
export function createAgentInstall({ invoke, reactive, signedIn = async () => false }) {
  const s = reactive({ stage: 'idle', plan: '', signedIn: false, view: initialView(), msg: '', remoteAllow: false })

  const load = async () => {
    try { s.signedIn = (await signedIn()) === true } catch { s.signedIn = false }
    // 讀不到就當關：不會因為讀取失敗而悄悄變成開（真正擋不擋由 Rust 端照存檔判斷）
    try { s.remoteAllow = (await invoke('agent_setup_remote_allow_get')) === true } catch { s.remoteAllow = false }
  }
  const ask = async () => {
    s.msg = ''
    await load()
    if (s.stage === 'running') return
    if (!s.signedIn) { s.msg = INSTALL_TEXT.needLogin; return }
    try { s.plan = String(await invoke('agent_setup_plan')) } catch (e) { s.msg = errText(e); return }
    s.stage = 'confirm'
  }
  const decline = () => { if (s.stage === 'confirm') s.stage = 'idle' }
  const confirm = async () => {
    if (s.stage !== 'confirm') return
    s.msg = ''
    s.view = initialView()
    try {
      await invoke('agent_setup_start', { confirmed: true })
      s.stage = 'running'
    } catch (e) {
      s.stage = 'idle'
      s.msg = `${INSTALL_TEXT.startFailed}：${errText(e)}`
    }
  }
  const cancel = async () => {
    if (s.stage !== 'running' || !canCancel(s.view)) return
    s.view = requestCancel(s.view)
    try { await invoke('agent_setup_cancel') } catch { /* 略過：取消只是請它在這一步做完後停下 */ }
  }
  // agent-setup 事件：手機要求的那一輪也會來，照樣顯示（人在電腦前看得到）
  const onEvent = e => {
    if (!e || typeof e !== 'object') return
    // 新的一輪開始（包含手機要求的那一輪、上一輪結果還在畫面上時）：從頭顯示
    if (e.phase === 'reset' || s.stage !== 'running') { s.view = initialView(); s.stage = 'running' }
    if (e.phase === 'reset') return
    s.view = applyEvent(s.view, e)
    if (s.view.done) s.stage = 'done'
  }
  const dismiss = () => { if (s.stage === 'done') { s.stage = 'idle'; s.view = initialView() } }
  const openTerminal = async () => {
    try { await invoke('ai_cli_login', { toolId: 'claude' }) } catch (e) { s.msg = errText(e) }
  }
  const setRemoteAllow = async on => {
    try { await invoke('agent_setup_remote_allow_set', { on: on === true }); s.remoteAllow = on === true } catch (e) { s.msg = errText(e) }
  }
  return { state: s, load, ask, decline, confirm, cancel, onEvent, dismiss, openTerminal, setRemoteAllow }
}

/** 給設備細部頁的資料（純資料，不含函式）。要不要顯示按鈕由畫面看這台 Claude 的 installAction 決定 */
export function installView(s) {
  const btn = installButton({ signedIn: s.signedIn, running: s.stage === 'running' })
  return {
    stage: s.stage, plan: s.plan, msg: s.msg, remoteAllow: s.remoteAllow,
    button: btn,
    lines: statusLines(s.view), title: s.view.title, kind: resultKind(s.view),
    canCancel: s.stage === 'running' && canCancel(s.view),
    terminal: s.view.terminal === true,
  }
}
