// 開新夥伴「每個廠牌自動用最好的開法」（#2354）：使用者只選廠牌，開法由這裡決定；手機（m.js）與電腦版（list.js）共用這一份。
// 純邏輯，node 與瀏覽器都能跑；不碰 DOM、不碰 Tauri。
import { customRunOptions, runOptions } from './model-catalog.mjs'
import { STATE } from './device-state.mjs'

/** 廠牌卡右邊的短標示。優先順序：尚未安裝 ＞ 尚未登入 ＞ 無終端畫面（反灰的原因比一般屬性重要） */
export const BADGE_TEXT = Object.freeze({ missing: '尚未安裝', loggedOut: '尚未登入', noTerm: '無終端畫面' })

/**
 * 廠牌 → 開法（擁有者 #2354 定案，對照表）：
 *   Claude、Codex          → 'term'（開在 ASN 終端，可以看畫面）
 *   Gemini、Grok           → 'acp'（背景通道，沒有終端畫面，收到信才起來）
 *   DeepSeek、MiniMax 等只能經 pi 的廠牌 → 'pi'（用 pi 開，帶提供者與模型）
 *   目錄外的自訂設定        → 照那台回報的 mode（背景＝acp，其餘＝term）
 * Gemini、Grok 的「asn終端（原生 cli）」收不到信，不再當作開法。
 */
export const AUTO_RUN = Object.freeze({ claude: 'term', codex: 'term', gemini: 'acp', grok: 'acp' })

/**
 * 這個廠牌這次要用哪種開法。row：廠牌列（目錄列、或 launchVendorCards／本機廠牌列）。
 * ctx：{ local（選的是這台電腦）, piInstalled（偵測到 pi）, piReady（ASN 能帶提供者與模型開 pi，且這家在 pi 有模型）, piWhy（經 pi 不能用時，pi 自己給的原因） }
 * 回 { run: 'term'|'acp'|'pi'|null, profile, ok, why }；ok＝這個開法現在能用，不能用時 why 是給使用者看的白話。
 */
export function autoRunFor(row, { local = false, piInstalled = false, piReady = false, piWhy = '' } = {}) {
  if (!row) return { run: null, profile: '', ok: false, why: '' }
  if (!row.channels) {   // 目錄外的自訂設定：只看 mode
    const c = customRunOptions(row)
    return { run: c.selected, profile: row.profileId ?? row.id ?? '', ok: true, why: '' }
  }
  const viaPi = row.viaPiOnly === true || row.id === 'pi'
  const run = viaPi ? 'pi' : AUTO_RUN[row.id] ?? ''
  if (!run) {   // 目錄裡沒有對照的新廠牌：沿用既有的優先序預設，但收不到信的終端不當預設
    const r = runOptions(row, { local, piInstalled, piReady })
    const sel = r.selected && !(r.selected === 'term' && row.channels?.term?.status === 'noinbox') ? r.selected : null
    return { run: sel, profile: sel === 'pi' ? 'pi' : (row.profileId ?? row.id), ok: Boolean(sel), why: sel ? '' : '這個廠牌現在沒有能用的開法' }
  }
  const r = runOptions(row, { local, piInstalled, piReady })
  const opt = r.options.find(o => o.key === run)
  const ok = Boolean(opt?.ok)
  const why = ok ? '' : (run === 'pi' && piWhy) || opt?.why || '這個廠牌現在不能開'
  return { run, profile: run === 'pi' ? 'pi' : (row.profileId ?? row.id), ok, why }
}

/**
 * 電腦版開在這台時送給後端（partner_launch_local）的內容。auto：autoRunFor 的結果。
 * 經 pi：profile 一律 pi，帶 piLaunchArgs 驗過的提供者與模型（viaPi＝{ provider, model }，沒有就回 null，不送）、只能開在前台；
 * 其他開法：送廠牌自己的 profile，帶顯示方式；型號（model）有選才帶；第一句話只有只能開在前台的（foregroundOnly）由後端送，其他開好後由畫面補送。
 */
export function localLaunchRequest(auto, { name = '', cwd = '', display = 'foreground', firstMessage = '', foregroundOnly = false, model = '', viaPi = null } = {}) {
  const base = { name: String(name).trim(), cwd }
  if (auto?.run === 'pi') return viaPi ? { profile: 'pi', ...base, display: 'foreground', first_message: String(firstMessage).trim(), pi_provider: viaPi.provider, pi_model: viaPi.model } : null
  return { profile: auto?.profile ?? '', ...base, display, first_message: foregroundOnly ? String(firstMessage).trim() : '', ...(model ? { model } : {}) }
}

/**
 * 廠牌卡的標示與是否反灰。row.installed：false＝沒裝；loggedOut：確定沒登入（只有拿到新鮮回報、或偵測得到時才傳 true）。
 * 只有「尚未安裝」反灰、不能選；「尚未登入」只標字樣（偵測可能是快取，不能因此擋住人），kind 讓畫面把它跟反灰的原因分開上色。
 */
export function launchBadge(row, { loggedOut = false } = {}) {
  if (row?.installed === false) return { text: BADGE_TEXT.missing, disabled: true, kind: 'missing' }
  if (loggedOut) return { text: BADGE_TEXT.loggedOut, disabled: false, kind: 'loggedOut' }
  if (row?.channels && row.mode === 'background') return { text: BADGE_TEXT.noTerm, disabled: false, kind: 'noTerm' }   // 自訂設定（沒有 channels）不加標示
  return { text: '', disabled: false, kind: '' }
}

/** 一串廠牌列 → 帶 badge（{ text, disabled }）與 disabled 的卡片。loggedOut：{ 廠牌 id: true } */
export const vendorCards = (rows, { loggedOut = {} } = {}) => (Array.isArray(rows) ? rows : []).map(r => {
  const badge = launchBadge(r, { loggedOut: loggedOut[r.id] === true })
  return { ...r, badge, disabled: badge.disabled }
})

/** 偵測得到登入狀態的廠牌：Gemini 沒有可靠的偵測方式，永遠不標「尚未登入」 */
export const LOGIN_KNOWN_VENDORS = Object.freeze(['claude', 'codex', 'grok'])
const OUT_STATES = [STATE.INSTALLED_LOGGED_OUT, STATE.LOGGED_OUT]

/** 本機：ai_cli_status 的結果（{ 工具代號: { login } }，login＝in／out／unknown）→ { 廠牌 id: true }；只認 claude、codex */
export function loggedOutFromCli(status) {
  const out = {}
  for (const id of ['claude', 'codex']) if (status?.[id]?.login === 'out') out[id] = true
  return out
}

/**
 * 別台（或本機的帳號庫）：設備樹裡這台各廠商的狀態（{ 廠牌 key: STATE }）→ { 廠牌 id: true }。
 * 只認「已安裝但沒登入」「沒登入」；沒收到回報、回報過期（NO_REPORT）、登入失效、不確定都不標（不說假話）。
 */
export function loggedOutFromStates(states, ids = LOGIN_KNOWN_VENDORS) {
  const out = {}
  for (const id of ids) if (OUT_STATES.includes(states?.[id])) out[id] = true
  return out
}

/** 設備樹上某台設備 → { 廠牌 key: STATE }（設備不存在回空物件） */
export const vendorStatesOf = dev => Object.fromEntries((Array.isArray(dev?.vendors) ? dev.vendors : []).filter(v => v?.key).map(v => [v.key, v.state]))
