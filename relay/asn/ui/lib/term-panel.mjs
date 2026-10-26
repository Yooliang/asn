// 電腦版「終端」面板的純邏輯（node 與瀏覽器都能跑）：列清單、輪詢狀態、提示框的內容與送出。
// 只列清單與提示框，不渲染終端內容（畫面由 WezTerm 視窗自己顯示）。後端命令：term_list／term_status／term_answer（見 launch/term.rs）。
// 原則（小良哥）：遇到需要使用者授權或選擇的提示，ASN 只跳出提示，使用者按下某個選項後才送；絕不自動代答、沒有預設選項。

export const POLL_MS = 3000
export const PROMPT_TEXT_MAX = 500

// 終端狀態 → 畫面用的文字與色調（後端 state：idle／busy／unknown／waiting_user；不認得的一律當 unknown）
const STATE_VIEW = {
  idle: { label: '閒置', tone: 'ok' },
  busy: { label: '忙碌', tone: 'busy' },
  waiting_user: { label: '等你回答', tone: 'warn' },
  unknown: { label: '狀態未知', tone: 'idle' },
}
export function stateView(state) {
  const key = Object.hasOwn(STATE_VIEW, state) ? state : 'unknown'
  return { key, ...STATE_VIEW[key] }
}

// 提示種類 → 標題（後端 prompt.kind：trust_dialog／menu／unknown_prompt）
const KIND_TITLE = {
  trust_dialog: '要不要信任這個資料夾？',
  menu: '請選一個選項',
  unknown_prompt: '終端在問你問題',
}
export const kindTitle = kind => KIND_TITLE[kind] ?? KIND_TITLE.unknown_prompt

const clip = (s, n) => { const t = String(s ?? '').replace(/\r/g, ''); return t.length > n ? t.slice(0, n) : t }

/** 後端 prompt 物件 → 提示框要顯示的內容；選項整理成 [{ n, label }]（n 是 1 起算的整數，壞的丟掉，依 n 排序、不重複）。沒有提示回 null */
export function promptView(prompt) {
  if (!prompt || typeof prompt !== 'object') return null
  const seen = new Set()
  const options = (Array.isArray(prompt.options) ? prompt.options : [])
    .map(o => ({ n: Number(o?.n), label: clip(o?.label, 120).trim() }))
    .filter(o => Number.isInteger(o.n) && o.n >= 1 && o.n <= 99 && o.label && !seen.has(o.n) && seen.add(o.n))
    .sort((a, b) => a.n - b.n)
  const kind = typeof prompt.kind === 'string' ? prompt.kind : 'unknown_prompt'
  return { kind, title: kindTitle(kind), text: clip(prompt.text, PROMPT_TEXT_MAX), options }
}

/** 同一個提示的指紋：提示內容沒變就不重複跳出（使用者按了「我自己處理」之後） */
export const promptKey = (id, pv) => `${id}|${pv?.kind ?? ''}|${pv?.text ?? ''}|${(pv?.options ?? []).map(o => `${o.n}:${o.label}`).join(',')}`

/** 使用者按了第 n 個選項：回給 term_answer 的請求；選項不存在（或不是這個提示）回 null，不送 */
export function answerRequest(id, pv, n) {
  if (!id || !pv || !pv.options.some(o => o.n === n)) return null
  return {
    id,
    prompt_kind: pv.kind,
    n,
    prompt_text: pv.text ?? '',
    options: pv.options.map(o => ({ n: o.n, label: o.label })),
  }
}

/** 送出前顯示給使用者看的說明：按鍵序列由後端依畫面上的游標位置算，所以這裡只說「第 n 項」；送出後以後端回的按鍵描述為準 */
export function willSendText(pv, n) {
  const o = pv?.options.find(x => x.n === n)
  return o ? `將選擇第 ${o.n} 項「${o.label}」；按鍵由 ASN 依畫面上目前的游標位置送出` : ''
}
export const sentText = desc => (desc ? `已送出：${String(desc).slice(0, 80)}` : '已送出')

// ---- 卡太久的提示（借鏡 agent-board 的巡檢；#310、#426 第 5 項）----
// 前端只知道「這個終端一直是什麼狀態」，不知道畫面有沒有變，所以不說「卡住」，只說「忙碌已 N 分鐘」「已等你回答 N 分鐘」。
// 只顯示狀態與時間，不碰也不轉寄終端畫面文字（避免反射型 prompt injection）。計時從 ASN 第一次看到這個狀態起算，ASN 重開會重新計。
export const BUSY_LONG_MIN = 15
export const WAIT_LONG_MIN = 10

