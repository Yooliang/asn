// 手機版與電腦版「管理夥伴視窗」（手機對話頁右上角「⋯」選單、電腦版名單右鍵：詳情、改名、切換模型、關閉視窗、接班換手、喚醒）的純邏輯。
// 視窗在那台電腦上，手機只下指令（後台 relay 的 partner_op／partner_ops，要本人簽章；設計見 docs/design/PARTNER-OPS.md）。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文，不顯示節點代號與夥伴 ID。
import { NAME_RE } from './mobile-launch.mjs'
import { isRelayRoom } from './roster.mjs'

export const OPS = ['info', 'rename', 'model', 'close', 'handover', 'resume', 'restart']
// Claude 視窗：在線的五項；離線的只有「喚醒」
export const ONLINE_OPS = ['info', 'rename', 'model', 'close', 'handover']
// ACP 工作者（Gemini 等收發室自己跑的背景工作者）：只有詳情、重開、接班換手；其餘電腦端會回「這類夥伴不支援」，所以畫面不顯示
export const ACP_OPS = ['info', 'restart', 'handover']
export const OP_LABEL = { info: '詳情', rename: '改名', model: '切換模型', close: '關閉視窗', handover: '接班換手', resume: '喚醒', restart: '重開' }
export const NOTE_MAX = 1000
export const MODEL_RE = /^[A-Za-z0-9._[\]-]{1,60}$/
export const OP_POLL_MS = 3000
export const OP_GIVE_UP_MS = 3 * 60 * 1000   // 後台 2 分鐘沒被取走會自己標失敗；這裡多留一分鐘
export const QUEUE_GIVE_UP_MS = 15 * 60 * 1000   // 改名、切換模型遇到視窗忙碌，外掛會排隊等閒置（電腦端最多等 10 分鐘），處理中的上限放寬
export const HANDOVER_GIVE_UP_MS = 15 * 60 * 1000   // 接班換手要等前任寫交接（最久 10 分鐘），處理中的上限放寬

export const REASON = {
  needLogin: '要先登入，才能管理夥伴視窗',
  unknown: '還沒查到這台電腦的設定，請稍後再試',
  offline: '這台電腦或這個視窗不在線',
  closed: '這台電腦沒有開放遠端管理視窗（要到電腦的設定打開「允許遠端開視窗與管理視窗」）',
  deviceOffline: '電腦現在不在線，叫不醒（要讓電腦的 ASN 開著）',
  notClaude: '這位夥伴用的引擎還不能喚醒',
  unsupported: '電腦端或收發室還不支援，請先更新',
}
export const STALE_TEXT = 'ASN 版本可能太舊，或沒有在跑'

// 不是 AI 夥伴的對象：人、手機，群組、ASN 與收發室視窗
const NON_AI_KINDS = new Set(['owner', 'person', 'human', 'phone', 'mobile', 'android', 'room', 'group'])
// 雲端代理（Grok 等）：名單 engine 或節點種類是這些。不在電腦上跑，沒有視窗可管，只能封存
const CLOUD_ENGINES = new Set(['cloud', 'cloud-agent', 'grok'])
// 由內建收發室自己跑的背景工作者（ACP）：名單 engine 是它們的引擎名
const ACP_ENGINES = new Set(['gemini', 'agy', 'antigravity', 'acp'])

// 這位夥伴屬於哪一類：claude（名單沒寫引擎也算）、acp、cloud，其他（Codex 等）回 other
export function partnerEngine(friend) {
  const engine = String(friend?.engine ?? '').trim().toLowerCase()
  const kind = String(friend?.kind ?? '').trim().toLowerCase()
  if (CLOUD_ENGINES.has(engine) || CLOUD_ENGINES.has(kind)) return 'cloud'
  if (!engine || engine === 'claude') return 'claude'
  if (ACP_ENGINES.has(engine)) return 'acp'
  return 'other'
}

