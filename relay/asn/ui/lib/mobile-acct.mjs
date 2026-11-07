// 手機版替電腦切換 Claude 帳號（#227）的純邏輯：哪些設備卡有按鈕、帳號清單怎麼顯示、切換前的確認字、送出後等結果、錯誤原因。
// 後台動作與電腦版相同（acct_list／acct_switch／acct_switch_status）：手機只下指令，對方電腦預設要使用者按「同意」才會在本機換檔；
// 權杖只在各自那台電腦搬，不經過手機也不進收發室（清單裡只有 email、方案、是否使用中）。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文。
import { agoText } from './cloud-invite.mjs'
import { CLOSE_NOTE, incompleteRow, rowQuota } from './device-acct-dialog.mjs'
import { loginIncomplete } from './claude-accounts.mjs'
import { nodeLabelOf, rosterQuotaFor, rosterView } from './account-roster.mjs'
import { isFinalStatus, remoteStatusText } from './claude-accounts.mjs'
import { QUOTA_NOTE } from './account-quota.mjs'
import { buildDeviceTree, SELF_LABEL } from './device-tree.mjs'

export const ACCT_TEXT = {
  button: '選項',
  empty: '這台電腦還沒有可切換的帳號（請在那台電腦開著 ASN，一分鐘內會自動加入目前登入的帳號）。',
  needTwo: '這台電腦只有一個帳號，沒有可以換的。',
  quotaNote: QUOTA_NOTE,
  pick: '點選要換成哪一個帳號',
  confirmOk: '確定切換',
  back: '返回',
  close: '關閉',
  later: '先關掉（照常進行）',
}

// 「選項」整頁＝電腦版「設備與帳號」：橫向設備頁籤 → 廠商卡片 → 帳號列。資料用電腦版同一份整理函式（device-tree），不另寫一套。
// 手機拿得到的資料比電腦少：沒有「在線的 ASN 視窗」清單（在線只看名單狀態）、沒有本機帳號庫（手機本機頁籤只顯示）；
// 別台電腦的帳號要逐台向後台讀（android_acct_list），所以只讀選到的那一台。
// 這一頁的標題跟著分頁變（#650）：設備或帳號，不再寫「設備與帳號」。在看某台設備的細部時一律是「設備」
export const ACCT_TITLES = Object.freeze({ devices: '設備', accounts: '帳號' })
export const acctPageTitle = tab => ACCT_TITLES[tab === 'accounts' ? 'accounts' : 'devices']
const PHONE_LABEL = '這支手機'

// reports：節點 → { loading, asnOnline, reportedAt, msg, list:[{vendor,email,plan,current}] }（手機自己存的形狀）
export const acctReportOf = r => (r && !r.loading ? { error: r.msg || '', asnOnline: r.asnOnline === true, reportedAt: r.reportedAt || '', accounts: Array.isArray(r.list) ? r.list : [] } : undefined)
// 切換流程只認 Claude：把某台的回報濾成 acctSheetView 要的形狀
export const acctClaudeRemote = r => ({ loading: r?.loading === true, asnOnline: r?.asnOnline === true, reportedAt: r?.reportedAt ?? '', msg: r?.msg ?? '', list: (Array.isArray(r?.list) ? r.list : []).filter(a => a?.vendor === 'claude') })

// roster：後台帳號列表（android_acct_roster，#374）；跟電腦版同一套 account-roster.mjs，讀不到（null）就退回各台自己回報的
export function acctDeviceTree({ friends = [], nodeOrder = [], deviceOrder = [], shown = [], removed = [], selfNode = '', reports = {}, launchers = {}, machines = launchers, roster = null, now = Date.now() } = {}) {
  const rep = Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, acctReportOf(r)]).filter(([, r]) => r))
  return buildDeviceTree({ friends, nodeOrder, deviceOrder, shown, removed, selfNode, launchers, machines, reports: rep, roster, now }).map(d => ({
    ...d,
    label: d.self && d.label === SELF_LABEL ? PHONE_LABEL : d.label,
    // 手機（本機與別支）只顯示，不提供切換，也不顯示「ASN 沒有在線」的提示
    vendors: d.kind === '手機' ? d.vendors.map(v => ({ ...v, switchable: false, switchHint: '' })) : d.vendors,
  }))
}

// 預設頁籤：指定的設備 → 第一台別台設備 → 第一個
export function acctPickDevice(devs, node = '') {
  const list = Array.isArray(devs) ? devs : []
  return list.find(d => d.key === node) ?? list.find(d => !d.self) ?? list[0] ?? null
}
// 要不要向後台讀這台的帳號：別台電腦才讀（本機與手機不讀）
export const acctNeedsLoad = d => Boolean(d && !d.self && d.kind !== '手機')

