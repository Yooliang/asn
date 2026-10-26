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
  return { id, prompt_kind: pv.kind, n }
}

/** 送出前顯示給使用者看的說明：按鍵序列由後端依畫面上的游標位置算，所以這裡只說「第 n 項」；送出後以後端回的按鍵描述為準 */
export function willSendText(pv, n) {
  const o = pv?.options.find(x => x.n === n)
  return o ? `將選擇第 ${o.n} 項「${o.label}」；按鍵由 ASN 依畫面上目前的游標位置送出` : ''
}
export const sentText = desc => (desc ? `已送出：${String(desc).slice(0, 80)}` : '已送出')

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
    return { id: t.id, profile: String(t.profile ?? ''), title: `${t.profile ?? '終端'} #${t.id}`, cwd: typeof t.cwd === 'string' ? t.cwd : '', folder: folderName(t.cwd), state: sv.key, stateLabel: sv.label, tone: sv.tone, reason: String(st?.reason ?? ''), prompt }
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
