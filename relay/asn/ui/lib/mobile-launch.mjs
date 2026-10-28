// 手機版「幫電腦開新夥伴」（遠端開視窗）的純邏輯：哪些電腦能開、為什麼不能、表單檢查、請求內容、進度文字、錯誤翻成中文。
// 視窗開在那台電腦上，手機只是下指令（後台 relay 的 launch／launchers，要本人簽章）。node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。
import { closedReasonOf, remoteModelRows } from './partner-launch-ui.mjs'
import { isDeviceRemoved } from './device-order.mjs'
import { runOptions, vendorRows } from './model-catalog.mjs'
import { cleanPiModels, piChoiceFor, piLaunchArgs, piOnlyVendorRows } from './pi-models.mjs'

export const REASON = {
  needLogin: '要先登入，才能替電腦開新夥伴',
  unknown: '還沒查到這台電腦的啟動設定，請稍後再試',
  offline: '這台電腦不在線',
  closed: '這台電腦沒有開放遠端開新夥伴，請到電腦的設定打開「允許我的其他設備替這台開新視窗」',
  noModel: '這台電腦還沒有可用的模型',
  noCwd: '這台電腦沒有開放的工作資料夾',
}
export const LAUNCH_POLL_MS = 3000
export const LAUNCH_GIVE_UP_MS = 3 * 60 * 1000   // 後台 2 分鐘內沒被取走就會自己標失敗；這裡多留一分鐘

// launchers 的回應 → 節點 → 那台的啟動設定
export const machinesByNode = body => Object.fromEntries((Array.isArray(body?.machines) ? body.machines : []).filter(m => m && typeof m.node === 'string').map(m => [m.node, m]))

// 這台電腦現在能不能開新夥伴；不能就回中文原因。ctx：{ machines（節點→設定）, loaded（查過了）, signedIn, friends }
export function launchEligibility(node, { machines = {}, loaded = false, signedIn = true, friends = [], authError = '' } = {}) {
  // null＝登入狀態還沒查到（或查詢失敗）：不能說成「要先登入」
  if (signedIn === null) return { ok: false, reason: authError ? `查不到登入狀態：${authError}` : '查詢中，請稍候…' }
  if (!signedIn) return { ok: false, reason: REASON.needLogin }
  if (!loaded) return { ok: false, reason: REASON.unknown }
  const m = machines[node]
  const online = m ? m.online === true : friends.some(f => f.node === node && f.status !== 'offline')
  if (!online) return { ok: false, reason: REASON.offline }
  const l = m?.launcher
  if (!l) return { ok: false, reason: closedReasonOf(m, REASON.closed) }
  if (!remoteModelRows(l).length) return { ok: false, reason: REASON.noModel }
  if (!cwdList(l).length) return { ok: false, reason: REASON.noCwd }
  return { ok: true, reason: '' }
}

export const cwdList = launcher => (Array.isArray(launcher?.cwd_allow) ? launcher.cwd_allow.filter(c => typeof c === 'string' && c) : [])

// 能選的電腦：名單上的各台設備，不含這支手機與「永久移除」的設備；本機以外照名單順序。每列 { key, label, ok, reason }
export function launchDevices(friends, { selfNode = '', nodeOrder = [], removed = [], ...ctx } = {}) {
  const label = new Map()
  for (const f of friends ?? []) if (f.node && f.node !== selfNode && !isDeviceRemoved(f.node, removed, { selfNode }) && !label.has(f.node)) label.set(f.node, f.device || '未命名設備')
  const order = [...nodeOrder.filter(n => label.has(n)), ...[...label.keys()].filter(n => !nodeOrder.includes(n))]
  return order.map(key => ({ key, label: label.get(key), ...launchEligibility(key, { ...ctx, friends }) }))
}

// 那台電腦的模型與資料夾選項（模型用那台回報的啟動設定，不是手機的）
export const launchChoices = machine => ({ models: remoteModelRows(machine?.launcher), cwds: cwdList(machine?.launcher) })

export const NAME_RE = /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$/
export const FIRST_MAX = 4000