// 是不是 AI 夥伴（任何引擎都算，雲端代理也算；封存對它們都可用）。ctx.asn＝節點→在線的 ASN 視窗（名單帶的）；ctx.nonWindowNodes＝已知是手機的節點（選填）
export function isAiPartner(friend, ctx = {}) {
  const f = friend ?? {}
  if (!f.node || !f.agent) return false
  if (f.room || f.group || f.isRoom || f.person || f.isPerson) return false
  if (f.kind && NON_AI_KINDS.has(String(f.kind).toLowerCase())) return false
  if ((ctx.nonWindowNodes ?? []).includes(f.node)) return false
  if (f.engine === 'asn' || isRelayRoom(f.agent)) return false
  if ((ctx.asn?.[f.node] ?? []).some(w => w?.window_name === f.agent)) return false
  return true
}

// 能不能顯示「⋯」與右鍵的管理項目：AI 夥伴，而且是 Claude 視窗或 ACP 工作者。雲端代理與其他引擎不顯示（按了也只會失敗）
export function isManageable(friend, ctx = {}) {
  if (!isAiPartner(friend, ctx)) return false
  const e = partnerEngine(friend)
  return e === 'claude' || e === 'acp'
}

// 選單項目 { key, label, ok, reason }：Claude 視窗在線五項、離線只有「喚醒」；ACP 工作者只有詳情、重開、接班換手；不是能管理的夥伴回空陣列（不顯示「⋯」）。
// ctx：{ machines（節點→設定）, loaded, signedIn, friends, asn, nonWindowNodes, supported（後台有沒有 partner_op；false＝舊後台） }
export function menuItems(friend, ctx = {}) {
  if (!isManageable(friend, ctx)) return []
  const acp = partnerEngine(friend) === 'acp'
  if (friend.status === 'offline') return acp ? [] : resumeItems(friend, ctx)
  const base = baseReason(friend, ctx)
  const machine = ctx.machines?.[friend.node]
  return (acp ? ACP_OPS : ONLINE_OPS).map(key => {
    let reason = base
    // 詳情是唯讀，不需要那台電腦開放；其餘要開放（launcher 不為空）。沒查到設定時也不能確定開放了沒
    if (!reason && key !== 'info') {
      if (!ctx.loaded) reason = REASON.unknown
      else if (!machine?.launcher) reason = REASON.closed
    }
    return { key, label: OP_LABEL[key], ok: !reason, reason }
  })
}

// 離線夥伴的「喚醒」：要有登入、電腦在線且開放遠端管理；這位夥伴用的引擎還不能喚醒（名單上沒寫引擎就當 Claude）
function resumeItems(friend, ctx) {
  if (friend.engine && friend.engine !== 'claude') return []
  let reason = ''
  const machine = ctx.machines?.[friend.node]
  if (ctx.signedIn === false) reason = REASON.needLogin
  else if (ctx.supported === false) reason = REASON.unsupported
  else if (!ctx.loaded) reason = REASON.unknown
  else if (!machine || machine.online !== true) reason = REASON.deviceOffline
  else if (!machine.launcher) reason = REASON.closed
  return [{ key: 'resume', label: OP_LABEL.resume, ok: !reason, reason }]
}

function baseReason(friend, ctx) {
  if (ctx.signedIn === false) return REASON.needLogin
  if (ctx.supported === false) return REASON.unsupported
  if (friend.status === 'offline') return REASON.offline
  const machine = ctx.machines?.[friend.node]
  if (machine && machine.online === false) return REASON.offline
  return ''
}

// ---------- 請求 ----------

// 送出前的檢查（不通過回中文原因，通過回空字串）。input：{ newName, model, note }
export function opFormError(friend, op, input = {}, item = null) {
  if (!OPS.includes(op)) return '不認得這個操作'
  if (item && !item.ok) return item.reason || REASON.unknown
  if (op === 'rename') {
    const n = String(input.newName ?? '').trim()
    if (!NAME_RE.test(n)) return '名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭'
    if (n === friend?.agent) return '新名字和現在一樣'
  }
  if (op === 'model' && !MODEL_RE.test(String(input.model ?? '').trim())) return '請選一個模型（只能用英數與 . _ [ ] -）'
  if (op === 'handover' && String(input.note ?? '').trim().length > NOTE_MAX) return `補充的話最多 ${NOTE_MAX} 字`
  return ''
}

