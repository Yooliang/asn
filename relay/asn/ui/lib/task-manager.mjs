// 工作管理員（0.2.21，電腦版）：「設定 → 設備 → 這台電腦 → 工作管理員」的純邏輯。
// 清單由電腦端（Rust 的 task_manager_list）只讀整理出來，這裡負責：合併名單上的內建工作者、判斷「重複」、
// 決定每一列的「停止」走哪一條既有的路、格式化記憶體與時長、提示文字，以及頁面開著時每 5 秒更新的控制器。
// 「停止」絕不另開殺程序的路，也不按程序編號直接殺：
//   一般視窗／pi／內建工作者 → 夥伴管理的 close（和名單右鍵「關閉視窗」同一條，要登入、要開放遠端管理）
//   同名重複的視窗 → 以本人身分寄 /asn-close-dup <pid> 給同一個視窗（和對話頁的「關掉第 N 個」同一條）
//   終端面板 → 既有的 term_stop
//   卡在接回中的夥伴視窗（ASN 開的、已沒有對話紀錄檔可對）→ 同樣走 term_stop，多帶對話編號，電腦端會把條件再驗一次
//   視窗開著、卡在第一次確認畫面還沒進到對話的夥伴（awaiting，#1635）→ 同樣走 term_stop，多帶夥伴名，電腦端會把條件再驗一次；另有「看畫面」打開它的對話頁（那裡有終端）
//   自己開的前景程式、終端服務、ASN 本體 → 只能看
// node 與瀏覽器都能跑；畫面文字純繁體中文，除了程序編號（本頁的欄位）不顯示任何內部識別碼。
import { menuItems, partnerEngine, isProcessEntry } from './partner-ops.mjs'
import { runPartnerOp } from './partner-ops-ui.mjs'
import { dupCloseText } from './dup-windows.mjs'
import { treeView, ROOT_KEY, TREE_TEXT } from './task-tree.mjs'

export const REFRESH_MS = 5000
// 重啟之後最多等多久（登記在 docs/設定值清單.md 的 tm-restart-confirm 那一列）：
// 終端服務：新服務起好後接回要幾十秒，底下代理一直標「斷線中」，接回完成或超過這個時間就放掉；
// ASN：按下後本頁應該隨後斷線；超過這個時間頁面還在、ASN 沒回來，就回報「沒有完成」並恢復按鈕
export const RESUME_WAIT_MS = 90_000
export const ASN_RESTART_WAIT_MS = 60_000
export const DASH = '—'

export const TEXT = {
  title: '工作管理員',
  entry: '工作管理員',
  refreshing: '更新中…',
  loadFail: '暫時讀不到程式清單，稍後會再試',
  empty: '這台電腦上目前沒有 ASN 管的程式。',
  dupTag: '重複',
  dupRisk: '同名的視窗有兩個時，信可能兩邊都收不到',
  stop: '停止',
  cancel: '取消',
  stopWindow: '停止這個視窗',
  stopping: '停止中…',
  viewOnly: '只能看',
  wake: '喚醒',
  noPlace: '還沒在名單上，稍後再試',
  wakeFail: '叫醒失敗，請稍後再試',
  stopFail: '停止失敗，請稍後再試',
  view: '看畫面',
  viewTip: '打開這位夥伴的對話頁，按「終端」看它停在哪個畫面；ASN 不會代你按任何確認',
  // 納入管理（#1557，從夥伴選單搬來）：自己開的、還沒交給 ASN 的那一列放這顆；按了打開跟以前同一個接手清單
  adopt: '納入管理',
  adoptTip: '你自己在終端開的 grok、claude、agy、pi 或 codex，可以交給 ASN 看狀態、提醒你回答；預設只能看，要代送文字得另外允許。',
  // 壓縮次數（#1852）
  handover: '交接',
  handoverTip: '請這位夥伴寫交接檔、開新視窗接手、關掉這個視窗（不查額度）',
  handoverAsked: '已請這台電腦交接，幾秒後清單會更新。',
  handoverFail: '交接失敗，請稍後再試',
  handing: '交接中',
  remind: '請交接',
  handingWhy: '交接完成前不能停止',
}

export const COLUMNS = ['名字', '引擎', '程序編號', '記憶體', '開了多久', '狀態', '壓縮次數', '運行位置', '操作']

