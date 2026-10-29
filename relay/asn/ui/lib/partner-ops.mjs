// 手機版與電腦版「管理夥伴視窗」（手機對話頁右上角「⋯」選單、電腦版名單右鍵：詳情、改名、切換模型、關閉視窗、換班接手、喚醒）的純邏輯。
// 視窗在那台電腦上，手機只下指令（後台 relay 的 partner_op／partner_ops，要本人簽章；設計見 docs/design/PARTNER-OPS.md）。
// node 與瀏覽器都能跑，不碰 DOM、不碰 Tauri。給人看的文字純繁體中文，不顯示節點代號與夥伴 ID。
import { NAME_RE } from './mobile-launch.mjs'
import { isRelayRoom } from './roster.mjs'

export const OPS = ['info', 'rename', 'model', 'close', 'handover', 'resume', 'restart', 'remove']
// Claude 視窗：在線的五項；離線的只有「喚醒」
export const ONLINE_OPS = ['info', 'rename', 'model', 'close', 'handover']
// ACP 工作者（Gemini 等收發室自己跑的背景工作者）：詳情、改名、切換模型、關閉（只停止本次執行，不改設定檔）、重開、換班接手、移除；喚醒電腦端會回「這類夥伴不支援」，所以反灰。
// 切換模型（0.2 B4）：Grok 用原生切換不重開；Gemini（agy）帶同一段對話重開。移除（0.2 B3）：只移除「開新夥伴」與接手開出來的。
// 改名（B5，#266）：同樣只改「開新夥伴」與接手開出來的，對話保留、短暫重開。名單分不出哪些寫在 agents.json，所以不在這裡擋，由電腦端回「設定檔裡的名字，請改設定檔」。
// 舊版電腦端（改名是 0.1.107 起）會回「這類夥伴不支援」
export const ACP_OPS = ['info', 'rename', 'model', 'close', 'restart', 'handover', 'remove']
// 已停止（被「關閉」、名單上留著）的工作者：只能看詳情、重開、移除（改名也要先重開）
export const ACP_STOPPED_OPS = ['info', 'restart', 'remove']
export const OP_LABEL = { info: '詳情', rename: '改名', model: '切換模型', close: '關閉視窗', handover: '換班接手', resume: '喚醒', restart: '重開', remove: '移除' }
export const NOTE_MAX = 1000
export const MODEL_RE = /^[A-Za-z0-9._[\]-]{1,60}$/
export const OP_POLL_MS = 3000
export const OP_GIVE_UP_MS = 3 * 60 * 1000   // 後台 2 分鐘沒被取走會自己標失敗；這裡多留一分鐘
export const QUEUE_GIVE_UP_MS = 15 * 60 * 1000   // 改名、切換模型遇到視窗忙碌，外掛會排隊等閒置（電腦端最多等 10 分鐘），處理中的上限放寬
export const HANDOVER_GIVE_UP_MS = 15 * 60 * 1000   // 換班接手要等前任寫交接（最久 10 分鐘），處理中的上限放寬