// 還在開（送出後、還沒開好也還沒失敗）：關掉畫面也照常在背景追蹤，再進「開新夥伴」接著顯示進度
export const launchInProgress = l => l?.phase === 'progress' && l.vphase !== 'done' && l.vphase !== 'failed'
export const initialLaunch = () => ({ open: false, phase: 'form', node: '', deviceLabel: '', profile: '', vendor: '', run: '', piModel: '', cwd: '', name: '', first: '', error: '', busy: false, id: '', text: '', detail: '', friendId: '', since: 0 })

// 送出前的檢查：不能開的電腦、缺欄位、名字格式都擋在這裡（不送出）。回中文錯誤，通過回空字串
// run：選到的運行（null＝這個模型在那台沒有能選的運行）；piOk：經 pi 時選的模型在那台的清單裡
export function launchFormError(f, elig, { run = 'term', piOk = true } = {}) {
  if (!f.node) return '請先選一台電腦'
  if (!elig?.ok) return elig?.reason || REASON.unknown
  if (!f.profile) return '請選一個模型'
  if (!run) return '這個模型在那台電腦沒有能用的開法'
  if (run === 'pi' && !piOk) return '請選一個經 pi 的模型'
  if (!f.cwd) return '請選工作資料夾'
  if (!NAME_RE.test(f.name.trim())) return '名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭'
  if (f.first.trim().length > FIRST_MAX) return `第一句話最多 ${FIRST_MAX} 字`
  return ''
}

// ---- 運行四選一與經 pi（D1 #421、D2 #422）：跟電腦版開新夥伴同一套規則，資料都用那台電腦回報的啟動設定 ----
// 那台要開放遠端管理，名單回報才會帶它的 pi 模型清單（launcher.pi_models）
export const PI_REMOTE_NO_LIST = '那台要開放遠端管理才會回報可用的模型'
export const PI_REMOTE_NO_PI = '那台電腦沒有偵測到 pi'
const PI_ONLY_CHANNELS = { acp: { status: 'no', why: '沒有內建通道' }, pi: { status: 'ok', why: '只能經 pi 開' }, term: { status: 'no', why: '不走終端' } }

// 那台的 pi：有沒有 pi 的啟動設定、回報了哪些模型
export function remotePi(launcher) {
  const installed = remoteModelRows(launcher).some(r => r.profileId === 'pi')
  return { installed, models: installed ? cleanPiModels(launcher?.pi_models) : [] }
}

// 廠牌清單：那台的啟動設定（pi 是通道不是廠牌，不列）＋只能經 pi 的廠牌（那台 pi 列得到它的模型才出現）
export function launchVendors(launcher) {
  const pi = remotePi(launcher)
  const own = vendorRows(remoteModelRows(launcher))
  const piOnly = pi.models.length ? piOnlyVendorRows(pi.models).map(v => ({ ...v, profileId: 'pi', toolId: 'pi', label: v.label, mode: 'window', modeLabel: '經 pi 開', channels: PI_ONLY_CHANNELS })) : []
  return [...own, ...piOnly]
}

// 經 pi 的狀態：那台沒有 pi、沒回報清單（沒開放遠端管理）、或這家在那台 pi 沒有模型，都寫原因
export function launchPiChoice(row, launcher) {
  const pi = remotePi(launcher)
  if (!pi.installed) return { provider: '', ok: false, why: PI_REMOTE_NO_PI, models: [], defaultModel: '' }
  if (!pi.models.length) return { provider: '', ok: false, why: PI_REMOTE_NO_LIST, models: [], defaultModel: '' }
  return piChoiceFor(row?.id, pi.models)
}

// 「運行」四選一：內建通道 ＞ 經 pi ＞ ASN 開的終端 ＞ 原生 CLI（只作說明）。遠端開，Grok／Gemini 的自帶終端反灰（只能在那台開）
export function launchRun(row, launcher) {
  if (!row) return { options: [], selected: null }
  if (!row.channels) {   // 目錄上沒有的（自訂設定）：只看 mode
    const bg = row.mode === 'background'
    return { options: [
      { key: 'acp', label: '內建通道（背景運行）', ok: bg, why: bg ? '' : '這個設定不是背景運行', note: '' },
      { key: 'term', label: '開成視窗', ok: !bg, why: bg ? '這個設定是背景運行' : '', note: '' },
    ], selected: bg ? 'acp' : 'term' }
  }
  const pc = launchPiChoice(row, launcher)
  const r = runOptions(row, { local: false, piInstalled: remotePi(launcher).installed, piReady: pc.ok })
  // 經 pi 不能選時，原因用那台回報的（沒有 pi、沒開放遠端管理、沒登入那一家），比目錄的通用說明準確
  const options = r.options.map(o => (o.key === 'pi' && !o.ok && row.channels?.pi?.status !== 'no' && pc.why ? { ...o, why: pc.why } : o))
  return { options, selected: r.selected }
}

