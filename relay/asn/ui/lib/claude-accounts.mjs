// 設定頁「帳號」：Claude 帳號（加入目前登入、切換、刪除）、OpenAI（Codex）目前登入、遠端設備的 Claude 帳號切換。
// 檔案操作全在 Rust（claude_accounts.rs、codex_accounts.rs、acct_remote.rs），這裡只呼叫指令並整理訊息。
// 帳號以 email 識別；介面只會拿到 email／方案／是否使用中，權杖不經過前端。
import { fetchRoster, normalizeQuotaState } from './account-roster.mjs'
import { REPORT_RETRY_MS, shouldRetryReport } from './device-state.mjs'
import { acctErrorText, isForbidden } from './acct-error.mjs'
import { createSwitchTracker, switchRowKey } from './switch-result.mjs'

export const CURRENT_UNREADABLE = '讀不到目前登入的帳號'   // 跟 Rust claude_login::UNREADABLE_TEXT 同一句
export const SWITCH_NOTICE = '已切換，開著的 Claude 視窗不用重開。'

// 存的登入不完整（權杖檔缺更新用的權杖）：Rust 只給 login_incomplete 這個布林，切過去整台的 Claude 都會失效，所以不能選
export const INCOMPLETE_LABEL = '登入不完整'
export const INCOMPLETE_REASON = '這個帳號存的登入不完整，請重新登入一次再加入'
export const loginIncomplete = a => a?.login_incomplete === true || a?.incomplete === true
// 那台電腦目前的 Claude 登入失效（橋接程式從對話紀錄判定後隨帳號回報帶來的布林）：標紅、不用請使用者去猜為什麼視窗全停
export const LOGIN_FAILED_LABEL = '登入失效'
export const loginFailed = a => a?.login_failed === true
// 帳號卡右上那一格：使用中的帳號登入失效時，「使用中」與「登入失效」同一格交替（#1592）；讀螢幕的人聽到兩個狀態，不靠顏色
export const CURRENT_LABEL = '使用中'
export const CURRENT_FAILED_ARIA = `${CURRENT_LABEL}，${LOGIN_FAILED_LABEL}`

// 上次確認可用（#1512 C）：切走前核對成功的時間。Rust 只給毫秒數（usable_at_ms），沒有就不顯示
export const USABLE_AT_LABEL = '上次確認可用'
export function usableAtText(a, tz) {
  // 本機的帳號清單帶毫秒（usable_at_ms）；別台經後台回報的帶 UTC 字串（usable_at，#1512 C2）
  const ms = a?.usable_at_ms != null ? Number(a.usable_at_ms) : typeof a?.usable_at === 'string' ? Date.parse(a.usable_at) : NaN
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = new Intl.DateTimeFormat('zh-TW', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)
  const g = t => p.find(x => x.type === t)?.value ?? ''
  return `${USABLE_AT_LABEL}：${g('year')}/${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`
}

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