// 有「選項」按鈕的設備卡：別台電腦（本機與手機不算）。groups 是名單分組，只看 kind 為 device 的
export function acctButtonDevices(groups, selfNode) {
  return (Array.isArray(groups) ? groups : []).filter(g => g?.kind === 'device' && g.node && g.node !== selfNode
    && !(g.items ?? []).some(f => ['phone', 'mobile', 'android'].includes(String(f?.kind ?? '').toLowerCase())))
}

// 「我的帳號」整區（手機設備列表最上面）：跟電腦版同一份 rosterView；手機自己不回報帳號，本機標「這支手機」
export const acctRosterView = (roster, { friends = [], selfNode = '', now = Date.now() } = {}) =>
  rosterView(roster, { nodeLabel: nodeLabelOf(friends, { selfNode, selfLabel: PHONE_LABEL }), now })

// remote：{ loading, asnOnline, reportedAt, msg, list:[{email,plan,current}] }；picked：使用者點選的 email
// roster：後台帳號列表（#374）；有的話每列帶額度（quotaText／quotaMeta），沒有就不寫額度
export function acctSheetView(remote, picked = '', now = Date.now(), { roster = null, friends = [], selfNode = '' } = {}) {
  const nodeLabel = nodeLabelOf(friends, { selfNode, selfLabel: PHONE_LABEL })
  const quotaOf = email => rosterQuotaFor(roster, 'claude', email, { nodeLabel, now })
  const list = Array.isArray(remote?.list) ? remote.list : []
  const cur = list.find(a => a.current)
  const online = remote?.asnOnline === true
  const ago = agoText(remote?.reportedAt, now)
  const pick = list.find(a => a.email === picked && !a.current && !loginIncomplete(a))
  return {
    online,
    onlineText: remote?.loading ? '讀取中…' : online ? '那台電腦的 ASN 在線' : '那台電腦的 ASN 目前沒有在線，無法切換',
    currentText: cur ? `目前使用：${cur.email}` : '目前使用：（那台沒有回報）',
    currentEmail: cur?.email ?? '',
    reportedText: ago ? `最後回報：${ago}` : '',
    rows: list.map(a => ({ email: a.email, plan: a.plan || '', current: a.current === true, picked: a === pick, ...incompleteRow(a), ...rowQuota(quotaOf(a.email)) })),
    empty: !remote?.loading && !list.length ? ACCT_TEXT.empty : (!remote?.loading && list.length < 2 ? ACCT_TEXT.needTwo : ''),
    canPick: online && !remote?.loading && list.length >= 2,
    pickEmail: pick ? pick.email : '',
    status: remote?.loading ? '' : remote?.msg || '',
  }
}

// 切換前的確認：避免誤觸
export function confirmText(label, fromEmail, toEmail) {
  const name = label || '這台設備'
  return {
    lead: fromEmail ? `要把「${name}」的 Claude 帳號從 ${fromEmail} 換成 ${toEmail} 嗎？` : `要把「${name}」的 Claude 帳號換成 ${toEmail} 嗎？`,
    points: [
      '送出後，那台電腦會跳出確認視窗，對方按「同意」後才會切換；如果對方設定了信任自己的設備，就會直接切換。',
      CLOSE_NOTE,
    ],
  }
}

const CODE_TEXT = {
  forbidden: '沒有權限：只有登入同一個帳號的本人手機，才能替自己的電腦切換帳號。請確認這支手機已登入，且與那台電腦是同一個帳號。',
  not_found: '找不到這台電腦（可能已經移除或換了帳號）。',
  bad_request: '資料格式不對，請重新整理名單後再試。',
  bad_vendor: '目前只支援切換 Claude 帳號。',
  bad_email: '帳號的 email 格式不對。',
  asn_offline: '那台電腦的 ASN 沒有在線，無法切換。',
  unknown_account: '那台電腦的帳號庫裡沒有這個帳號（請對方開著 ASN 讓清單更新）。',
  busy: '那台電腦還有一個切換指令在處理中，請稍後再試。',
  rate_limited: '這台電腦這個小時切換太多次了，稍後再試。',
  internal: '伺服器發生錯誤，請稍後再試。',
}
// Rust 回來的錯誤長得像「acct_switch HTTP 403 forbidden」或一句中文；翻成給人看的一句話
export function acctErrorText(e) {
  const raw = typeof e === 'string' ? e : e?.message || ''
  if (!raw) return '操作失敗，請稍後再試。'
  const m = /HTTP (\d{3})\s*([a-z_]*)/.exec(raw)
  if (m) {
    if (CODE_TEXT[m[2]]) return CODE_TEXT[m[2]]
    if (m[1] === '404') return '後台還沒支援手機切換帳號，請等後台更新後再試。'
    if (m[1] === '401') return '尚未登入，請先到「我」分頁登入。'
    return `操作失敗（錯誤代碼 ${m[1]}），請稍後再試。`
  }
  return raw
}

