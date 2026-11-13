// 手機回答 Claude 夥伴的權限框（#853；後台見 _shared/perm_request.ts）的畫面邏輯。
// 手機只能選電腦給的選項，按一個就送那個數字；沒有文字欄位。雜湊由電腦算、這裡原樣帶回。
// 全文只用來給本人看（不寫儲存、不放網址、不進 console、不放系統通知）。
import { clean, errorText as baseError } from './term-ask.mjs'

export const POLL_MS = 30_000
/** 框開著時多久查一次這筆還在不在（電腦撤回不會通知手機，#921） */
export const WATCH_MS = 5_000
/** 框跳出來後多久才能按，免得正在點別的東西時按到 */
export const ARM_MS = 700
/** 按了之後等電腦回報多久（電腦每 3 秒領一次，重查要一點時間） */
export const RESULT_TRIES = 10
export const RESULT_EVERY_MS = 2_000
/** 輪詢發現電腦那邊已經處理掉之後，顯示一行字多久才自動收框 */
export const AUTOCLOSE_MS = 2_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH_RE = /^[0-9a-f]{64}$/
const TEXT_MAX = 16000

export const errorText = baseError

/** 後台清單 → 畫面用的列。欄位壞掉的、已過期的丟掉 */
export function normalizeList(raw, nameOf = () => '', nowMs = Date.now()) {
  const list = Array.isArray(raw?.requests) ? raw.requests : []
  const out = []
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || !UUID_RE.test(r.id) || typeof r.body_hash !== 'string' || !HASH_RE.test(r.body_hash)) continue
    const until = Date.parse(r.expires_at)
    if (!Number.isFinite(until) || until <= nowMs) continue
    const options = Array.isArray(r.options)
      ? r.options.filter(o => o && Number.isInteger(o.n) && o.n >= 1 && o.n <= 9 && typeof o.label === 'string').map(o => ({ n: o.n, label: clean(o.label, 200) }))
      : []
    if (typeof r.prompt_text !== 'string') continue   // 選項可以是空的：多選、一次多題看得到但不能按
    // #1445：權限框的完整原始選項（新電腦＋新後台才有）。種類只認四種，不認得的當「不再詢問」（要按住；以後新增的放行類不會變成點一下）
    const full = Array.isArray(r.options_full)
      ? r.options_full.filter(o => o && Number.isInteger(o.n) && o.n >= 1 && o.n <= 9 && typeof o.label === 'string').map(o => ({ n: o.n, label: clean(o.label, 200), kind: KINDS.includes(o.kind) ? o.kind : 'allow_always' }))
      : []
    out.push({
      id: r.id, hash: r.body_hash, deviceName: clean(nameOf(r.node), 60) || '某台電腦', window: clean(r.window_name, 64),
      text: clean(r.prompt_text, TEXT_MAX), complete: r.complete === true, options,
      full, risk: full.length ? normalizeRisk(r.risk) : { codes: [], uncertain: false },
      fullLen: Number.isInteger(r.full_len) && r.full_len >= 0 ? r.full_len : null,
    })
  }
  return out
}

// ---------- #1445：照原本的選項顯示＋危險提示（設計稿 asn-security/design-1445-phone-perm-danger.md） ----------
const KINDS = ['allow_once', 'allow_always', 'deny', 'other']
/** 危險代碼 → 畫面上的一句話。**警告只從這張表畫出來，絕不從本文推斷**；不認得的代碼不顯示字，但算看不出全貌 */
export const RISK_TEXT = {
  delete_recursive: '會一次刪掉整個資料夾',
  git_destructive: '會改寫或丟掉 git 的歷史紀錄',
  disk_system: '會動到磁碟或系統（格式化、關機、改登錄檔等）',
  remote_exec: '會從網路下載程式並直接執行',
  secret_path: '會讀寫金鑰或憑證所在的位置',
  privilege: '會提高權限或放寬檔案權限',
  db_destructive: '會刪掉資料庫的資料',
  outside_cwd: '會改到這個視窗工作資料夾以外的檔案',
}
/** 電腦端的危險判斷結果 → { codes, uncertain }。格式不對當看不出全貌（寧可多一層小心） */
export function normalizeRisk(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { codes: [], uncertain: true }
  let uncertain = r.uncertain === true
  const codes = []
  for (const c of Array.isArray(r.codes) ? r.codes : []) {
    if (typeof c === 'string' && Object.hasOwn(RISK_TEXT, c)) { if (!codes.includes(c)) codes.push(c) } else uncertain = true
  }
  if (r.codes !== undefined && !Array.isArray(r.codes)) uncertain = true
  return { codes, uncertain }
}