// 送給 Rust 的內容（Rust 與後台還會各檢查一次）。只放該動作用得到的欄位；節點代號與視窗名來自名單，不讓畫面自己填
export function buildOpRequest(friend, op, input = {}) {
  const req = { node: friend.node, name: friend.agent, op }
  if (op === 'rename') req.new_name = String(input.newName ?? '').trim()
  if (op === 'model') req.model = String(input.model ?? '').trim()
  if (op === 'handover') {
    const note = String(input.note ?? '').trim()
    if (note) req.note = note
  }
  return req
}

// ---------- 錯誤與進度 ----------

const CODE_TEXT = {
  unauthorized: REASON.needLogin,
  forbidden: '只有本人能管理夥伴視窗，請確認已登入同一個帳號',
  not_found: '找不到這個視窗（可能剛關掉，或電腦不在線）',
  no_launcher: REASON.closed,
  bad_name: '名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭',
  bad_model: '模型名稱只能用英數與 . _ [ ] -，1～60 字',
  bad_note: `補充的話最多 ${NOTE_MAX} 字`,
  name_taken: '電腦上已經有同名的視窗，換個名字',
  busy: '這個視窗還有一個操作在進行中，等它完成再試',
  rate_limited: '這台電腦這個小時管理太多次了，稍後再試',
  protected: '收發室與 ASN 自己的視窗不能這樣操作',
  already_online: '這位夥伴已經在線上，不需要喚醒',
  no_session: '這位夥伴沒有可接回的對話紀錄，只能開新的夥伴',
  not_claude: REASON.notClaude,
  device_offline: REASON.deviceOffline,
  bad_request: '送出的內容不合格',
  internal: '收發室暫時有問題，稍後再試',
}
// Rust／後台的錯誤字串（例如「partner_op HTTP 409 busy」）→ 給人看的中文
export function opErrorText(msg) {
  const m = String(msg ?? '')
  if (/尚未登入/.test(m)) return REASON.needLogin
  if (/連線失敗|逾時|timed? ?out/i.test(m)) return '連不上收發室，請檢查網路'
  const code = /HTTP (\d+) ?(\w*)/.exec(m)
  if (code && CODE_TEXT[code[2]]) return CODE_TEXT[code[2]]
  if (code && code[1] === '404') return REASON.unsupported   // 舊後台沒有這個動作
  if (!/HTTP/.test(m) && /[一-鿿]/.test(m) && m.length <= 80) return m   // Rust 端自己擋下的（已經是中文）
  return '送出失敗，請稍後再試'
}

const DONE_TEXT = {
  info: '詳情已取得。',
  rename: '已改名。',
  model: '已切換模型。',
  close: '視窗已關閉，對話記錄還在。',
  handover: '接班換手完成，新視窗開好了。',
  resume: '已喚醒，視窗開好了。',
  restart: '已重開，對話保留。',
}
// 接班換手的三個階段（電腦端用 detail 回報 stage:代號）
export const HANDOVER_STEPS = [
  { key: 'handoff', text: '請前任寫交接' },
  { key: 'closing', text: '關閉前任視窗' },
  { key: 'opening', text: '開新視窗' },
]
const stageOf = detail => /^stage:([a-z]+)$/.exec(String(detail ?? ''))?.[1] ?? ''
const stepsAt = (stage, allDone = false) => {
  const at = HANDOVER_STEPS.findIndex(s => s.key === stage)
  return HANDOVER_STEPS.map((s, i) => ({ ...s, state: allDone || i < at ? 'done' : i === at ? 'active' : 'todo' }))
}
// 電腦端回報的原因：只留中文說明；'expired'（後台逾時）與看不懂的英文都換成固定句
function reasonText(detail) {
  const d = String(detail ?? '').replace(/\s+/g, ' ').trim()
  if (!d) return '沒有說明原因'
  if (d === 'expired') return STALE_TEXT
  return /[一-鿿]/.test(d) ? d.slice(0, 200) : '電腦端回報失敗'
}