export function createAccountsUi({ invoke, reactive, devices = () => [], nodeLabel = n => n, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 3000, pollMax = 80, now = () => Date.now(), retryMs = REPORT_RETRY_MS, log = (...a) => console.info(...a) }) {
  // 別台帳號的錯誤：後台回 403（沒有權限）顯示白話，原文只進 log；其他維持原樣
  const remoteErr = e => {
    if (!isForbidden(e)) return errText(e)
    log('[帳號切換] 後台拒絕：', errText(e))
    return acctErrorText(e)
  }
  const s = reactive({
    list: [], loginFailed: false, grok: [], current: null, currentErr: '', codex: null, codexErr: '', msg: '', busy: false, confirmDel: '',
    allowSwitch: true,   // 「允許切換帳號」（#371）：讓手機或別台設備替這台切換
    remote: { node: '', vendor: 'claude', list: [], reportedAt: '', asnOnline: false, loading: false, busy: false, msg: '' },
    incoming: [],   // 等本機使用者按確認的遠端切換指令：{ id, email, from, fromLabel }
    done: [],       // 免確認（本人簽章／信任自己的設備）已經切好、讓使用者看一眼的：{ id, email, from, fromLabel }；可按「還原」
    reports: {},    // 節點 → 那台電腦的帳號回報（設備分類用）：{ error, asnOnline, reportedAt, accounts }
    savedSeq: 0,
    autoNote: '',   // 背景自動加入成功時的一行小字
    mod: null,      // Claude 外掛狀態 {state, version?, reason?}（Rust 背景工作寫好；null＝不顯示，白話由 mod-line.mjs 組）
    quotaState: normalizeQuotaState(null),   // 這台目前登入帳號的額度查詢狀態（claude_quota_state，#1883）
    rowSwitch: {},  // 帳號卡設備列的切換結果（#2111 ③）：key（廠商｜帳號｜設備）→ { phase: busy｜ok｜fail｜waiting, text }
    roster: null,   // 後台的帳號列表（#374，acct_roster）；讀不到是 null，畫面退回各設備自己回報的數字
  })
  // 帳號列表：打開「設備與帳號」時讀一次，之後跟額度一樣每 5 分鐘（list.js 排程）。
  // 讀不到沿用上一次讀成功的；從沒成功過才是 null（退回各設備自己回報的）。只記 console，不吵使用者
  const refreshRoster = async () => { s.roster = await fetchRoster(() => invoke('acct_roster'), undefined, s.roster) }
  const refresh = async () => {
    try { s.list = await invoke('claude_accounts_list') } catch (e) { s.msg = errText(e) }
    try { s.current = (await invoke('claude_account_current')) ?? null; s.currentErr = '' } catch (e) { s.current = null; s.currentErr = errText(e) || CURRENT_UNREADABLE }   // 讀不到不等於沒登入：畫面寫「讀不到目前登入的帳號」，不沿用舊值（#1880）
    try { s.grok = (await invoke('grok_accounts_list')) ?? [] } catch { s.grok = [] }   // 舊版 Rust 沒有這個指令就當沒有
    try { s.codex = (await invoke('codex_account_current')) ?? null; s.codexErr = '' } catch (e) { s.codex = null; s.codexErr = errText(e) }
    try { s.mod = (await invoke('claude_mod_report')) ?? null } catch { /* 舊版 Rust 沒有這個指令就不顯示 */ }
    try { s.loginFailed = (await invoke('claude_login_failed')) === true } catch { s.loginFailed = false }   // 本機的登入失效判定（#1645，只讀）；舊版 Rust 沒有這個指令就當沒失效
    await refreshQuota()
  }
  // 只重讀這台目前登入帳號的額度查詢狀態（每 5 分鐘、打開設定頁時呼叫；不重抓帳號清單）。
  // 查詢由 Rust 每 10 分鐘做一次；讀不到（舊版 Rust 沒有這個指令）就維持原樣，畫面寫「讀取中」
  const refreshQuota = async () => {
    try { s.quotaState = normalizeQuotaState(await invoke('claude_quota_state')) } catch { /* 舊版沒有這個指令：維持原樣 */ }
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
    } catch (e) { r.list = []; r.msg = remoteErr(e) }
    r.loading = false
  }
  // 設備分類：一次讀好幾台的帳號回報（讀不到就記錯誤與失敗時間 failedAt，介面顯示「未回報」；之後由 retryReports 過了時間再讀）
  const reading = new Set()   // 正在讀的節點：同一台不重複送
  const loadReports = async nodes => {
    await Promise.all([...new Set(nodes)].filter(n => n && !reading.has(n)).map(async node => {
      reading.add(node)
      try {
        const v = await invoke('acct_remote_list', { node })
        s.reports[node] = { error: '', asnOnline: v?.asn_online === true, reportedAt: v?.reported_at ?? '', accounts: v?.accounts ?? [] }
      } catch (e) { s.reports[node] = { error: remoteErr(e), failedAt: now(), asnOnline: false, reportedAt: '', accounts: [] } }
      finally { reading.delete(node) }
    }))
  }
  // 沒讀過的、或讀失敗且已過 retryMs 的才讀；成功的不重讀。force＝剛登入：失敗的立刻重讀，不等時間
  const retryReports = async (nodes, { force = false } = {}) => {
    const t = now()
    const due = [...new Set(nodes)].filter(n => {
      const rep = s.reports[n]
      if (!rep) return true
      if (!rep.error) return false
      return force || shouldRetryReport({ read: true, failedAt: rep.failedAt ?? Number.NaN }, t, retryMs)
    })
    if (due.length) await loadReports(due)
    return due.length
  }
  const remoteSelect = async (node, vendor = 'claude') => { s.remote.node = node || ''; s.remote.vendor = vendor === 'grok' ? 'grok' : 'claude'; await remoteLoad() }
  // 送出別台的切換並等結果（對話框與帳號卡的設備列共用）。onMsg 收每一步的白話；回 { ok } 或 { ok: false, fail }（fail 給 switchFailReason）
  const switchRemoteCore = async (node, email, vendor, onMsg = () => {}) => {
    try {
      const sent = await invoke('acct_remote_request', { node, email, vendor })
      onMsg(remoteStatusText({ status: 'pending' }))
      for (let i = 0; i < pollMax; i++) {
        await sleep(pollMs)
        const v = await invoke('acct_remote_status', { ids: [sent.id] })
        const st = (v?.switches ?? []).find(x => x.id === sent.id)
        if (!st) { onMsg('查不到這個指令的結果。'); return { ok: false, fail: { code: 'missing' } } }
        onMsg(remoteStatusText(st, email))
        if (isFinalStatus(st.status)) return st.status === 'ok' ? { ok: true } : { ok: false, fail: { status: st.status, detail: st.detail } }
        if (i === pollMax - 1) { onMsg('等太久了，對方電腦沒有回應；稍後再看對方的帳號清單。'); return { ok: false, fail: { code: 'timeout' } } }
      }
      return { ok: false, fail: { code: 'timeout' } }
    } catch (e) { return { ok: false, fail: { error: e } } }
  }
  const remoteSwitch = async email => {
    const r = s.remote
    if (r.busy || !r.node) return
    r.busy = true; r.msg = '送出中…'
    const out = await switchRemoteCore(r.node, email, r.vendor, m => { r.msg = m })
    if (out.fail?.error) r.msg = remoteErr(out.fail.error)
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
  // 本機切換（Claude／Grok）：不寫 s.msg，結果交給設備列原位顯示
  const switchLocalCore = async (vendor, email) => {
    if (vendor === 'claude' && (s.list ?? []).some(a => a.email === email && loginIncomplete(a))) return { ok: false, fail: { error: INCOMPLETE_REASON } }
    s.busy = true
    try {
      await invoke(vendor === 'grok' ? 'grok_account_switch' : 'claude_account_switch', { email })
      return { ok: true }
    } catch (e) { return { ok: false, fail: { error: e } } } finally { s.busy = false }
  }
  // 帳號卡設備列的「切換」（電腦）：該列顯示「切換中…」→ 結果在那一列下方原位顯示 → 重讀列表直到那一列變成「使用中」（#2111 ③、#2110）。
  // synced＝呼叫端用目前畫面的資料判斷那一列是不是已經是「使用中」
  const tracker = createSwitchTracker({ state: s.rowSwitch, log, sleep, now, pollMs })
  const switchRow = ({ vendor, email, node, label, self = false, synced }) => tracker.press({
    key: switchRowKey(vendor, email, node), label,
    run: () => (self ? switchLocalCore(vendor, email) : switchRemoteCore(node, email, vendor)),
    reload: async () => {
      if (self) { await refresh(); void report() } else await loadReports([node])
      await refreshRoster()
    },
    synced,
  })
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
    refresh, refreshQuota, refreshRoster, report, onAuto, loadReports, retryReports, remoteNodes, remoteSelect, remoteLoad, remoteSwitch, switchRow, grokSwitch, pollIncoming, approve, decline, dismissDone, undo, loadTrust, setAllowSwitch,
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
