// 設定頁「帳號」：Claude 帳號（加入目前登入、切換、刪除）、OpenAI（Codex）目前登入、遠端設備的 Claude 帳號切換。
// 檔案操作全在 Rust（claude_accounts.rs、codex_accounts.rs、acct_remote.rs），這裡只呼叫指令並整理訊息。
// 帳號以 email 識別；介面只會拿到 email／方案／是否使用中，權杖不經過前端。
import { quotaOf } from './account-quota.mjs'
import { fetchRoster } from './account-roster.mjs'

export const SWITCH_NOTICE = '已切換，開著的 Claude 視窗不用重開。'

// 存的登入不完整（權杖檔缺更新用的權杖）：Rust 只給 login_incomplete 這個布林，切過去整台的 Claude 都會失效，所以不能選
export const INCOMPLETE_LABEL = '登入不完整'
export const INCOMPLETE_REASON = '這個帳號存的登入不完整，請重新登入一次再加入'
export const loginIncomplete = a => a?.login_incomplete === true || a?.incomplete === true

export function accountLine(a) {
  return [a.email, a.plan].filter(Boolean).join(' · ')
}

// 其他廠商先留位置（Gemini 之外的也可以之後加進來）
export const OTHER_VENDORS = [{ key: 'gemini', title: 'Gemini' }, { key: 'other', title: '其他' }]
export const VENDOR_UNSUPPORTED = '尚未支援'

// Codex 目前登入的一行說明
export function codexLine(c, err = '') {
  if (err) return err
  if (!c) return '這台電腦目前沒有登入 Codex。'
  if (c.mode === 'api_key') return '目前用 API 金鑰登入（沒有帳號 email）。'
  return accountLine({ email: c.email || '（讀不到 email）', plan: c.plan })
}

// 遠端切換指令的狀態 → 給人看的一句話
export function remoteStatusText(st, email = '') {
  switch (st?.status) {
    case 'pending': return '已送出，等對方電腦取走指令…'
    case 'taken': return '對方電腦正在等使用者按確認…'
    case 'ok': return `對方已切換到 ${email}。對方開著的 Claude 視窗不用重開。`
    case 'denied': return '對方電腦上的使用者沒有同意。'
    case 'failed': return `切換失敗：${st.detail || '原因不明'}`
    default: return ''
  }
}
export const isFinalStatus = s => s === 'ok' || s === 'failed' || s === 'denied'

const errText = e => (typeof e === 'string' ? e : e?.message || String(e))