// 進度：partner_ops 回的那一筆（status：pending／taken／ok／failed／unconfirmed）。
// opts：{ op, sentAt（送出時間，毫秒）, now（毫秒）}；等太久還沒結果就當逾時
// 接班換手的結果補充：交接檔位置（給人看）；前任沒寫完要說
function handoverExtra(result) {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
  const lines = []
  if (typeof r.handoff_path === 'string' && r.handoff_path) lines.push(`交接檔：${short(r.handoff_path, 300)}`)
  if (r.handoff_done === false) lines.push(r.kind === 'acp' ? '這類夥伴沒有請前任寫交接，新對話從空白開始，第一句是接班說明。' : '前任沒有寫完交接，新夥伴會以前任的對話紀錄為主。')
  return lines
}

// 進度：回 { phase, done, text, steps?, extra? }。接班換手處理中依電腦端回報的階段（detail＝stage:代號）分段顯示：
// 請前任寫交接 → 關閉前任視窗 → 開新視窗 → 完成；steps 是各階段的狀態（done／active／todo），完成時附交接檔位置
export function progressView(row, { op = row?.op, sentAt = 0, now = Date.now() } = {}) {
  const waited = sentAt ? now - sentAt : 0
  const limit = row?.status !== 'taken' ? OP_GIVE_UP_MS : op === 'handover' ? HANDOVER_GIVE_UP_MS : op === 'rename' || op === 'model' ? QUEUE_GIVE_UP_MS : OP_GIVE_UP_MS
  switch (row?.status) {
    case 'ok': {
      const v = { phase: 'done', done: true, text: DONE_TEXT[op] ?? '完成。' }
      if (op === 'handover') { v.steps = stepsAt('', true); v.extra = handoverExtra(row.result) }
      return v
    }
    case 'failed': return { phase: 'failed', done: true, text: `沒有成功：${reasonText(row.detail)}` }
    case 'unconfirmed': {
      const v = { phase: 'unconfirmed', done: true, text: '已經送出，但還沒確認結果；稍後看看名單。' }
      if (op === 'handover') v.extra = handoverExtra(row.result)
      return v
    }
    case 'taken':
      if (waited > limit) return { phase: 'failed', done: true, text: `沒有成功：${STALE_TEXT}` }
      if (op === 'handover') {
        const stage = stageOf(row.detail)
        const step = HANDOVER_STEPS.find(s => s.key === stage)
        return { phase: 'working', done: false, text: step ? `${step.text}中…` : '正在處理…', steps: stepsAt(stage) }
      }
      if (stageOf(row.detail) === 'queued') return { phase: 'working', done: false, text: '排隊中，等它忙完…' }
      return { phase: 'working', done: false, text: '正在處理…' }
    default:
      if (waited > OP_GIVE_UP_MS) return { phase: 'failed', done: true, text: `沒有成功：${STALE_TEXT}` }
      return { phase: 'sent', done: false, text: '正在發送指令…' }
  }
}

// ---------- 詳情 ----------

const ENGINE_TEXT = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', pi: 'Pi' }
const STATUS_TEXT = { idle: '閒置', online: '閒置', busy: '忙碌', working: '忙碌', running: '忙碌', thinking: '忙碌', waiting: '等你回應', away: '等你回應', blocked: '等你回應', paused: '暫停' }
const pad = n => String(n).padStart(2, '0')
function timeText(v) {
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v)
  if (!v || Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function tokensText(n) {
  if (!Number.isFinite(n) || n < 0) return ''
  return n >= 10000 ? `${Math.round(n / 1000) / 10} 萬` : String(Math.round(n))
}
function contextText(c) {
  if (c == null) return ''
  if (typeof c === 'number') return Number.isFinite(c) ? `${Math.round(c)}%` : ''
  if (typeof c !== 'object') return ''
  const used = Number(c.used ?? c.tokens), limit = Number(c.limit ?? c.max)
  let pct = Number(c.percent ?? c.pct)
  if (!Number.isFinite(pct) && Number.isFinite(used) && Number.isFinite(limit) && limit > 0) pct = (used / limit) * 100
  const head = Number.isFinite(pct) ? `已用 ${Math.round(pct)}%` : ''
  const tail = Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? `${tokensText(used)} / ${tokensText(limit)}` : ''
  return head && tail ? `${head}（${tail}）` : head || tail
}
const PERM_LABEL = { read: '讀取', write: '寫入', execute: '執行', network: '上網' }
const VERDICT_TEXT = { allow: '允許', ask: '詢問', deny: '拒絕' }
const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k] }
const short = (v, n = 200) => String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)

