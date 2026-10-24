// 手機版替電腦切換 Claude 帳號（#227）的純邏輯：哪些設備卡有按鈕、帳號清單怎麼顯示、切換前的確認字、送出後等結果、錯誤原因。
// 後台動作與電腦版相同（acct_list／acct_switch／acct_switch_status）：手機只下指令，對方電腦預設要使用者按「同意」才會在本機換檔；
// 權杖只在各自那台電腦搬，不經過手機也不進收發室（清單裡只有 email、方案、是否使用中）。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文。
import { agoText } from './cloud-invite.mjs'
import { CLOSE_NOTE } from './device-acct-dialog.mjs'
import { isFinalStatus, remoteStatusText } from './claude-accounts.mjs'

export const ACCT_TEXT = {
  button: '切換 Claude 帳號',
  title: label => `切換「${label || '這台設備'}」的 Claude 帳號`,
  empty: '這台電腦還沒有可切換的帳號（請在那台電腦的設定「帳號」頁，按「加入目前登入的帳號」）。',
  needTwo: '這台電腦只有一個帳號，沒有可以換的。',
  // 老實說：後台目前只回報 email、方案、是否使用中，沒有各帳號的剩餘額度
  quotaNote: '手機上看不到各帳號的剩餘額度，只顯示方案；要看額度請在電腦上查。',
  pick: '點選要換成哪一個帳號',
  confirmOk: '確定切換',
  back: '返回',
  close: '關閉',
  later: '先關掉（照常進行）',
}

// 有「切換 Claude 帳號」按鈕的設備卡：別台電腦（本機與手機不算）。groups 是名單分組，只看 kind 為 device 的
export function acctButtonDevices(groups, selfNode) {
  return (Array.isArray(groups) ? groups : []).filter(g => g?.kind === 'device' && g.node && g.node !== selfNode
    && !(g.items ?? []).some(f => ['phone', 'mobile', 'android'].includes(String(f?.kind ?? '').toLowerCase())))
}

// remote：{ loading, asnOnline, reportedAt, msg, list:[{email,plan,current}] }；picked：使用者點選的 email
export function acctSheetView(remote, picked = '', now = Date.now()) {
  const list = Array.isArray(remote?.list) ? remote.list : []
  const cur = list.find(a => a.current)
  const online = remote?.asnOnline === true
  const ago = agoText(remote?.reportedAt, now)
  const pick = list.find(a => a.email === picked && !a.current)
  return {
    online,
    onlineText: remote?.loading ? '讀取中…' : online ? '那台電腦的 ASN 在線' : '那台電腦的 ASN 目前沒有在線，無法切換',
    currentText: cur ? `目前使用：${cur.email}` : '目前使用：（那台沒有回報）',
    currentEmail: cur?.email ?? '',
    reportedText: ago ? `最後回報：${ago}` : '',
    rows: list.map(a => ({ email: a.email, plan: a.plan || '', current: a.current === true, picked: a.email === picked && !a.current })),
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