// 目前選的運行（使用者選過且還能選就用它，否則用預設）
export function pickedRun(run, wanted) {
  const cur = run.options.find(o => o.key === wanted && o.ok && o.key !== 'self')
  return cur ? cur.key : run.selected
}

// 送給 Rust 的內容（Rust、後台、那台電腦還會各檢查一次；指令內容一律不帶）。
// 經 pi：profile 一律是 pi，帶這次查到清單裡的提供者與模型；不在清單裡就回 null（不送）
export function buildLaunchRequest(f, { run = '', row = null, launcher = null } = {}) {
  const base = { node: f.node, name: f.name.trim(), cwd: f.cwd, first_message: f.first.trim() || null }
  if (run !== 'pi') return { ...base, profile: f.profile }
  const pc = launchPiChoice(row, launcher)
  const pi = pc.ok ? piLaunchArgs(row?.id, f.piModel || pc.defaultModel, pc.models) : null
  return pi ? { ...base, profile: 'pi', pi_provider: pi.provider, pi_model: pi.model } : null
}

// Rust／後台的錯誤字串（例如「launch HTTP 409 name_taken」）→ 給人看的中文
const CODE_TEXT = {
  forbidden: '只有本人能替電腦開新夥伴，請確認已登入同一個帳號',
  not_found: '找不到這台電腦',
  no_launcher: REASON.closed,
  bad_name: '名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭',
  bad_profile: '這台電腦沒有這個模型（可能剛換過設定），請重新整理後再選',
  bad_cwd: '工作資料夾不在這台電腦允許的清單裡',
  bad_first_message: `第一句話最多 ${FIRST_MAX} 字`,
  bad_pi_model: '經 pi 的模型不對，請重新選一次',
  name_taken: '這台電腦已經有同名的夥伴，換個名字',
  rate_limited: '這台電腦這個小時開太多視窗了，稍後再試',
  bad_request: '送出的內容不合格',
  internal: 'ASN 暫時有問題，稍後再試',
}
export function launchErrorText(msg) {
  const m = String(msg ?? '')
  if (/尚未登入/.test(m)) return REASON.needLogin
  if (/連線失敗|逾時|timed? ?out/i.test(m)) return '連不上 ASN，請檢查網路'
  const code = /HTTP \d+ (\w+)/.exec(m)?.[1]
  if (code && CODE_TEXT[code]) return CODE_TEXT[code]
  if (/格式不對|不對|最多|只能用/.test(m) && !/HTTP/.test(m)) return m   // Rust 端自己擋下的（已經是中文）
  return '送出失敗，請稍後再試'
}

// 進度：launchers 回的那一筆（status：pending／taken／ok／failed／unconfirmed）＋名單上新視窗出現了沒
export function progressView(row, appeared, name = '') {
  if (appeared) return { phase: 'done', text: `「${name}」已經開好了，可以直接對話。` }
  switch (row?.status) {
    case 'failed': return { phase: 'failed', text: `沒有開成功：${friendlyDetail(row.detail)}` }
    case 'ok': return { phase: 'waiting', text: '視窗已經開好，等它出現在名單上…' }
    case 'unconfirmed': return { phase: 'waiting', text: '已經送出，但還沒確認視窗出現；等一下看看名單。' }
    case 'taken': return { phase: 'opening', text: '正在開視窗…' }
    default: return { phase: 'sending', text: '正在發送指令…' }
  }
}
const friendlyDetail = d => String(d ?? '').trim().slice(0, 200) || '沒有說明原因'

// 新視窗出現在名單上了沒（線上的才算）
export const appearedIn = (friends, node, name) => (friends ?? []).some(f => f.node === node && (f.agent === name || f.nick === name) && f.status !== 'offline' && f.pending !== true)