export const REASON = {
  needLogin: '要先登入，才能管理夥伴視窗',
  unknown: '還沒查到這台電腦的設定，請稍後再試',
  checking: '查詢中，請稍候…',
  offline: '這台電腦或這個視窗不在線',
  closed: '這台電腦沒有開放遠端管理視窗（要到電腦的設定打開「允許遠端開視窗與管理視窗」）',
  deviceOffline: '電腦現在不在線，叫不醒（要讓電腦的 ASN 開著）',
  notClaude: '這位夥伴用的引擎還不能喚醒',
  unsupported: '電腦端或 ASN 服務還不支援，請先更新',
  cloud: '這是雲端代理，在雲端執行，沒有電腦上的視窗可以管理',
  otherEngine: '這位夥伴用的引擎尚未實機驗證，暫不開放從這裡管理視窗',
  alreadyOnline: '這個視窗在線上，不需要喚醒',
  restartOnlyAcp: '「重開」只用在 ASN 內建通道的工作者；一般視窗請用「換班接手」',
  removeOnlyAcp: '「移除」只用在 ASN 內建通道的工作者；一般視窗請用「關閉視窗」，不用的夥伴可以封存',
}
// 背景工作者（ACP）用不到的項目的說明
const ACP_WHY = {
  resume: '這個夥伴由 ASN 內建通道執行，不需要喚醒；要重新啟動請用「重開」',
}
// pi 視窗：開放「切換模型」「改名」（0.2 A4；經 pi 擴充的控制檔，電腦端見 bridge/engines/pi_control.rs）與「關閉」（只結束那個 pi 與子孫，見 partner_ops.rs close_pi）；
// 離線時可「喚醒」（#468，電腦端見 partner_ops.rs resume_pi）；其餘電腦端還沒接，反灰並各自說明。改名要新版的 pi 擴充，舊擴充電腦端會回「請更新擴充」
export const PI_OPS = ['rename', 'model', 'close']
const PI_WHY = {
  info: '這是 pi 視窗，詳情還沒開放',
  handover: '這是 pi 視窗，換班接手還沒開放',
  restart: REASON.restartOnlyAcp,
  remove: REASON.removeOnlyAcp,
}
// pi 的模型代號：`模型` 或 `提供者/模型`。後台的模型欄位只收英數與 . _ [ ] -（1～60 字），所以送出時把「提供者/模型」寫成「提供者[模型]」，電腦端再還原
const PI_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/
export function parsePiModel(input) {
  const parts = String(input ?? '').trim().split('/')
  if (parts.length === 1 && PI_PART_RE.test(parts[0])) return { provider: '', model: parts[0] }
  if (parts.length === 2 && PI_PART_RE.test(parts[0]) && PI_PART_RE.test(parts[1])) return { provider: parts[0], model: parts[1] }
  return null
}
export function piModelWire(input) {
  const m = parsePiModel(input)
  if (!m) return ''
  const w = m.provider ? `${m.provider}[${m.model}]` : m.model
  return w.length <= 60 ? w : ''
}
// 內建通道工作者的模型代號：英數開頭，只能用英數與 . _ -（電腦端還會比對這個工作者可選的模型）
export const ACP_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
export const ACP_MODEL_HINT = '請輸入模型代號，例如 grok-4.6 或 gemini-3.8-flash-high（只能用英數與 . _ -，最多 60 字）'
/**
 * pi「切換模型」的下拉選單（#443／#444）：這台 pi 列得出來的模型（pi-models.mjs 的 cleanPiModels），依提供者分組。
 * pi 可以跨廠商切換（小良哥 #1062），所以列出所有已登入的提供者，不只開夥伴時選的那家。
 * 只收送得出去的（piModelWire 收得下：英數與 . _ -、合起來 60 字內）；value 是「提供者/模型」，跟輸入框同一個格式。
 * current＝名單上這個 pi 現在的模型（「提供者/模型」），放在選單裡就預選它。回 { groups: [{ provider, options: [{ value, label }] }], selected }
 */