// 送出切換並等結果。transport：{ acctSwitch(node, email) → { id }, acctStatus(ids) → { switches } }
// 每次狀態變化都用 onUpdate 回報 { phase: sending|waiting|done|failed, text, done }；最後也回傳最後一個
// 帳號切換的結果提示：使用者已經離開進行中的畫面（退回設備列表、離開設備與帳號、切到別的分頁）時，完成或失敗都跳一句告訴他；還在畫面上就照原本在畫面上顯示
export const ACCT_TOAST_MS = 6000
export function acctResultToast(v, { label = '', email = '' } = {}) {
  if (!v?.done) return ''
  const where = label ? `${label}：` : ''
  return v.phase === 'done' ? `${where}已切換到 ${email} 帳號` : `${where}切換沒有成功：${String(v.text ?? '').trim() || '原因不明'}`
}

export async function runAcctSwitch(transport, node, email, { onUpdate = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 3000, pollMax = 80, cancelled = () => false } = {}) {
  const emit = v => { onUpdate(v); return v }
  emit({ phase: 'sending', text: '送出中…', done: false })
  let sent
  try { sent = await transport.acctSwitch(node, email) } catch (e) { return emit({ phase: 'failed', text: acctErrorText(e), done: true }) }
  if (!sent?.id) return emit({ phase: 'failed', text: '後台沒有回指令編號，請稍後再試。', done: true })
  emit({ phase: 'waiting', text: remoteStatusText({ status: 'pending' }), done: false })
  for (let i = 0; i < pollMax; i++) {
    await sleep(pollMs)
    if (cancelled()) return { phase: 'waiting', text: '', done: false }
    let st
    try { st = ((await transport.acctStatus([sent.id]))?.switches ?? []).find(x => x.id === sent.id) } catch (e) { return emit({ phase: 'failed', text: acctErrorText(e), done: true }) }
    if (!st) return emit({ phase: 'failed', text: '查不到這個指令的結果。', done: true })
    const text = remoteStatusText(st, email)
    if (isFinalStatus(st.status)) return emit({ phase: st.status === 'ok' ? 'done' : 'failed', text, done: true })
    emit({ phase: 'waiting', text, done: false })
  }
  return emit({ phase: 'failed', text: '等太久了，那台電腦沒有回應；稍後再看它的帳號清單。', done: true })
}

// 第四頁籤「設備與帳號」內頁上方的兩個分頁（#650）；預設「設備」
export const ACCT_TABS = Object.freeze([{ key: 'devices', label: '設備' }, { key: 'accounts', label: '帳號' }])
export const acctTabOf = v => (v === 'accounts' ? 'accounts' : 'devices')

/** 帳號分頁「切換到某台」不能按時，按鈕左邊的說明（按鈕已寫「切換到哪台」，這裡不再說「這台」：在手機上看會以為指手機，#930） */
export const ACCT_SWITCH_REASON = Object.freeze({
  incomplete: '登入不完整',
  offline: 'ASN 沒有在線',
  unavailable: '目前不能切換',
})

/**
 * 手機上「能不能把帳號切到這一台」的唯一判斷（#930：手機上不跑夥伴，帳號永遠不能切到這支手機自己）。
 * 本機的認法不靠設備樹的 kind／平台：平台還沒讀到（android_launchers 還沒回來、舊版沒回報平台）時，
 * 這支手機在設備樹裡會暫時被當成「電腦」，但它的節點代號一定等於 selfNode。
 * selfNode 是空的（還認不出這支手機是哪一台）時一律不給切換，寧可少列也不列錯。
 */
export function isSwitchTarget(d, selfNode) {
  if (!d || !selfNode) return false
  if (d.self || d.key === selfNode) return false
  return !d.hidden && !d.removed && d.kind !== '手機'
}

/**
 * 帳號分頁：這個帳號在每一台電腦的「切換到某台」按鈕（手機只有 Claude 能切換；手機自己沒有帳號）。
 * devices：acctDevs（設備樹）；account：我的帳號那一列（{ account: email }）。
 * 回傳 { node, label, enabled, reason }：不能按的也列出來並寫原因，和設備頁一樣看得到按鈕。
 * 不列：正在用這個帳號的那台、沒有存這個帳號的（切不過去，#930）、沒有 Claude 的、已隱藏／已永久移除的、手機（含這支手機自己，見 isSwitchTarget）。
 */
export function acctSwitchTargets(devices, vendor, account, selfNode) {
  if (vendor !== 'claude') return []
  const mail = String(account?.account ?? '').trim().toLowerCase()
  if (!mail) return []
  const out = []
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!isSwitchTarget(d, selfNode)) continue
    const v = (d.vendors ?? []).find(x => x.key === 'claude')
    if (!v) continue
    const has = (v.accounts ?? []).find(x => String(x.email ?? '').trim().toLowerCase() === mail)
    if (!has || has.current) continue
    const reason = has.incomplete ? ACCT_SWITCH_REASON.incomplete
        : v.switchable ? ''
          : v.switchHint ? ACCT_SWITCH_REASON.offline : ACCT_SWITCH_REASON.unavailable
    out.push({ node: d.key, label: d.label, enabled: !reason, reason })
  }
  return out
}
