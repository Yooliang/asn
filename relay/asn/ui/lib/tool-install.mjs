// 設定頁「已安裝的工具」Claude 那一列的「進行安裝／進行更新」（#1548 ⑤）。純邏輯，node 與瀏覽器都能跑。
// 真正的下載、驗簽章、安裝都在後端 ai_cli_install（已驗過的流程）；這裡只決定「鈕出不出現」與「確認、進度、結果」三段畫面。
// 其他家（Codex、Gemini、Grok、pi）完全不放鈕，另開單（Codex、Gemini 也接上）。

/**
 * 入口旗標：預設關，一般使用者看不到（旗標關＝畫面上沒有這顆鈕，不是灰掉）。
 * 擁有者在家用機跑完一次安裝與一次更新之後，另開小 PR 改成 true。與 AGENT_INSTALL_UI（設備頁的「安裝並登入」）互不相干。
 */
export const LAUNCH_INSTALL_BTN = false

export const TOOL_INSTALL_TEXT = Object.freeze({
  install: '進行安裝',
  update: '進行更新',
  confirmInstall: '要在這台電腦安裝 Claude 嗎？ASN 會下載 Claude 的官方安裝程式，驗過數位簽章才執行；裝好後會開一個終端機視窗讓你登入。',
  confirmUpdate: '要把這台電腦的 Claude 更新到最新版嗎？ASN 會下載 Claude 的官方安裝程式，驗過數位簽章才執行；完成後會開一個終端機視窗讓你確認登入。',
  yesInstall: '同意並安裝',
  yesUpdate: '同意並更新',
  no: '先不要',
  runningInstall: '正在安裝 Claude，請稍候…',
  runningUpdate: '正在更新 Claude，請稍候…',
  doneInstall: '已安裝完成。',
  doneUpdate: '已更新完成。',
  doneLogin: '請在剛開啟的終端機視窗登入。',
  failInstall: '這次沒有安裝成功，可以再按一次「進行安裝」；原因已記在記錄裡。',
  failUpdate: '這次沒有更新成功，可以再按一次「進行更新」；原因已記在記錄裡。',
})

const errText = e => (typeof e === 'string' ? e : e?.message || String(e))

/**
 * 這一列該不該有鈕：旗標開、只有 Claude、這台能由 ASN 安裝（install_available，目前只有 Windows）才可能有。
 * 沒裝 → install；裝了且狀態是「有新版」→ update；已是最新版、暫時查不到、裝了但查不到最新 → 不放。
 * → 'install' | 'update' | null
 */
export function installBtnKind({ enabled = LAUNCH_INSTALL_BTN, toolId, installAvail, installed, status } = {}) {
  if (enabled !== true || toolId !== 'claude' || installAvail !== true) return null
  if (installed === false) return 'install'
  if (installed === true && status?.version_state === 'behind' && status.latest) return 'update'
  return null
}

/**
 * 這一列畫面要的東西。ui＝{ stage: 'idle'|'confirm'|'running'|'done', kind, ok, text }（見 createToolInstall）。
 * 進度與結果在原位顯示：只要這一列還在進行或剛結束，就算鈕的條件變了（裝好後狀態重查）也留著那行字。
 */
export function installRowView({ enabled = LAUNCH_INSTALL_BTN, toolId, installAvail, installed, status, ui = {} } = {}) {
  if (enabled !== true || toolId !== 'claude' || installAvail !== true) return null
  const stage = ui.stage ?? 'idle'
  const live = installBtnKind({ enabled, toolId, installAvail, installed, status })   // 以現在的狀態算：裝好重查後鈕就消失，失敗則仍在、可再按
  const kind = stage === 'idle' ? live : (ui.kind ?? null)
  if (!kind) return null
  const upd = kind === 'update'
  return {
    kind,
    label: (live ?? kind) === 'update' ? TOOL_INSTALL_TEXT.update : TOOL_INSTALL_TEXT.install,
    showButton: (stage === 'idle' || stage === 'done') && live !== null,
    liveKind: live,
    confirm: stage === 'confirm' ? { text: upd ? TOOL_INSTALL_TEXT.confirmUpdate : TOOL_INSTALL_TEXT.confirmInstall, yes: upd ? TOOL_INSTALL_TEXT.yesUpdate : TOOL_INSTALL_TEXT.yesInstall, no: TOOL_INSTALL_TEXT.no } : null,
    running: stage === 'running' ? (upd ? TOOL_INSTALL_TEXT.runningUpdate : TOOL_INSTALL_TEXT.runningInstall) : '',
    result: stage === 'done' ? { ok: ui.ok === true, text: ui.text ?? '' } : null,
  }
}

/**
 * 確認 → 進度 → 結果的狀態機。invoke＝後端呼叫（ai_cli_install）；refresh＝完成（成功或失敗）後重跑狀態檢查；log＝原始訊息只進記錄。
 * 按下「進行安裝／進行更新」只會打開確認；同意才呼叫後端；取消不呼叫。
 */
export function createToolInstall({ reactive, install, refresh = async () => {}, log = () => {} }) {
  const s = reactive({ stage: 'idle', kind: null, ok: null, text: '' })
  const ask = kind => {
    if (s.stage === 'running' || (kind !== 'install' && kind !== 'update')) return
    s.kind = kind; s.ok = null; s.text = ''; s.stage = 'confirm'
  }
  const decline = () => { if (s.stage === 'confirm') { s.stage = 'idle'; s.kind = null } }
  const confirm = async () => {
    if (s.stage !== 'confirm') return
    const upd = s.kind === 'update'
    s.stage = 'running'
    try {
      const r = await install('claude')
      if (r?.ok === true) {
        s.ok = true
        s.text = (upd ? TOOL_INSTALL_TEXT.doneUpdate : TOOL_INSTALL_TEXT.doneInstall) + (r.opened_login === true ? TOOL_INSTALL_TEXT.doneLogin : '')
      } else {
        s.ok = false; s.text = upd ? TOOL_INSTALL_TEXT.failUpdate : TOOL_INSTALL_TEXT.failInstall
        log('claude 安裝／更新沒有成功', r?.message ?? '')
      }
    } catch (e) {
      s.ok = false; s.text = upd ? TOOL_INSTALL_TEXT.failUpdate : TOOL_INSTALL_TEXT.failInstall
      log('claude 安裝／更新呼叫失敗', errText(e))
    }
    s.stage = 'done'
    try { await refresh() } catch (e) { log('安裝後重查狀態失敗', errText(e)) }   // 重查失敗：結果那行字照留，狀態列由「重新檢查」再補
  }
  const clear = () => { if (s.stage === 'done') { s.stage = 'idle'; s.kind = null; s.ok = null; s.text = '' } }
  return { state: s, ask, decline, confirm, clear }
}