export function piModelChoices(models, current = '') {
  const groups = []
  for (const m of Array.isArray(models) ? models : []) {
    const value = `${m?.provider ?? ''}/${m?.model ?? ''}`
    if (!piModelWire(value)) continue
    let g = groups.find(x => x.provider === m.provider)
    if (!g) groups.push((g = { provider: m.provider, options: [] }))
    if (!g.options.some(o => o.value === value)) g.options.push({ value, label: m.model })
  }
  const all = groups.flatMap(g => g.options.map(o => o.value))
  const cur = String(current ?? '').trim()
  return { groups, selected: all.includes(cur) ? cur : all[0] ?? '' }
}
export const PI_MODEL_PICK_ERR = '請從清單選一個模型'
export const PI_MODEL_REMOTE_NOTE = '查不到這台的模型清單（那台要開放遠端管理才會回報），請照 pi 裡的名稱輸入'
export const PI_MODEL_HINT = '請輸入模型，例如 claude-sonnet-5 或 anthropic/claude-sonnet-5（只能用英數與 . _ -，合起來最多 60 字）'
// 背景工作者沒有視窗：「關閉」是停止它本次的執行
export const ACP_CLOSE_LABEL = '關閉'
// 內建通道的工作者沒有前任的對話紀錄可讀，「換班接手」對它就是清掉舊對話、開新對話（並把名下的往來記錄當前情帶進去）；動作代號仍是 handover
export const ACP_NEWCONV_LABEL = '開新對話'
export const STALE_TEXT = 'ASN 版本可能太舊，或沒有在跑'

// 不是 AI 夥伴的對象：人、手機，群組、ASN 與收發室視窗
const NON_AI_KINDS = new Set(['owner', 'person', 'human', 'phone', 'mobile', 'android', 'room', 'group'])
// 雲端代理（Grok 等）：名單 engine 或節點種類是這些。不在電腦上跑，沒有視窗可管，只能封存
const CLOUD_ENGINES = new Set(['cloud', 'cloud-agent'])   // 引擎是 grok 時要看 kind：雲端代理的名單帶 kind=grok，本機的 Grok 背景工作者沒有 kind（#234）
// 由內建收發室自己跑的背景工作者（ACP）：名單 engine 是它們的引擎名
const ACP_ENGINES = new Set(['gemini', 'agy', 'antigravity', 'acp'])

// 查詢前的初始環境：登入狀態還不知道（null），不是「沒登入」；checking＝第一次查詢還沒回來
export const initialOpsCtx = () => ({ machines: {}, loaded: false, signedIn: null, checking: true, authError: '', loadError: '' })

// 登入條件擋不擋：只有「真的查到沒登入」才說要先登入；還沒查到說查詢中；查詢失敗說真正原因。undefined（舊呼叫端沒給）當作沒擋。
export function loginBlock(ctx = {}) {
  if (ctx.signedIn === false) return REASON.needLogin
  if (ctx.signedIn === null) return ctx.authError ? `查不到登入狀態：${ctx.authError}` : REASON.checking
  return ''
}
// 電腦設定還沒查到的說明：失敗說原因、查詢中說查詢中、其餘用舊說法
export function loadBlock(ctx = {}) {
  if (ctx.loaded) return ''
  if (ctx.loadError) return `查不到這台電腦的設定：${ctx.loadError}`
  return ctx.checking ? REASON.checking : REASON.unknown
}

// 本機程序掃描出來的條目（名單 kind＝process，例如「pi #30784（前景）」）：使用者自己在這台電腦開的，ASN 只能顯示
export const isProcessEntry = f => String(f?.entryKind ?? '').trim().toLowerCase() === 'process' || String(f?.kind ?? '').trim().toLowerCase() === 'process'
export function processReason(f) {
  const name = String(f?.agent ?? f?.nick ?? '')
  const eng = String(f?.engine ?? '').trim() || (/^([A-Za-z0-9._-]+)/.exec(name)?.[1] ?? '程式')
  const place = /（([^）]+)）\s*$/.exec(name)?.[1]
  return `這是這台電腦上自己開的 ${eng}${place ? `（${place}）` : ''}：ASN 只能顯示，不能從這裡管理`
}