/**
 * prev：上一輪的 { 編號: { state, since } }；rows：這一輪的清單列；nowMs：現在（毫秒）。
 * 回 { since, rows }：since 是這一輪的對照（狀態變了或新出現就重新起算，消失的丟掉）；rows 每列多 held（超過門檻才有字，否則空字串）。
 */
export function trackHeld(prev, rows, nowMs) {
  const since = {}
  const out = (Array.isArray(rows) ? rows : []).map(r => {
    const old = prev?.[r.id]
    const s = old && old.state === r.state && Number.isFinite(old.since) ? old.since : nowMs
    since[r.id] = { state: r.state, since: s }
    const min = Math.floor(Math.max(0, nowMs - s) / 60000)
    let held = ''
    if (r.state === 'busy' && min >= BUSY_LONG_MIN) held = `忙碌已 ${min} 分鐘`
    else if (r.state === 'waiting_user' && min >= WAIT_LONG_MIN) held = `已等你回答 ${min} 分鐘`
    return { ...r, held }
  })
  return { since, rows: out }
}

// ---- ASN 替使用者往終端送字（#296）----
// 使用者在清單裡寫好文字、按「送出」→ 先跳確認框，寫清楚「送到哪個終端／哪個資料夾／送什麼字」→ 按「確認送出」才呼叫 term_send。
// 沒有任何自動送出；終端正在等你回答（信任資料夾、選單）時不能送字，請先處理提示。
export const SEND_MAX = 2000

/** 送字草稿的檢查。回 { ok, reason, lines, flattened }：reason 是給人看的中文原因（ok 時是空字串） */
export function sendDraftView(row, text) {
  const t = String(text ?? '')
  const lines = t.split(/\r?\n/).filter(l => l.trim()).length
  if (!row) return { ok: false, reason: '找不到這個終端', lines, flattened: false }
  if (row.state === 'waiting_user') return { ok: false, reason: '終端正在等你回答，請先處理提示再送字', lines, flattened: false }
  if (!t.trim()) return { ok: false, reason: '請先寫要送的文字', lines, flattened: false }
  if (t.length > SEND_MAX) return { ok: false, reason: `文字太長（最多 ${SEND_MAX} 字）`, lines, flattened: false }
  if (!row.cwd) return { ok: false, reason: '這個終端沒有工作資料夾紀錄，不能代送', lines, flattened: false }
  return { ok: true, reason: '', lines, flattened: lines > 1 }
}

/** 確認框的說明：送到哪、什麼字、會不會按 Enter、多行會壓成一行 */
export function sendConfirmView(row, text, enter) {
  const d = sendDraftView(row, text)
  if (!d.ok) return null
  return {
    title: '要替你把這段文字送進終端嗎？',
    target: `${row.title}${row.folder ? `・${row.folder}` : ''}`,
    text: String(text).slice(0, SEND_MAX),
    note: [d.flattened ? '多行文字會合成一行送出。' : '', enter ? '送完後會再按一次 Enter。' : '只會把字打進去，不按 Enter。'].filter(Boolean).join(''),
  }
}

/** 使用者按了「確認送出」：回給 term_send 的請求（只有編號、文字、是否換行）；草稿不合格回 null，不送 */
export function sendRequest(row, text, enter) {
  const d = sendDraftView(row, text)
  return d.ok ? { id: row.id, text: String(text), enter: enter === true } : null
}

// ---- 接手使用者自己開的 WezTerm 窗格（#285 定案版；後端 #313）----
// 接手只存記憶體、預設全唯讀；「代答提問」「代送文字」兩個寫入開關各自獨立、預設關，只能在這裡由本機使用者逐窗格點開（手機、來信、網路都不行）。
// 「解除接手」不會結束那個程式，只是 ASN 不再管它。標題只用來在清單裡認人，接手後不存。
const posInt = (v, min = 0) => Number.isInteger(v) && v >= min

/** 後端候選列（term_adopt_candidates）→ 畫面一列；欄位壞掉的丟掉。tab_title 只是顯示用；cwd_raw 可能是 file:// 網址，取最後一段當資料夾名 */
export function candidateRows(list) {
  return (Array.isArray(list) ? list : []).filter(c => c && posInt(c.pid, 1) && posInt(c.pane_id) && posInt(c.started_ms, 1) && typeof c.profile === 'string').map(c => {
    let raw = String(c.cwd_raw ?? '')
    try { raw = decodeURIComponent(raw) } catch { /* 用原文 */ }
    const verified = c.version_verified === true
    const adopted = c.already_adopted === true
    return {
      key: `${c.pid}:${c.pane_id}`, pid: c.pid, pane_id: c.pane_id, started_ms: c.started_ms,
      profile: c.profile, title: clip(c.tab_title, 60).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), folder: folderName(raw),
      authorized: c.cwd_authorized === true, verified, adopted,
      note: verified ? '' : clip(c.version_note, 120) || 'WezTerm 版本未驗證，只能讀取，不能代答或代送',
      canAdopt: !adopted,
    }
  })
}