// 詳情結果 → 中文標籤列 [{ label, value }]；沒有的欄位不列。外殼只列程式名稱，不列命令列參數
export function infoRows(result) {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
  const rows = []
  const add = (label, value) => { if (value !== '' && value != null) rows.push({ label, value: String(value) }) }
  const pid = Number(pick(r, 'pid'))
  add('PID', Number.isInteger(pid) && pid > 0 ? pid : '')
  const model = pick(r, 'model')
  add('模型', model != null ? short(model, 80) : '')
  const engine = pick(r, 'engine')
  add('引擎', engine != null ? (ENGINE_TEXT[String(engine).toLowerCase()] ?? short(engine, 40)) : '')
  const cwd = pick(r, 'cwd', 'workdir', 'work_dir')
  add('工作資料夾', cwd != null ? short(cwd, 260) : '')
  add('開啟時間', timeText(pick(r, 'started_at', 'opened_at', 'start_time')))
  const st = pick(r, 'status', 'state')
  add('狀態', st != null ? (STATUS_TEXT[String(st).toLowerCase()] ?? (/[一-鿿]/.test(String(st)) ? short(st, 40) : '')) : '')
  const by = pick(r, 'opened_by', 'origin', 'launched_by')
  const byAsn = typeof r.by_asn === 'boolean' ? r.by_asn : by != null ? /^asn$/i.test(String(by)) : null
  if (byAsn != null) add('開啟方式', byAsn ? 'ASN 開的' : '自己開的')
  const chain = pick(r, 'shell_chain', 'shell', 'ancestors')
  const names = (Array.isArray(chain) ? chain : typeof chain === 'string' ? chain.split(/\s*(?:→|>)\s*/) : [])
    .filter(x => typeof x === 'string' && x.trim()).slice(0, 8)
    .map(x => short(x.trim().split(/\s+-/)[0].split(/[\\/]/).pop().replace(/\.exe$/i, ''), 30)).filter(Boolean)
  add('外殼', names.join(' → '))
  const mod = pick(r, 'mod', 'mod_installed', 'asn_mod')
  const modOn = typeof mod === 'boolean' ? mod : mod && typeof mod === 'object' ? mod.installed !== false : null
  if (modOn != null) add('ASN 外掛', modOn ? '已安裝' : '沒有安裝')
  add('上下文用量', contextText(pick(r, 'context', 'context_usage')))
  // 收發室自己跑的背景工作者（ACP）另有的欄位
  const perm = r.permissions && typeof r.permissions === 'object' && !Array.isArray(r.permissions) ? r.permissions : null
  if (perm) {
    const text = ['read', 'write', 'execute', 'network'].filter(k => VERDICT_TEXT[perm[k]]).map(k => `${PERM_LABEL[k]}${VERDICT_TEXT[perm[k]]}`).join('、')
    add('權限', text)
  }
  if (typeof r.process_running === 'boolean') add('程序', r.process_running ? '執行中' : '沒有在跑')
  if (typeof r.has_session === 'boolean') {
    add('對話接續', !r.has_session ? '還沒有對話紀錄' : r.load_session === true ? '重開後接續上次的對話' : r.load_session === false ? '重開後會開新的對話' : '')
  }
  return rows
}
