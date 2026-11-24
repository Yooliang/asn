// 「這台電腦還沒有 AI 夥伴，選一個開始」新手引導卡（#1605）的純邏輯：什麼時候出現、四家各給什麼動作、要說的話。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。狀態一律沿用既有判斷（device-state.mjs 的 vendorState／installAction），不另寫偵測。
// 電腦版（list.js）與手機版（m.js）用同一份：電腦版看本機偵測，手機版看那台電腦的設備卡狀態。
import { AGENT_INSTALL_UI, STATE, installAction, vendorState } from './device-state.mjs'
import { normalizeSearchQuery } from './search.mjs'
import { getLocal, removeLocal, setLocal } from './local-prefs.mjs'

/** 「先不用」記在本機的鍵（本機偏好，經 local-prefs.mjs；電腦版、手機版各自記） */
export const GUIDE_HIDDEN_KEY = 'asnNewComputerGuideHidden'

export function loadGuideHidden(storage) {
  return getLocal(GUIDE_HIDDEN_KEY, storage) === '1'
}
export function saveGuideHidden(hidden, storage) {
  if (hidden) setLocal(GUIDE_HIDDEN_KEY, '1', storage); else removeLocal(GUIDE_HIDDEN_KEY, storage)   // 存不進去（私密模式等）就當沒記
}

/**
 * 同一時間只跑一份：正在跑時再呼叫，回同一個 promise（不重跑第二份）；跑完才可以再開下一份。
 * 「重新檢查」連按、開新夥伴對話框同時要求偵測時用，免得同時打好幾次偵測。
 */
export function singleFlight(fn) {
  let cur = null
  return (...args) => {
    if (cur) return cur
    cur = Promise.resolve().then(() => fn(...args)).finally(() => { cur = null })
    return cur
  }
}

export const GUIDE_TEXT = Object.freeze({
  recheck: '重新檢查',
  title: '這台電腦還沒有 AI 夥伴，選一個開始',
  open: '開一個視窗',
  login: '登入',
  install: '安裝並登入',
  checking: '正在檢查…',
  hide: '先不用',
  show: '顯示新手引導',
  // 手機：那台電腦沒打開從手機安裝的開關；用設定裡真正的字（agent-install.mjs 的 allowRemote）
  installSwitch: '到那台電腦的 設定 → 設備，勾選「允許從手機替這台安裝並登入」',
  loginHere: '已安裝，還沒登入。請在那台電腦上登入。',
  // 官網那行下面的小提醒：瀏覽器擋下載時怎麼放行
  edgeKeep: 'Edge 擋下載的話，按「…」→「保留」→「仍要保留」',
})

/** 四家，順序固定。tool＝ai_cli_detect 的工具代號；site＝官網（目錄 catalog 沒放網址，這裡是唯一來源） */
export const GUIDE_VENDORS = Object.freeze([
  { key: 'claude', label: 'Claude', tool: 'claude', siteName: 'Claude 官網', url: 'https://claude.com/product/claude-code', missing: '找不到 Claude Code。剛裝好的話，按下面的「重新檢查」。', missingRemote: '找不到 Claude Code。剛裝好的話，請在那台電腦上按「重新檢查」。' },
  { key: 'codex', label: 'Codex', tool: 'codex', siteName: 'Codex 官網', url: 'https://developers.openai.com/codex' },
  { key: 'gemini', label: 'Gemini', tool: 'agy', siteName: 'Gemini 官網', url: 'https://antigravity.google' },
  { key: 'grok', label: 'Grok', tool: 'grok', siteName: 'Grok 官網', url: 'https://docs.x.ai/build/overview' },
])

/** 要不要「考慮」顯示（不看有沒有按過「先不用」）：連線中、名單讀到了、沒在搜尋、這台電腦一個視窗也沒有 */
export function guideApplies({ conn = '', rosterLoaded = false, query = '', localWindows = 0 } = {}) {
  return conn === 'on' && rosterLoaded === true && !normalizeSearchQuery(query) && Number(localWindows) === 0
}
/** 卡片要不要顯示 */
export const guideVisible = (o = {}) => guideApplies(o) && o.hidden !== true
/** 「顯示新手引導」那一行要不要出現：卡片本來會出現、但被「先不用」收起來了 */
export const guideReshowVisible = (o = {}) => guideApplies(o) && o.hidden === true

/**
 * 本機四家的狀態（電腦版）。detected：ai_cli_detect 回來了；accountsReady：帳號讀過了；
 * installed：{ claude, codex, gemini, grok } → 布林；accounts：{ claude, codex, grok } → [{ email, current }]（Gemini 偵測不到登入，不看）
 * → { claude, codex, gemini, grok } 各是 STATE 鍵；還沒查好是 null
 */
export function localVendorStates({ detected = false, accountsReady = false, installed = {}, accounts = {} } = {}) {
  const out = {}
  for (const v of GUIDE_VENDORS) {
    if (!detected || !accountsReady) { out[v.key] = null; continue }
    // 沒裝就開不了視窗：就算帳號庫裡有帳號也算未安裝
    if (installed[v.key] !== true) { out[v.key] = STATE.NOT_INSTALLED; continue }
    out[v.key] = vendorState({ isSelf: true, accounts: accounts[v.key] ?? [], installed: true }).state
  }
  return out
}

/**
 * 四列。每列只有一個動作：
 *   { key, label, action: 'open'|'login'|'install'|null, checking, note?, site?: { before, name, after, url }, loginHere? }
 * states：localVendorStates 的結果，或手機設備卡的狀態。
 * isSelf：本機（電腦版）；false＝手機看別台電腦，這時 remote 帶這台能做的事：{ login: {codex:true…}, install: {claude:true…} }（來自設備卡的 login／action）
 * installUi：安裝入口（AGENT_INSTALL_UI，預設照它）；installAvail：{ 工具代號: true }（ai_cli_detect 的 install_available）
 */
export function guideRows({ states = {}, isSelf = true, installUi = AGENT_INSTALL_UI, installAvail = {}, remote = {} } = {}) {
  return GUIDE_VENDORS.map(v => {
    const st = states[v.key] ?? null
    const base = { key: v.key, label: v.label, action: null, checking: false }
    if (st === null || st === STATE.UNKNOWN_INSTALL || st === STATE.NO_REPORT) return { ...base, checking: true }
    const canInstall = installUi === true && (isSelf ? (installAction({ vendor: v.key, isSelf: true, state: st })?.kind === 'local' || installAvail[v.tool] === true) : remote.install?.[v.key] === true)
    if (st === STATE.NOT_INSTALLED) {
      if (canInstall) return { ...base, action: 'install' }
      const note = (isSelf ? v.missing : v.missingRemote) ?? `還沒裝 ${v.label}，裝好後這裡會出現「開一個視窗」。`
      return { ...base, note, site: { before: '到 ', name: v.siteName, after: ' 下載安裝', url: v.url } }
    }
    // Gemini：ASN 偵測不到有沒有登入，裝了就直接開視窗
    if (v.key === 'gemini' || st === STATE.LOGGED_IN) return { ...base, action: 'open' }
    // 已安裝但沒登入／登入失效
    if (isSelf) return { ...base, action: 'login' }
    if (canInstall) return { ...base, action: 'install' }
    if (remote.login?.[v.key] === true) return { ...base, action: 'login' }
    return { ...base, note: GUIDE_TEXT.loginHere }
  })
}