export function createAccountsUi({ invoke, reactive, devices = () => [], nodeLabel = n => n, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 3000, pollMax = 80 }) {
  const s = reactive({
    list: [], grok: [], current: null, codex: null, codexErr: '', msg: '', busy: false, confirmDel: '',
    allowSwitch: true,   // 「允許切換帳號」（#371）：讓手機或別台設備替這台切換
    remote: { node: '', vendor: 'claude', list: [], reportedAt: '', asnOnline: false, loading: false, busy: false, msg: '' },
    incoming: [],   // 等本機使用者按確認的遠端切換指令：{ id, email, from, fromLabel }
    done: [],       // 免確認（本人簽章／信任自己的設備）已經切好、讓使用者看一眼的：{ id, email, from, fromLabel }；可按「還原」
    reports: {},    // 節點 → 那台電腦的帳號回報（設備分類用）：{ error, asnOnline, reportedAt, accounts }
    savedSeq: 0,
    autoNote: '',   // 背景自動加入成功時的一行小字
    mod: '',        // Claude 外掛自動安裝的狀態文字（Rust 背景工作寫好；空字串＝不顯示）
    roster: null,   // 後台的帳號列表（#374，acct_roster）；讀不到是 null，畫面退回各設備自己回報的數字
  })
  // 帳號列表：打開「設備與帳號」時讀一次，之後跟額度一樣每 5 分鐘（list.js 排程）。
  // 讀不到沿用上一次讀成功的；從沒成功過才是 null（退回各設備自己回報的）。只記 console，不吵使用者
  const refreshRoster = async () => { s.roster = await fetchRoster(() => invoke('acct_roster'), undefined, s.roster) }
  const refresh = async () => {
    try { s.list = await invoke('claude_accounts_list') } catch (e) { s.msg = errText(e) }
    try { s.current = (await invoke('claude_account_current')) ?? null } catch { s.current = null }
    try { s.grok = (await invoke('grok_accounts_list')) ?? [] } catch { s.grok = [] }   // 舊版 Rust 沒有這個指令就當沒有
    try { s.codex = (await invoke('codex_account_current')) ?? null; s.codexErr = '' } catch (e) { s.codex = null; s.codexErr = errText(e) }
    try { s.mod = (await invoke('claude_mod_status')) ?? '' } catch { /* 舊版 Rust 沒有這個指令就不顯示 */ }
    await refreshQuota()
  }
  // 只重讀這台各帳號上次記下的額度（每 5 分鐘、打開設定頁時呼叫；不重抓帳號清單）。
  // 先拿掉舊的額度欄位再套新的：紀錄被清掉的帳號要回到「額度未知」。讀不到（舊版 Rust 沒有這個指令）就維持原樣
  const QUOTA_KEYS = ['five_hour_pct', 'weekly_pct', 'reset_at', 'at']
  const refreshQuota = async () => {
    let q
    try { q = (await invoke('claude_quota_all')) ?? {} } catch { return }
    if (!Array.isArray(s.list)) return
    s.list = s.list.map(a => {
      const base = Object.fromEntries(Object.entries(a).filter(([k]) => !QUOTA_KEYS.includes(k)))
      return { ...base, ...quotaOf(q[a.email]) }
    })
  }
  // 帳號庫變了，就把新清單回報給收發室（讓擁有者設備看得到）；後台沒部署或沒連線都不吵使用者
  const report = async () => { try { await invoke('acct_remote_report') } catch { /* 略過 */ } }
  const run = async fn => {
    if (s.busy) return
    s.busy = true
    try { s.msg = await fn() } catch (e) { s.msg = errText(e) }
    s.busy = false
    s.confirmDel = ''
    await refresh()
    void report()
  }
  const remoteNodes = () => devices().map(d => ({ key: d.key, label: d.label }))
  const remoteLoad = async () => {
    const r = s.remote
    if (!r.node) { r.list = []; r.msg = ''; return }
    r.loading = true; r.msg = ''
    try {
      const v = await invoke('acct_remote_list', { node: r.node })
      r.list = (v?.accounts ?? []).filter(a => a.vendor === r.vendor)
      s.reports[r.node] = { error: '', asnOnline: v?.asn_online === true, reportedAt: v?.reported_at ?? '', accounts: v?.accounts ?? [] }
      r.asnOnline = v?.asn_online === true
      r.reportedAt = v?.reported_at ?? ''
      if (!r.asnOnline) r.msg = '對方電腦的 ASN 目前沒有在線，無法切換。'
      else if (!r.list.length) r.msg = '對方電腦還沒有帳號（請對方電腦開著 ASN，一分鐘內會自動加入目前登入的帳號）。'
    } catch (e) { r.list = []; r.msg = errText(e) }
    r.loading = false
  }
  // 設備分類：一次讀好幾台的帳號回報（讀不到就記錯誤，介面顯示「未回報」）
  const loadReports = async nodes => {
    await Promise.all([...new Set(nodes)].filter(Boolean).map(async node => {
      try {
        const v = await invoke('acct_remote_list', { node })
        s.reports[node] = { error: '', asnOnline: v?.asn_online === true, reportedAt: v?.reported_at ?? '', accounts: v?.accounts ?? [] }
      } catch (e) { s.reports[node] = { error: errText(e), asnOnline: false, reportedAt: '', accounts: [] } }
    }))
  }
  const remoteSelect = async (node, vendor = 'claude') => { s.remote.node = node || ''; s.remote.vendor = vendor === 'grok' ? 'grok' : 'claude'; await remoteLoad() }
  const remoteSwitch = async email => {
    const r = s.remote
    if (r.busy || !r.node) return
    r.busy = true; r.msg = '送出中…'
    try {
      const sent = await invoke('acct_remote_request', { node: r.node, email, vendor: r.vendor })
      r.msg = remoteStatusText({ status: 'pending' })
      for (let i = 0; i < pollMax; i++) {
        await sleep(pollMs)
        const v = await invoke('acct_remote_status', { ids: [sent.id] })
        const st = (v?.switches ?? []).find(x => x.id === sent.id)
        if (!st) { r.msg = '查不到這個指令的結果。'; break }
        r.msg = remoteStatusText(st, email)
        if (isFinalStatus(st.status)) break
        if (i === pollMax - 1) r.msg = '等太久了，對方電腦沒有回應；稍後再看對方的帳號清單。'
      }
    } catch (e) { r.msg = errText(e) }
    r.busy = false
    const finalMsg = r.msg
    await remoteLoad().catch(() => {})   // 重抓對方的清單（使用中的帳號可能變了）；結果訊息不要被洗掉
    if (!r.msg) r.msg = finalMsg
  }
  // 本機這邊：定期取走別台送來的切換指令。預設要使用者按確認；設定「信任我自己的設備」就直接切
  const handleIncoming = async row => {
    if (!row.needs_confirm) {
      try {
        await invoke('acct_remote_apply', { id: row.id, confirmed: false })
        s.msg = `${nodeLabel(row.requested_by)} 要求切換，已切到 ${row.email}。${SWITCH_NOTICE}`
        s.done.push({ id: row.id, email: row.email, from: row.requested_by, fromLabel: nodeLabel(row.requested_by), vendor: row.vendor === 'grok' ? 'grok' : 'claude' })
      } catch (e) { s.msg = errText(e) }
      await refresh(); void report()
      return
    }
    s.incoming.push({ id: row.id, email: row.email, from: row.requested_by, fromLabel: nodeLabel(row.requested_by), vendor: row.vendor === 'grok' ? 'grok' : 'claude' })
  }
  const pollIncoming = async () => {
    let rows = []
    try { rows = await invoke('acct_remote_pending') } catch { return 0 }
    for (const row of rows ?? []) await handleIncoming(row)
    return (rows ?? []).length
  }
  const approve = async id => {
    const it = s.incoming.find(x => x.id === id)
    s.incoming = s.incoming.filter(x => x.id !== id)
    if (!it) return
    try { await invoke('acct_remote_apply', { id, confirmed: true }); s.msg = `已依 ${it.fromLabel} 的要求切換到 ${it.email}。${SWITCH_NOTICE}` } catch (e) { s.msg = errText(e) }
    await refresh(); void report()
  }
  // 本機 Grok：切到帳號庫裡的另一個帳號（整份登入檔換掉；開著的 Grok 要重開才生效）
  const grokSwitch = async email => {
    if (s.busy) return
    s.busy = true
    try { const o = await invoke('grok_account_switch', { email }); s.msg = String(o?.notice ?? '已切換') } catch (e) { s.msg = errText(e) }
    s.busy = false
    await refresh(); void report()
  }
  const dismissDone = id => { s.done = s.done.filter(x => x.id !== id) }
  // 還原到切換前（本機備份；只有這個按鈕能用，遠端指令碰不到）
  const undo = async id => {
    dismissDone(id)
    try { s.msg = String((await invoke('claude_account_undo')) ?? '') } catch (e) { s.msg = errText(e) }
    await refresh(); void report()
  }
  const decline = async id => {
    s.incoming = s.incoming.filter(x => x.id !== id)
    try { await invoke('acct_remote_decline', { id }) } catch { /* 略過 */ }
  }
  // Rust 背景工作（每分鐘）自動加入／回存後的通知：只有 kind 與 email，沒有權杖
  const onAuto = async ev => {
    if (ev?.kind === 'added' && ev.email) s.autoNote = `已自動加入 ${ev.email}`
    if (ev?.kind === 'external' && ev.email) s.autoNote = `登入檔被其他程式換過，現在是 ${ev.email}`
    await refresh()
    void report()
  }
  // 讀不到就當預設（開）：不會因為讀取失敗而悄悄變成關（真正擋不擋由 Rust 端照存檔判斷）
  const loadTrust = async () => {
    try { s.allowSwitch = (await invoke('acct_remote_allow_get')) !== false } catch { s.allowSwitch = true }
  }
  const setAllowSwitch = async on => {
    try { await invoke('acct_remote_allow_set', { on }); s.allowSwitch = on === true } catch (e) { s.msg = errText(e) }
  }
  return {
    state: s,
    refresh, refreshQuota, refreshRoster, report, onAuto, loadReports, remoteNodes, remoteSelect, remoteLoad, remoteSwitch, grokSwitch, pollIncoming, approve, decline, dismissDone, undo, loadTrust, setAllowSwitch,
    addCurrent: () => run(async () => { const a = await invoke('claude_account_save'); s.savedSeq++; return `已加入 ${a.email}。` }),
    // 登入不完整的帳號畫面上已經反灰；這裡再擋一次（Rust 端 switch_impl 也會拒絕）
    switchTo: async email => {
      if ((s.list ?? []).some(a => a.email === email && loginIncomplete(a))) { s.msg = INCOMPLETE_REASON; return }
      return run(async () => { const r = await invoke('claude_account_switch', { email }); return `已切換到 ${r.email}。${SWITCH_NOTICE}` })
    },
    // 刪除要按兩次（第一次變成「確認刪除」），避免誤觸
    remove: email => {
      if (s.confirmDel !== email) { s.confirmDel = email; s.msg = ''; return }
      return run(async () => { await invoke('claude_account_delete', { email }); return `已刪除 ${email}。` })
    },
  }
}