const ENGINE_TEXT = { claude: 'Claude', pi: 'pi', codex: 'Codex', gemini: 'Gemini', agy: 'agy', grok: 'Grok', asn: 'ASN', acp: '內建工作者' }
export const engineText = e => {
  const k = String(e ?? '').trim().toLowerCase()
  return ENGINE_TEXT[k] ?? (k || DASH)
}

const STATUS_TEXT = { idle: '閒置', online: '閒置', busy: '忙碌', working: '忙碌', thinking: '忙碌', running: '執行中', waiting: '等你回應', away: '等你回應', blocked: '等你回應', paused: '暫停', stopped: '已停止', offline: '離線', resuming: '接回中', stuck: '可能卡住了', awaiting: '等你按確認' }
export const statusText = s => STATUS_TEXT[String(s ?? '').trim().toLowerCase()] ?? DASH

// ---------- 格式化 ----------

/** 記憶體：拿不到（null、undefined、非數字、負數）一律顯示「—」，不報錯 */
export function formatMemory(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return DASH
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** 開了多久：「3 小時 12 分」；不知道開始時間顯示「—」 */
export function formatUptime(startedMs, nowMs) {
  if (typeof startedMs !== 'number' || !Number.isFinite(startedMs) || startedMs <= 0 || !Number.isFinite(nowMs)) return DASH
  const min = Math.floor(Math.max(0, nowMs - startedMs) / 60000)
  if (min < 1) return '不到 1 分鐘'
  if (min < 60) return `${min} 分鐘`
  if (min < 1440) return `${Math.floor(min / 60)} 小時 ${min % 60} 分`
  return `${Math.floor(min / 1440)} 天 ${Math.floor((min % 1440) / 60)} 小時`
}

/** 確認框裡的「41 分鐘前開的」 */
export const openedAgo = (startedMs, nowMs) => {
  const t = formatUptime(startedMs, nowMs)
  return t === DASH ? '' : t === '不到 1 分鐘' ? '剛剛開的' : `${t}前開的`
}

// ---------- 重複 ----------

/**
 * 重複：同一台電腦、同名、Claude，兩個以上都活著（而且是原本那個程序）。
 * 殘留的工作階段檔（live:false）不算；不同引擎同名不算。回新的清單（每列加 dup），不改原本的。
 */
export function markDuplicates(rows) {
  const list = Array.isArray(rows) ? rows : []
  const count = new Map()
  for (const r of list) if (r?.kind === 'claude' && r.live !== false) count.set(r.name, (count.get(r.name) ?? 0) + 1)
  return list.map(r => ({ ...r, dup: r?.kind === 'claude' && r.live !== false && (count.get(r.name) ?? 0) >= 2 }))
}

/** 重複的名字與各有幾個視窗（頂部提示用） */
export function dupGroups(rows) {
  const out = new Map()
  for (const r of rows) if (r.dup) out.set(r.name, (out.get(r.name) ?? 0) + 1)
  return [...out].map(([name, n]) => ({ name, n }))
}

export const dupBanner = groups => {
  if (!groups.length) return ''
  const names = groups.map(g => `「${g.name}」開了 ${g.n} 個視窗`).join('、')
  return `${names}。${TEXT.dupRisk}；請看標「${TEXT.dupTag}」的列，確認後關掉多的那個。`
}

// ---------- 合併 ----------

const isSelf = (f, selfNode) => f && f.node === selfNode

/**
 * 把電腦端回的清單（snapshot.rows）和名單上這台電腦的內建工作者（Gemini、agy、Grok）合成一份。
 * 內建工作者在電腦端沒有程序編號可讀，所以只列名字、引擎、狀態，其餘顯示「—」。
 */
export function mergeRows(snapshot, friends, selfNode) {
  const local = Array.isArray(snapshot?.rows) ? snapshot.rows : []
  const acp = (Array.isArray(friends) ? friends : [])
    .filter(f => isSelf(f, selfNode) && f.agent && !isProcessEntry(f) && partnerEngine(f) === 'acp' && f.status !== 'offline')
    .map(f => ({ kind: 'acp', name: String(f.agent), engine: String(f.engine || 'acp'), pid: 0, memory_bytes: null, started_ms: null, status: f.status ?? null, detail: null, by_asn: true, cwd: '', live: true }))
  return markDuplicates([...local, ...acp])
}

// ---------- 停止走哪條路 ----------

export const PATH = { close: 'close', dup: 'dup', term: 'term', none: '' }

const VIEW_ONLY_WHY = {
  own: '這個視窗是你自己開的，ASN 只能看，不能從這裡停止',
  process: '這是你自己開的程式，ASN 只能看，不能從這裡停止',
  mux: '終端服務停掉會一起帶走底下所有視窗，所以不提供停止',
  asn: 'ASN 自己的程式，不能從這裡停止',
}

export const findFriend = (friends, selfNode, name) => (Array.isArray(friends) ? friends : []).find(f => f && f.node === selfNode && f.agent === name) ?? null

/**
 * 這一列的「停止」：{ path, ok, reason }。path 是既有的哪條路（close／dup／term）；ok=false 時 reason 寫為什麼不能按。
 * 一般視窗走「關閉視窗」那條，那條要什麼（登入、電腦開放遠端管理）就照著要，不放寬。
 */
export function stopPlan(row, ctx = {}) {
  const k = row?.kind
  if (VIEW_ONLY_WHY[k]) return { path: PATH.none, ok: false, reason: VIEW_ONLY_WHY[k] }
  if (k === 'terminal') {
    return row.by_asn === false ? { path: PATH.none, ok: false, reason: '這個終端窗格是你自己開的，ASN 只能看' } : { path: PATH.term, ok: Boolean(row.term_id), reason: row.term_id ? '' : '找不到這個終端' }
  }
  if (k === 'resuming') {
    const ok = Boolean(row.term_id && row.session_id)
    return { path: PATH.term, ok, reason: ok ? '' : '找不到這個終端' }
  }
  if (k === 'awaiting') {
    const ok = Boolean(row.term_id && row.name)
    return { path: PATH.term, ok, reason: ok ? '' : '找不到這個終端' }
  }
  if ((k === 'claude' || k === 'pi') && row.by_asn === false) return { path: PATH.none, ok: false, reason: VIEW_ONLY_WHY.own }
  // 交接中的視窗不能停止（#1852）：舊視窗會被交接流程關掉，中途停掉會讓新視窗接不到交接檔
  if (k === 'claude' && row.compact?.state === 'handing') return { path: PATH.close, ok: false, reason: TEXT.handingWhy }
  if (k === 'claude' || k === 'pi' || k === 'acp') {
    const path = k === 'claude' && row.dup ? PATH.dup : PATH.close
    const friend = findFriend(ctx.friends, ctx.selfNode, row.name)
    if (!friend) return { path, ok: false, reason: TEXT.noPlace }
    const item = menuItems(friend, { ...(ctx.ops ?? {}), friends: ctx.friends, asn: ctx.asn }).find(i => i.key === 'close')
    if (!item) return { path, ok: false, reason: '這個視窗不能從這裡管理' }
    return { path, ok: item.ok, reason: item.ok ? '' : item.reason }
  }
  return { path: PATH.none, ok: false, reason: TEXT.viewOnly }
}

/** 按下「停止」要寄出的內容：只給既有那三條路用，不含任何殺程序的指令 */
export function stopRequest(row, ctx = {}) {
  const plan = stopPlan(row, ctx)
  if (!plan.ok) return null
  if (plan.path === PATH.dup) return { path: PATH.dup, friendId: `${ctx.selfNode}/${row.name}`, text: dupCloseText(row.pid) }
  if (plan.path === PATH.term) return { path: PATH.term, req: row.kind === 'resuming' ? { id: row.term_id, resuming_sid: row.session_id } : row.kind === 'awaiting' ? { id: row.term_id, awaiting_name: row.name } : { id: row.term_id } }
  return { path: PATH.close, friend: findFriend(ctx.friends, ctx.selfNode, row.name), op: 'close' }
}

// ---------- 畫面用的列與確認框 ----------

// 「運行位置」欄（#1909）：夥伴視窗照後台給的 term 顯示；缺欄位或沒看過的值一律「不明」，不猜
const SELF_OPENED = '自己開的終端'
export const NATIVE_TEXT = '原生主控台'
const TERM_TEXT = { mux: '終端服務', native: NATIVE_TEXT, unknown: '不明' }
const termText = r => TERM_TEXT[r.term] ?? TERM_TEXT.unknown

const sourceText = r => {
  switch (r.kind) {
    case 'claude': case 'pi': return r.by_asn ? termText(r) : SELF_OPENED
    case 'acp': return 'ASN 內建'
    case 'resuming': case 'awaiting': return termText(r)
    case 'terminal': return r.by_asn === false ? '自己開的（已接手）' : 'ASN 開的終端'
    case 'process': return SELF_OPENED
    case 'mux': return 'ASN 的終端服務'
    case 'asn': return r.name === 'ASN' ? 'ASN 本體' : 'ASN 自己的視窗'
    default: return DASH
  }
}

// 還沒被管理的終端（#1557）：自己開的 Claude／pi 視窗、自己開的前景程式。已接手的終端（terminal、by_asn:false）已經在管，不給
export const canAdopt = r => r?.kind === 'process' || ((r?.kind === 'claude' || r?.kind === 'pi') && r.by_asn === false)

const nameText = r => (r.kind === 'terminal' ? `${engineText(r.engine)} 終端` : r.name)

/** 「壓縮次數」欄：{ text: '3 次', tag: '交接中'|'請交接'|'', state }；不是 Claude 視窗、還沒數過一律「—」 */
export function compactCell(r) {
  const c = r?.compact
  if (r?.kind !== 'claude' || !c || !Number.isInteger(c.count) || c.count < 0) return { text: DASH, tag: '', state: '' }
  const tag = c.state === 'handing' ? TEXT.handing : c.state === 'remind' ? TEXT.remind : ''
  return { text: `${c.count} 次`, tag, state: c.state === 'handing' || c.state === 'remind' ? c.state : '' }
}

export function viewRow(r, now, ctx) {
  const plan = stopPlan(r, ctx)
  const cmp = compactCell(r)
  return {
    key: `${r.kind}:${r.pid}:${r.name}:${r.term_id ?? ''}`,
    kind: r.kind,
    name: nameText(r),
    engine: r.kind === 'mux' ? '共用終端' : engineText(r.engine),
    pid: r.pid > 0 ? String(r.pid) : DASH,
    memory: formatMemory(r.memory_bytes),
    uptime: formatUptime(r.started_ms, now),
    status: r.kind === 'mux' && typeof r.inside === 'number' ? `${r.inside} 個視窗` : statusText(r.status),
    source: sourceText(r),
    native: sourceText(r) === NATIVE_TEXT,   // 只有「運行位置」那一欄用黃標籤標出來
    cmpText: cmp.text,
    cmpTag: cmp.tag,
    cmpState: cmp.state,
    canHandover: cmp.state === 'remind' && Boolean(r.name),   // 「請交接」的列才有「交接」鈕
    handing: cmp.state === 'handing',
    dup: Boolean(r.dup),
    canStop: plan.ok,
    viewOnly: plan.path === PATH.none,
    showViewOnly: plan.path === PATH.none,   // 範本只讀這個：交接中的列 plan 不是 none，所以只顯示原因不寫「只能看」
    why: plan.ok ? '' : plan.reason,
    dupNote: r.dup ? TEXT.dupRisk : '',
    canAdopt: canAdopt(r),
    canView: r.kind === 'awaiting' && Boolean(r.name),   // 看畫面：打開對話頁（那裡有終端）
  }
}

/**
 * 停止確認框的內容（照設計稿：誰、哪一個、不受影響的是誰、會留下什麼）。
 * prefix：標題最前面加的主詞（看別台設備時寫那一台的名字，例如「工作機」的）；這台自己不用給
 */
export function confirmView(r, rows, now, prefix = '') {
  const c = confirmBody(r, rows, now)
  return prefix ? { ...c, title: `${prefix}${c.title}` } : c
}

function confirmBody(r, rows, now) {
  const base = { key: '', title: '', lines: [], notes: [], ok: TEXT.stopWindow }
  const name = r.name
  const facts = [r.pid > 0 ? `程序編號 ${r.pid}` : '', openedAgo(r.started_ms, now), statusText(r.status) === DASH ? '' : statusText(r.status)].filter(Boolean).join(' · ')
  const lines = [facts, r.cwd ? `資料夾：${r.cwd}` : ''].filter(Boolean)
  if (r.kind === 'terminal') return { ...base, title: `要關閉這個${engineText(r.engine)}終端嗎？`, lines, notes: ['只會關掉這個終端，裡面正在跑的程式會結束。'], ok: '關閉這個終端' }
  if (r.kind === 'resuming') return { ...base, title: `要停止「${name}」這個還在接回的終端嗎？`, lines, notes: ['關掉這個還在接回的終端。對話紀錄不會受影響，之後可以再按喚醒。'], ok: TEXT.stop }
  if (r.kind === 'awaiting') return { ...base, title: `要停止「${name}」這個還在等確認的視窗嗎？`, lines, notes: ['關掉這個還沒進到對話的視窗。對話紀錄不會受影響，之後可以再開或喚醒。'], ok: TEXT.stop }
  if (r.kind === 'acp') return { ...base, title: `要停止「${name}」嗎？`, lines, notes: ['只停止它這一次的執行，名單上會顯示「已停止」；按「重開」或重啟 ASN 就會恢復。'], ok: '停止' }
  if (r.dup) {
    const other = rows.filter(x => x.kind === 'claude' && x.name === name && x.pid !== r.pid)
    for (const o of other) lines.push(`另一個「${name}」（編號 ${o.pid}）不受影響。`)
  }
  const notes = ['只會關掉這一個視窗，對話紀錄還在，之後可以「喚醒」接回。']
  return { ...base, title: `要停止「${name}」的這個視窗嗎？`, lines, notes }
}

// ---------- 控制器：頁面開著時才每 5 秒更新 ----------

// restartAsk：正在原位確認重啟的節點鍵；restart：正在重啟的節點鍵；restartFrozen：重啟終端服務當下記的那一組（舊服務停了、清單找不到它時撐著畫面）；restartError：{ key, text }
export const initialState = () => ({ open: false, loading: false, error: '', snapshot: null, confirm: null, busy: false, note: '', wakeNote: '', restartAsk: null, restart: null, restartFrozen: null, restartError: null, restartUntil: null })

// 控制器的 view() 另外帶 tree（ASN ＞ 終端服務 ＞ 代理，見 task-tree.mjs）；rows 還是平的一份，找列、停止與測試都用它

/**
 * 控制器（狀態都在 state，畫面只讀 view()）。deps：
 *   api（taskManagerList、termStop、partnerOp、partnerOps）、getFriends()、getSelfNode()、getOpsCtx()（登入與電腦設定）、
 *   refreshOps()（重查登入與電腦設定）、sendMail(friendId, text)（以本人身分寄信）、now()、setTimer／clearTimer、runOp（測試可換）
 */
export function createTaskManager(deps) {
  const { api, getFriends, getSelfNode, getOpsCtx, refreshOps = async () => {}, openChat = () => {}, confirmPrefix = () => '', sendMail, now = Date.now, setTimer = (f, ms) => setInterval(f, ms), clearTimer = t => clearInterval(t), runOp = runPartnerOp, state = initialState(), log = m => console.info('[ASN]', m) } = deps
  let timer = null
  let inflight = false
  const ctx = () => ({ friends: getFriends(), selfNode: getSelfNode(), ops: getOpsCtx(), asn: getOpsCtx()?.asn })

  async function refresh() {
    if (inflight || !state.open) return
    inflight = true
    state.loading = true
    try {
      state.snapshot = await api.taskManagerList()
      state.error = ''
    } catch (e) {
      log(`[工作管理員] 讀程式清單失敗：${e?.message ?? e}`)
      state.error = TEXT.loadFail
    } finally {
      state.loading = false
      inflight = false
      settleRestart()
    }
  }

  function open() {
    if (state.open) return
    state.open = true
    state.note = ''
    state.wakeNote = ''
    void refreshOps()
    void refresh()
    timer = setTimer(() => { void refresh() }, REFRESH_MS)
  }

  function close() {
    state.open = false
    state.confirm = null
    state.restartAsk = null
    if (timer !== null) { clearTimer(timer); timer = null }
  }

  const rowsNow = () => mergeRows(state.snapshot, getFriends(), getSelfNode())
  const findRow = key => rowsNow().map(r => ({ r, k: viewRow(r, now(), ctx()).key })).find(x => x.k === key)?.r ?? null

  function ask(key) {
    const r = findRow(key)
    if (!r || !stopPlan(r, ctx()).ok) return
    state.note = ''
    state.restartAsk = null
    state.confirm = { ...confirmView(r, rowsNow(), now(), confirmPrefix()), key, busy: false, result: '' }
  }

  function cancel() { if (!state.busy) state.confirm = null }

  async function confirm() {
    const c = state.confirm
    if (!c || state.busy) return
    const r = findRow(c.key)
    const req = r ? stopRequest(r, ctx()) : null
    if (!req) { state.confirm = null; state.note = '這個視窗已經不在清單上了。'; return }
    state.busy = true
    c.busy = true
    try {
      if (req.path === PATH.close) {
        const v = await runOp(api, req.friend, req.op, {}, { onUpdate: x => { c.result = x.text } })
        c.result = v?.text ?? c.result
        if (v?.phase === 'done') { state.confirm = null; state.note = v.text }
      } else if (req.path === PATH.dup) {
        const res = await sendMail(req.friendId, req.text)
        if (res?.ok === false) c.result = `沒有送出：${res.error || '請稍後再試'}`
        else { state.confirm = null; state.note = '已請這台電腦關掉這個視窗，幾秒後清單會更新。' }
      } else if (req.path === PATH.term) {
        await api.termStop(req.req)
        state.confirm = null
        state.note = '終端已關閉。'
      }
    } catch (e) {
      log(`[工作管理員] 停止失敗：${e?.message ?? e}`)
      c.result = TEXT.stopFail
    } finally {
      state.busy = false
      c.busy = false
    }
    setTimeout(() => { void refresh() }, 2500)
    void refresh()
  }

  // ---------- 重啟（ASN、終端服務）：原位確認，按下後那一列顯示「正在重啟…」 ----------

  const treeUi = () => ({
    ask: state.restartAsk,
    // 沒有本頁自己記的（例如頁面重新載入）就看電腦端回報：不知道是哪一個，所有終端服務都當作在重啟
    restarting: state.restart ?? (state.snapshot?.mux_restarting === true ? 'mux:*' : null),
    frozen: state.restartFrozen,
    prefix: confirmPrefix(),
    error: state.restartError,
    pending: Math.max(0, Number(state.snapshot?.restart_pending) || 0),
  })
  const liveTree = () => { const n = now(), c = ctx(); return treeView(rowsNow(), r => viewRow(r, n, c), treeUi()) }

  function askRestart(key) {
    if (state.restart || state.busy) return
    state.confirm = null
    state.restartError = null
    state.restartAsk = String(key ?? '') || null
  }

  function cancelRestart() { state.restartAsk = null }

  async function confirmRestart() {
    const key = state.restartAsk
    if (!key || state.restart) return
    const isAsn = key === ROOT_KEY
    state.restartAsk = null
    state.restartError = null
    state.restartUntil = null
    state.restart = key
    state.restartFrozen = isAsn ? null : liveTree().groups.find(g => g.key === key) ?? null
    try {
      if (isAsn) await api.taskManagerRestartAsn()
      else await api.taskManagerRestartMux()
    } catch (e) {
      // 電腦端回的是白話字串（原文已寫進它的 log）；其他錯誤用統一的白話字，原文寫 console
      log(`[工作管理員] 重啟失敗（${key}）：${e?.message ?? e}`)
      state.restartError = { key, text: typeof e === 'string' && e ? e : TREE_TEXT.restartFail }
      state.restart = null
      state.restartFrozen = null
      state.restartUntil = null
      // 失敗後馬上重讀清單：服務可能已經停了、名單變了；錯誤掛在一定存在的 ASN 列（見 task-tree 的 errorFor）
      await refresh()
      return
    }
    // 重啟 ASN 成功：本頁隨後會斷線，ASN 回來後重新載入，這裡維持「正在重啟…」；
    // 逾時（頁面還在、ASN 沒回來）由 settleRestart 回報並恢復按鈕
    if (isAsn) { state.restartUntil = now() + ASN_RESTART_WAIT_MS; return }
    // 終端服務：新的已起來，但接回要幾十秒。底下代理維持「斷線中」（'mux:*'＝所有終端服務），直到名單回齊或逾時
    state.restart = 'mux:*'
    state.restartUntil = now() + RESUME_WAIT_MS
    await refresh()
    settleRestart()
    setTimeout(() => { void refresh() }, 2500)
  }

  /** 重啟的收尾判斷（每次重讀清單後呼叫）：ASN 逾時＝回報沒完成並恢復；終端服務＝代理回齊或逾時就放掉「斷線中」 */
  function settleRestart() {
    if (!state.restart || state.restartUntil === null) return
    const t = now()
    const expired = t >= state.restartUntil
    if (state.restart === ROOT_KEY) {
      if (!expired) return
      log('[工作管理員] 重啟 ASN：逾時，頁面還在，ASN 沒有回來重新載入')
      state.restartError = { key: ROOT_KEY, text: TREE_TEXT.restartAsnTimeout }
    } else {
      const rows = rowsNow()
      const have = new Set(rows.map(r => viewRow(r, t, ctx()).name))
      const want = (state.restartFrozen?.agents ?? []).filter(a => a.kind !== 'process').map(a => a.name)
      const back = rows.some(r => r.kind === 'mux') && want.every(n => have.has(n))
      if (!back && !expired) return
      if (!back) log('[工作管理員] 重啟終端服務：逾時，部分代理還沒接回')
    }
    state.restart = null
    state.restartFrozen = null
    state.restartUntil = null
  }

  /** 「看畫面」：打開這位夥伴的對話頁（名單上那一筆「等你在那台電腦按確認」），終端在那裡看；名單上還沒有就請稍後再試 */
  function openScreen(name) {
    const f = (Array.isArray(getFriends()) ? getFriends() : []).find(x => x && x.node === getSelfNode() && x.awaiting === true && x.awaitName === name)
    if (!f) { state.wakeNote = TEXT.noPlace; return false }
    state.wakeNote = ''
    openChat(f.id)
    return true
  }

  /** 「交接」鈕：只把視窗名交給內建收發室，它會驗證後照現有的換班接手流程做（不查額度） */
  async function handover(name) {
    if (state.busy || !name) return
    state.busy = true
    try {
      await api.compactHandoffRequest(name)
      state.note = TEXT.handoverAsked
    } catch (e) {
      log(`[工作管理員] 交接失敗：${e?.message ?? e}`)
      state.note = TEXT.handoverFail
    } finally { state.busy = false }
    setTimeout(() => { void refresh() }, 2500)
  }

  async function wake(name) {
    const f = findFriend(getFriends(), getSelfNode(), name)
    if (!f || state.busy) return
    const it = menuItems(f, { ...getOpsCtx(), friends: getFriends() }).find(i => i.key === 'resume')
    if (!it?.ok) { state.wakeNote = it?.reason || TEXT.noPlace; return }
    state.busy = true
    try {
      const v = await runOp(api, f, 'resume', {}, {})
      state.wakeNote = v?.text ?? ''
    } catch (e) {
      log(`[工作管理員] 叫醒失敗：${e?.message ?? e}`)
      state.wakeNote = TEXT.wakeFail
    } finally { state.busy = false }
    void refresh()
  }

  function view() {
    const c = ctx()
    const n = now()
    const merged = rowsNow()
    const rows = merged.map(r => viewRow(r, n, c))
    const groups = dupGroups(merged)
    const running = new Set(merged.map(r => r.name))
    const known = (Array.isArray(state.snapshot?.known) ? state.snapshot.known : []).filter(k => !running.has(k.name)).map(k => {
      const f = findFriend(c.friends, c.selfNode, k.name)
      const it = f ? menuItems(f, { ...(c.ops ?? {}), friends: c.friends, asn: c.asn }).find(i => i.key === 'resume') : null
      return { name: k.name, engine: engineText(k.engine), canWake: Boolean(it?.ok), why: it && !it.ok ? it.reason : '' }
    })
    return {
      open: state.open, loading: state.loading, error: state.error, loaded: state.snapshot !== null,
      rows, tree: treeView(merged, r => viewRow(r, n, c), treeUi()), empty: state.snapshot !== null && !rows.length,
      dupBanner: dupBanner(groups),
      known, note: state.note, wakeNote: state.wakeNote, busy: state.busy,
      confirm: state.confirm ? { ...state.confirm } : null,    }
  }

  return { state, open, close, refresh, ask, cancel, confirm, wake, handover, openScreen, askRestart, cancelRestart, confirmRestart, view }
}