/** 使用者按了「接手」：回給 term_adopt 的請求（pid、窗格、建立時間原樣帶回，後端會核對）；列不合格回 null */
export const adoptRequest = row => (row && posInt(row.pid, 1) && posInt(row.pane_id) && posInt(row.started_ms, 1) && row.canAdopt ? { pid: row.pid, pane_id: row.pane_id, started_ms: row.started_ms } : null)

// 兩個寫入開關：kind＝answer（代答提問）／send（代送文字）
export const UNLOCK_TEXT = {
  answer: { label: '允許 ASN 代答提問', ask: '要讓 ASN 能在這個窗格代按提問選項嗎？每次還是要你在 ASN 按「送出」，送前會重讀畫面、確認不是你正在操作的窗格。' },
  send: { label: '允許 ASN 代送文字', ask: '要讓 ASN 能往這個窗格代送文字嗎？每次還是要你在確認框按「確認送出」，送前會重新確認資料夾已授權、不是你正在操作的窗格。' },
}
/** 使用者在確認後按了「允許」：回給 term_adopt_unlock 的請求；只開被選的那一個，另一個不動（維持 false）。沒接手的窗格、不認得的種類回 null */
export function unlockRequest(row, kind) {
  if (!row || row.adopted !== true || !Object.hasOwn(UNLOCK_TEXT, kind)) return null
  return { id: row.id, allow_answer: kind === 'answer', allow_send: kind === 'send' }
}

// 資料夾顯示名：路徑最後一段（Windows 與 POSIX 分隔都認），結尾的分隔符號略過；不是字串或空的回空字串
export function folderName(cwd) {
  const parts = String(typeof cwd === 'string' ? cwd : '').split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** 清單的一列：id、profile、資料夾（後端 term_list 的 cwd，開啟時已授權的資料夾；舊後端沒有就空）、狀態；沒有狀態（還沒查到或查失敗）當 unknown */
export function rowsOf(listed, statuses = {}) {
  return (Array.isArray(listed) ? listed : []).filter(t => t && typeof t.id === 'string').map(t => {
    const st = statuses[t.id]
    const sv = stateView(st?.state)
    const prompt = sv.key === 'waiting_user' ? promptView(st?.prompt) : null
    const adopted = t.adopted === true
    // 接手窗格的「已允許」以電腦端 term_list 回報為準（#317 起有這兩欄）：要明確是 true 才算；缺欄或壞值一律當沒允許。自己開的終端不用解鎖
    const answerUnlocked = adopted ? t.answer_unlocked === true : true
    const sendUnlocked = adopted ? t.send_unlocked === true : true
    return { id: t.id, adopted, answerUnlocked, sendUnlocked, profile: String(t.profile ?? ''), title: `${t.profile ?? '終端'} #${t.id}`, cwd: typeof t.cwd === 'string' ? t.cwd : '', folder: folderName(t.cwd), state: sv.key, stateLabel: sv.label, tone: sv.tone, reason: String(st?.reason ?? ''), prompt }
  })
}

/**
 * 輪詢：每 intervalMs 查 term_list，再逐一查 term_status；一輪還沒跑完不會再開下一輪；某個終端查失敗只影響那一列（當 unknown）。
 * transport 要有 termList()、termStatus({ id })；setTimer／clearTimer 可注入（測試用）。
 * 回傳 { stop, tickNow }；onUpdate(rows) 每一輪結束呼叫，onError(msg) 在 term_list 本身失敗時呼叫。
 */
export function createTermPoller({ transport, onUpdate, onError = () => {}, intervalMs = POLL_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, stopped = false, running = false, current = Promise.resolve()
  async function run() {
    running = true
    try {
      let listed = []
      try { listed = await transport.termList() } catch (e) { onError(String(e?.message ?? e)); listed = null }
      if (listed) {
        const statuses = {}
        await Promise.all((Array.isArray(listed) ? listed : []).map(async t => {
          try { statuses[t.id] = await transport.termStatus({ id: t.id }) } catch { /* 這一列當 unknown */ }
        }))
        if (!stopped) onUpdate(rowsOf(listed, statuses))
      }
    } finally {
      running = false
      if (!stopped) timer = setTimer(tick, intervalMs)
    }
  }
  // 一輪還沒跑完就回同一個 promise（不重疊、tickNow 也等得到這一輪）
  function tick() {
    if (stopped) return Promise.resolve()
    if (running) return current
    current = run()
    return current
  }
  tick()
  return {
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null },
    tickNow() { if (timer) clearTimer(timer); timer = null; return tick() },
  }
}