/** 這一筆要不要額外小心：有危險代碼、看不出全貌、確認框沒畫完整 */
export const needsCare = cur => !!cur && (cur.risk.codes.length > 0 || cur.risk.uncertain || !cur.complete)

/** 要畫的選項：有完整選項就照原本的顯示（新電腦），沒有就是舊的兩顆。每一顆標要不要按住一秒：
 *  - 「不再詢問」這類（allow_always）一律要按住；
 *  - 只有這一次（allow_once）在要小心時要按住；
 *  - 拒絕與認不出的不用。 */
export function optionsView(cur) {
  if (!cur) return []
  if (!cur.full.length) return cur.options.map(o => ({ ...o, kind: 'other', hold: false }))
  const care = needsCare(cur)
  return cur.full.map(o => ({ ...o, hold: o.kind === 'allow_always' || (o.kind === 'allow_once' && care) }))
}

/** 警告區塊（放在本文框外面、標題下面）。什麼都沒比中回 null（不顯示任何東西，也不寫「安全」） */
export function riskView(cur) {
  if (!cur || !cur.full.length) return null
  const lines = cur.risk.codes.map(c => RISK_TEXT[c])
  const notes = []
  if (!cur.complete) notes.push(TEXT.cantSeeAll)
  else if (cur.risk.uncertain) notes.push(TEXT.uncertain)
  if (!lines.length && !notes.length) return null
  // 沒有比中的代碼、只有「看不到全部／看不出全貌」：那句話本身當標題，不再多一行「請小心」
  return lines.length ? { title: TEXT.riskTitle, lines, notes } : { title: notes[0], lines, notes: notes.slice(1) }
}

/** 截斷的字數提示：電腦送來的全文比截斷前短時，寫還有幾字沒顯示 */
export function truncNote(cur) {
  if (!cur || !Number.isInteger(cur.fullLen)) return ''
  const shown = [...cur.text].length
  return cur.fullLen > shown ? TEXT.truncated(cur.fullLen - shown) : ''
}

/** 下一筆：跳過「先不處理」的 */
export const nextToAsk = (list, dismissed) => list.find(r => !dismissed.has(r.id)) ?? null

/** 手機按了一個選項：回給 android_perm_req_decide 的參數；不在清單裡回 null（不送） */
export function decideArgs(cur, n) {
  if (!cur || !(cur.options.some(o => o.n === n) || (cur.full ?? []).some(o => o.n === n))) return null
  return { id: cur.id, choiceN: n, hash: cur.hash }
}

/** 這筆請求還在不在清單裡。回 true＝還在、false＝已經結束（撤回、過期、被處理）、null＝這次查不到（失敗或格式不對），不能當成結束 */
export function stillPending(raw, id) {
  if (!raw || !Array.isArray(raw.requests) || typeof id !== 'string') return null
  return raw.requests.some(x => x?.id === id)
}

/** 5 秒輪詢的結果怎麼呈現（只給輪詢用，本人沒按過選項）。已經結束（alive===false）→ 一行說明＋自動收框；其他（還在、查不到）→ null 不動。
 *  本人按了選項之後才得到 cancelled，走 resultOf：紅字，不自動收 */
export function watchOutcome(alive) {
  return alive === false ? { ok: true, text: TEXT.handled, auto: true } : null
}

/** 按了之後的結果。還沒有最終結果回 null，繼續等 */
export function resultOf(raw, id) {
  const r = Array.isArray(raw?.recent) ? raw.recent.find(x => x?.id === id) : null
  if (!r) return null
  if (r.status === 'done') return { ok: true, text: TEXT.done }
  if (r.status === 'failed') return { ok: false, text: `${TEXT.failed}${r.detail ? `：${clean(r.detail, 200)}` : ''}` }
  if (r.status === 'cancelled') return { ok: false, text: TEXT.gone }
  if (r.status === 'expired') return { ok: false, text: TEXT.noReply }
  return null
}