// 接手：使用者自己在終端機開的 grok（前景程序條目），可以讓 ASN 的 Grok 工作者載入同一段對話。
// 沿用「handover」這個動作代號（後台與簽章流程不用改），選單上改叫「接手」；真正找得到哪一段對話由電腦端決定，找不到會回原因。
export const ADOPT_LABEL = '接手'
export const ADOPT_ACK = '我已了解：接手後我會先關掉終端機那個 grok，兩邊同時用同一段對話可能互相覆蓋'
export const isGrokAdoptable = f => isProcessEntry(f) && /^grok\b/i.test(String(f?.engine ?? '').trim() || String(f?.agent ?? f?.nick ?? '')) && /（前景）\s*$/.test(String(f?.agent ?? f?.nick ?? ''))
// 接手使用者自己開的 pi（0.2 A5）：前景的 pi 程序條目。ASN 會先關掉原本的 pi（終端機留著），再用同一段對話開一個由 ASN 管理的 pi
export const isPiAdoptable = f => isProcessEntry(f) && /^pi\b/i.test(String(f?.engine ?? '').trim() || String(f?.agent ?? f?.nick ?? '')) && /（前景）\s*$/.test(String(f?.agent ?? f?.nick ?? ''))
export const isAdoptable = f => isGrokAdoptable(f) || isPiAdoptable(f)
export const PI_ADOPT_ACK = '我已了解：會先關掉原本的 pi（終端機留著）；它如果正在回覆，這一輪會中斷'
// 對話框文字用的種類：可接手的 grok 程序條目是 'adopt'、pi 是 'pi_adopt'，其餘照原本的種類
export const dialogEngine = f => (isGrokAdoptable(f) ? 'adopt' : isPiAdoptable(f) ? 'pi_adopt' : partnerEngine(f))

// 同一個原因影響多個項目時只寫一次：回 { notes（共用說明，每個原因一行）, rows（項目加 why：只剩各自獨有的原因）}
export function sharedWhy(items) {
  const list = Array.isArray(items) ? items : []
  const count = new Map()
  for (const i of list) if (i && i.ok === false && i.reason) count.set(i.reason, (count.get(i.reason) ?? 0) + 1)
  const notes = [...count].filter(([, n]) => n >= 2).map(([r]) => r)
  const rows = list.map(i => ({ ...i, why: i && i.ok === false && i.reason && !notes.includes(i.reason) ? i.reason : '' }))
  return { notes, rows }
}

// 這位夥伴屬於哪一類：claude（名單沒寫引擎也算）、acp、cloud、pi，其他（Codex 等）回 other
export function partnerEngine(friend) {
  const engine = String(friend?.engine ?? '').trim().toLowerCase()
  const kind = String(friend?.kind ?? '').trim().toLowerCase()
  if (CLOUD_ENGINES.has(engine) || CLOUD_ENGINES.has(kind) || kind === 'grok') return 'cloud'
  if (!engine || engine === 'claude') return 'claude'
  if (ACP_ENGINES.has(engine) || engine === 'grok') return 'acp'
  if (engine === 'pi') return 'pi'
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

// 能不能顯示「⋯」與右鍵的管理項目：AI 夥伴，而且是 Claude 視窗、ACP 工作者或 pi 視窗。雲端代理與其他引擎不顯示（按了也只會失敗）
export function isManageable(friend, ctx = {}) {
  if (!isAiPartner(friend, ctx)) return false
  const e = partnerEngine(friend)
  return e === 'claude' || e === 'acp' || e === 'pi'
}

// 選單項目 { key, label, ok, reason }：項目固定。任何 AI 夥伴（Claude 視窗、背景工作者、雲端代理、其他引擎、在線或離線）都給同一套、同一個順序（MENU_KEYS）；
// 用不到的項目不隱藏，一律 ok:false，reason 寫明這一項為什麼不能用（逐案不同，只寫程式真的判斷得出的條件）。不是 AI 夥伴（人、手機、收發室）回空陣列。
// 可用時的條件與原本完全相同：Claude 視窗在線＝詳情、改名、切換模型、關閉視窗、換班接手；Claude 視窗離線＝喚醒；背景工作者＝詳情、重開、換班接手。
// ctx：{ machines（節點→設定）, loaded, signedIn, friends, asn, nonWindowNodes, supported（後台有沒有 partner_op；false＝舊後台） }
export const MENU_KEYS = ['info', 'rename', 'model', 'close', 'handover', 'resume', 'restart', 'remove']
export function menuItems(friend, ctx = {}) {
  if (!isAiPartner(friend, ctx)) return []
  const engine = partnerEngine(friend)
  const offline = friend.status === 'offline'
  return MENU_KEYS.map(key => {
    const reason = itemReason(key, friend, engine, offline, ctx)
    const adopt = key === 'handover' && isAdoptable(friend)
    const label = adopt ? ADOPT_LABEL : key === 'close' && engine === 'acp' ? ACP_CLOSE_LABEL : key === 'handover' && engine === 'acp' ? ACP_NEWCONV_LABEL : OP_LABEL[key]
    return { key, label, ok: !reason, reason }
  })
}

// 這一項為什麼不能用（能用回空字串）。先看夥伴的種類，再看登入與電腦，最後才是這一項自己的條件
function itemReason(key, friend, engine, offline, ctx) {
  if (key === 'handover' && isAdoptable(friend)) return gateReason(key, friend, ctx)   // 接手：和其他管理項目同一套登入／電腦條件
  if (isProcessEntry(friend)) return processReason(friend)   //本機程序條目：一律是「自己開的，只能顯示」，不看引擎種類（絕不說雲端）
  if (engine === 'cloud') return REASON.cloud
  if (engine === 'other') return REASON.otherEngine
  const label = OP_LABEL[key]
  if (engine === 'pi') {
    if (key === 'resume') return offline ? resumeReason(friend, ctx) : REASON.alreadyOnline   // 喚醒（#468）：關掉的 pi 用同一段對話重開
    if (!PI_OPS.includes(key)) return PI_WHY[key]
    if (offline) return `這個 pi 視窗已離線，現在不能「${label}」`
    return gateReason(key, friend, ctx)
  }
  if (engine === 'acp') {
    if (!ACP_OPS.includes(key)) return ACP_WHY[key]
    if (offline) return `這個內建通道的工作者已離線，現在不能「${label}」`
    if (friend.status === 'stopped' && !ACP_STOPPED_OPS.includes(key)) return `已停止，先按「重開」才能「${label}」`   // 20 字內（小良哥 #1227）
    return gateReason(key, friend, ctx)
  }
  if (key === 'resume') return offline ? resumeReason(friend, ctx) : REASON.alreadyOnline
  if (key === 'restart') return REASON.restartOnlyAcp
  if (key === 'remove') return REASON.removeOnlyAcp
  if (offline) return `這個視窗已離線，要先喚醒才能「${label}」`
  return gateReason(key, friend, ctx)
}

// 在線夥伴的共同條件：要登入、後台支援、電腦在線；詳情是唯讀，不需要那台電腦開放遠端管理，其餘要開放（launcher 不為空）
function gateReason(key, friend, ctx) {
  if (loginBlock(ctx)) return loginBlock(ctx)
  if (ctx.supported === false) return REASON.unsupported
  const machine = ctx.machines?.[friend.node]
  if (machine && machine.online === false) return REASON.offline
  if (key !== 'info') {
    if (!ctx.loaded) return loadBlock(ctx)   // 沒查到設定時也不能確定開放了沒
    if (!machine?.launcher) return REASON.closed
  }
  return ''
}

// 離線 Claude 視窗的「喚醒」：要有登入、電腦在線且開放遠端管理
function resumeReason(friend, ctx) {
  const machine = ctx.machines?.[friend.node]
  if (loginBlock(ctx)) return loginBlock(ctx)
  if (ctx.supported === false) return REASON.unsupported
  if (!ctx.loaded) return loadBlock(ctx)
  if (!machine || machine.online !== true) return REASON.deviceOffline
  if (!machine.launcher) return REASON.closed
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
  if (op === 'model' && partnerEngine(friend) === 'pi') { if (!piModelWire(input.model)) return PI_MODEL_HINT }
  else if (op === 'model' && partnerEngine(friend) === 'acp') { if (!ACP_MODEL_RE.test(String(input.model ?? '').trim())) return ACP_MODEL_HINT }
  else if (op === 'model' && !MODEL_RE.test(String(input.model ?? '').trim())) return '請選一個模型（只能用英數與 . _ [ ] -）'
  if (op === 'handover' && isGrokAdoptable(friend) && input.ack !== true) return '請先勾選確認：接手後要先關掉終端機那個 grok'
  if (op === 'handover' && isPiAdoptable(friend) && input.ack !== true) return '請先勾選確認：會先關掉原本的 pi'
  if (op === 'handover' && String(input.note ?? '').trim().length > NOTE_MAX) return `補充的話最多 ${NOTE_MAX} 字`
  return ''
}

// 送給 Rust 的內容（Rust 與後台還會各檢查一次）。只放該動作用得到的欄位；節點代號與視窗名來自名單，不讓畫面自己填
export function buildOpRequest(friend, op, input = {}) {
  const req = { node: friend.node, name: friend.agent, op }
  if (op === 'rename') req.new_name = String(input.newName ?? '').trim()
  if (op === 'model') req.model = partnerEngine(friend) === 'pi' ? piModelWire(input.model) : String(input.model ?? '').trim()
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
  protected: 'ASN 通知與 ASN 自己的視窗不能這樣操作',
  already_online: '這位夥伴已經在線上，不需要喚醒',
  no_session: '這位夥伴沒有可接回的對話紀錄，只能開新的夥伴',
  not_claude: REASON.notClaude,
  device_offline: REASON.deviceOffline,
  bad_request: '送出的內容不合格',
  internal: 'ASN 暫時有問題，稍後再試',
}
// Rust／後台的錯誤字串（例如「partner_op HTTP 409 busy」）→ 給人看的中文
export function opErrorText(msg) {
  const m = String(msg ?? '')
  if (/尚未登入/.test(m)) return REASON.needLogin
  if (/連線失敗|逾時|timed? ?out/i.test(m)) return '連不上 ASN，請檢查網路'
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
  handover: '換班接手完成，新視窗開好了。',
  resume: '已喚醒，視窗開好了。',
  restart: '已重開，對話保留。',
}
// 換班接手的三個階段（電腦端用 detail 回報 stage:代號）
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
// 換班接手的結果補充：交接檔位置、新視窗用的模型（給人看）；前任沒寫完要說
function handoverExtra(result) {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
  const lines = []
  if (typeof r.handoff_path === 'string' && r.handoff_path) lines.push(`交接檔：${short(r.handoff_path, 300)}`)
  if (typeof r.model === 'string' && r.model.trim()) lines.push(`新視窗用的模型：${short(r.model.trim(), 80)}${r.model_basis === 'launch' ? '（讀不到前任現在用的，沿用它啟動時的設定）' : '（和前任一樣）'}`)
  if (r.handoff_done === false) lines.push(r.kind === 'acp' ? '這類夥伴沒有請前任寫交接；新對話第一句是接班說明，並附上收發室替它記的往來記錄當前情。' : '前任沒有寫完交接，新夥伴會以前任的對話紀錄為主。')
  return lines
}

// 進度：回 { phase, done, text, steps?, extra? }。換班接手處理中依電腦端回報的階段（detail＝stage:代號）分段顯示：
// 請前任寫交接 → 關閉前任視窗 → 開新視窗 → 完成；steps 是各階段的狀態（done／active／todo），完成時附交接檔位置
export function progressView(row, { op = row?.op, sentAt = 0, now = Date.now() } = {}) {
  const waited = sentAt ? now - sentAt : 0
  const limit = row?.status !== 'taken' ? OP_GIVE_UP_MS : op === 'handover' ? HANDOVER_GIVE_UP_MS : op === 'rename' || op === 'model' ? QUEUE_GIVE_UP_MS : OP_GIVE_UP_MS
  switch (row?.status) {
    case 'ok': {
      const v = { phase: 'done', done: true, text: DONE_TEXT[op] ?? '完成。' }
      if (op === 'handover' && row.result?.kind === 'pi_adopt') {
        const who = typeof row.result.name === 'string' ? short(row.result.name, 60) : ''
        v.text = `已接手：原本的 pi 已關閉${row.result.kept_terminal === false ? '' : '（終端機留著）'}，用同一段對話開了由 ASN 管理的 pi${who ? `「${who}」` : ''}。`
        v.extra = ['之後可以從名單寄信給它，也可以改名、切換模型；要改名字請用「改名」。']
        return v
      }
      if (op === 'handover' && row.result?.kind === 'adopt') {
        // 接手 grok：沒有前任、沒有交接檔；提醒先關掉終端機那個 grok
        const who = typeof row.result.name === 'string' ? short(row.result.name, 60) : ''
        v.text = row.result.already === true ? `已經接手過了${who ? `（專屬工作者「${who}」）` : ''}。` : `已接手${who ? `，專屬工作者「${who}」` : ''}載入了同一段對話。`
        v.extra = ['請先關掉終端機那個 grok（ASN 不會替你關）：兩邊同時用同一段對話可能互相覆蓋。']
        return v
      }
      if (op === 'close' && row.result?.kind === 'acp') v.text = '工作者已關閉（本次執行；設定檔沒改）。名單上顯示「已停止」，按「重開」或重啟 ASN 後會恢復。'
      if (op === 'remove') v.text = '已移除：工作者的程序結束了，也從名冊刪掉；工作資料夾的檔案留著。'
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
const STATUS_TEXT = { idle: '閒置', online: '閒置', busy: '忙碌', working: '忙碌', running: '忙碌', thinking: '忙碌', waiting: '等你回應', away: '等你回應', blocked: '等你回應', paused: '暫停', stopped: '已停止' }
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

// 「Claude 外掛」一列的文字。mod＝這台電腦回報的外掛狀態（modOf 的結果）；loaded＝這個視窗有沒有載入（true／false／null 不知道）。純中文
export function claudeModText(mod, loaded = null) {
  if (!mod || typeof mod !== 'object') return ''
  const why = /[一-鿿]/.test(mod.reason ?? '') ? short(mod.reason, 60) : ''
  const ver = mod.version ? ` ${short(mod.version, 32)}` : ''
  switch (mod.state) {
    case 'installed':
      return loaded === true ? `已安裝${ver}，這個視窗已載入`
        : loaded === false ? `已安裝${ver}，但這個視窗是安裝前開的，重開後才會載入`
        : `已安裝${ver}`
    case 'removed': return '已被使用者移除，不會自動重裝'
    case 'no_claude': return '這台電腦找不到 Claude'
    case 'failed': return why ? `安裝失敗：${why}` : '安裝失敗'
    case 'update_failed': return why ? `更新失敗：${why}` : '更新失敗'
    case 'checking': return '檢查中'
    default: return ''
  }
}

// 詳情結果 → 中文標籤列 [{ label, value }]；沒有的欄位不列。外殼只列程式名稱，不列命令列參數
// friend＝名單上的這位（帶 deviceMod 與 modLoaded；舊後台沒有就維持原本的「ASN 外掛」一列）
export function infoRows(result, friend = null) {
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
  const devMod = friend && typeof friend === 'object' ? friend.deviceMod : null
  if (devMod) {
    // 這個視窗有沒有載入：詳情是電腦當場查的，優先；沒有才用名單帶的
    const loaded = modOn != null ? modOn : typeof friend.modLoaded === 'boolean' ? friend.modLoaded : null
    add('Claude 外掛', claudeModText(devMod, loaded))
  } else if (modOn != null) add('ASN 外掛', modOn ? '已安裝' : '沒有安裝')
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