/** 標題：〈電腦名〉的〈夥伴名〉正在詢問；沒有電腦名只寫夥伴名；兩個都沒有就「夥伴正在詢問」 */
export function askTitle(deviceName, window) {
  const d = typeof deviceName === 'string' ? deviceName.trim() : '', w = typeof window === 'string' ? window.trim() : ''
  if (!w) return d ? `${d} ${TEXT.ofWord} 夥伴${TEXT.asking}` : TEXT.askingNoName
  return d ? `${d} ${TEXT.ofWord} ${w} ${TEXT.asking}` : `${w} ${TEXT.asking}`
}

export const TEXT = {
  askingNoName: '夥伴正在詢問',
  asking: '正在詢問',
  ofWord: '的',
  incomplete: '內容太長，這裡只看得到一部分，所以只能拒絕。要允許請到電腦上看完整內容。',
  viewOnly: '這題要到電腦上回答（多選、一次多題，或要自己打字）。',
  noType: '要自己打字，請到電腦上回答。',
  optionLabel: '選項',
  later: '先不處理',
  waiting: '已送出，等電腦確認…',
  done: '電腦已經送出你的選擇',
  failed: '沒有送出',
  gone: '電腦上已經沒有這個提示，沒有送出',
  handled: '電腦上已經處理了這個提示',
  noReply: '電腦沒有回應，沒有送出',
  unknown: '電腦還沒有回報。請到電腦上確認',
  close: '關閉',
  // #1445
  riskTitle: '注意：這個指令可能有風險',
  cantSeeAll: '看不到全部指令，請小心',
  uncertain: '看不出這個指令的全貌（有編碼或拼接），請到電腦上確認',
  holdTip: '按住一秒',
  truncated: n => `（後面還有 ${n} 字沒有顯示，危險字是用完整內容判斷的）`,
}

// 詢問內容是從終端畫面抄來的，裡面整排「────」在窄螢幕會折成好幾行。整行都是分隔線的換成一條細線。
// 分隔字元；行首尾可有空白與框線，行內有別的字就不算（`npm i --silent`、`a--b`、`x = y` 都不動）。
// 這是「權限確認」的內容，要盡量照原樣給人看：終端的框線字元（─━═…）3 個就算；ASCII 的 - _ = 要至少 8 個才算，
// 免得寫檔或 heredoc 內容裡單獨一行的 `---`（YAML／Markdown 分隔）、`===` 被畫成細線（二審意見）
const BOX_RULE_CHARS = '─━═╌╍┄┅┈┉'
const ASCII_RULE_CHARS = '-_='
const FRAME_CHARS = '│┃║|┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝'
export const BOX_RULE_MIN = 3
export const ASCII_RULE_MIN = 8
const isRuleLine = line => {
  let box = 0
  let ascii = 0
  for (const ch of line) {
    if (BOX_RULE_CHARS.includes(ch)) box++
    else if (ASCII_RULE_CHARS.includes(ch)) ascii++
    else if (!FRAME_CHARS.includes(ch) && !/\s/.test(ch)) return false
  }
  return box >= BOX_RULE_MIN || ascii >= ASCII_RULE_MIN
}
const trimBlankLines = lines => {
  let a = 0, b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b)
}

/** 文字 → 區段 [{ text }, { rule: true }, …]。連續分隔線（中間只夾空白行）只留一條，首尾的分隔線拿掉。
 *  沒有任何分隔線時原文不動；空字串或只有空白、只有分隔線 → []。畫面用文字節點顯示 text，不走 v-html */
export function ruleSegments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const lines = raw.split(/\r\n|\r|\n/)
  if (!lines.some(isRuleLine)) return [{ text: raw.replace(/\r\n?/g, '\n') }]
  const out = []
  let buf = []
  let pendingRule = false
  const flush = () => {
    const t = trimBlankLines(buf)
    buf = []
    if (!t.length) return
    if (pendingRule && out.length) out.push({ rule: true })
    pendingRule = false
    out.push({ text: t.join('\n') })
  }
  for (const line of lines) {
    if (isRuleLine(line)) { flush(); pendingRule = true } else buf.push(line)
  }
  flush()
  return out
}
