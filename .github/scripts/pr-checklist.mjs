// PR 範本檢查（#1805）：PR 說明裡三項必填檢查沒勾、或沒附說明就紅；加「復發」標籤的 PR 要有以單號命名的守門測試。
// 另外兩項由機器主動發現、不等人申報（紀律 一.2、二.6、六.3）：
//  - 只改一邊畫面：只動到手機或電腦其中一邊的畫面檔，PR 說明要有一行「只改一邊：原因」。
//  - 復發：標題是修正、修的那張單在目標分支上已經修過並且發過版，就照「復發」標籤處理；確定不是，寫一行「不是復發：原因」。
// 檢查邏輯都是純函式（test 在 relay/asn/test/pr-checklist.test.mjs）；直接執行時讀 GitHub 的事件檔與本機 git，沒有任何外部相依、不打 API。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 三項必填檢查：key＝範本裡那句問題的關鍵字（用來在 PR 說明找那一行），label＝報錯用的名字 */
export const ITEMS = [
  { id: 'both', key: '手機和電腦一起改了嗎', label: '手機和電腦一起改了嗎' },
  { id: 'real', key: '測試用的是真資料或真路徑嗎', label: '測試用的是真資料或真路徑嗎' },
  { id: 'regress', key: '舊程式會紅」的回歸測試嗎', label: '有「舊程式會紅」的回歸測試嗎' },
]
export const EXEMPT_LABEL = '免檢查表'
export const RECUR_LABEL = '復發'
export const ONE_SIDED_KEY = '只改一邊'    // PR 說明裡自成一行的「只改一邊：原因」
export const NOT_RECUR_KEY = '不是復發'    // PR 說明裡自成一行的「不是復發：原因」
const MIN_DESC = 6   // 說明至少這麼多字（拿掉空白與符號後）
const BOX = /^\s*[-*]\s*\[[ xX]\]/   // 勾選項那一行的開頭：- [ ] 或 - [x]
const CHECKED = /^\s*[-*]\s*\[[xX]\]/

/** 去掉 HTML 註解（範本上方的說明文字不能算數） */
export const stripComments = body => String(body ?? '').replace(/<!--[\s\S]*?-->/g, '')

/** 說明是不是真的寫了：範本留下的「…」、純標點、太短都不算 */
export function descOk(desc) {
  const t = String(desc ?? '').trim()
  if (!t || t.startsWith('…') || t.startsWith('...')) return false
  const core = t.replace(/[\s…。，、；：:;,.()（）「」『』\-—*_`~!?！？]/g, '')
  return core.length >= MIN_DESC
}

/** 從 PR 說明取出三項的勾選狀態與說明。回 [{ id, label, found, checked, desc, ok, why }] */
export function parseChecklist(body) {
  const lines = stripComments(body).split(/\r?\n/)
  return ITEMS.map(it => {
    const i = lines.findIndex(l => BOX.test(l) && l.includes(it.key))
    if (i < 0) return { id: it.id, label: it.label, found: false, checked: false, desc: '', ok: false, why: '說明裡找不到這一項（不要刪掉範本的必填檢查）' }
    const checked = CHECKED.test(lines[i])
    // 說明＝這一行問題後面「說明：」或「測試名稱：」之後的字，加上之後的續行（到下一個勾選項或標題為止）
    const after = lines[i].slice(lines[i].indexOf(it.key) + it.key.length)
    const m = /[：:]/.exec(after)
    const first = m ? after.slice(m.index + 1) : ''
    const rest = []
    for (let j = i + 1; j < lines.length; j++) {
      if (BOX.test(lines[j]) || /^#{1,6}\s/.test(lines[j])) break
      rest.push(lines[j])
    }
    const desc = [first, ...rest].join(' ').replace(/\*+/g, '').trim()
    const ok = checked && descOk(desc)
    const why = !checked ? '沒有勾' : !descOk(desc) ? '沒有寫說明（或還是範本的「…」）' : ''
    return { id: it.id, label: it.label, found: true, checked, desc, ok, why }
  })
}

/** 檔案路徑是不是「只有文件或 CI 設定」（豁免標籤要靠這個驗證，貼了標籤也不放行程式變更） */
export const isDocOrCi = f => /\.md$/i.test(f) || f.startsWith('docs/') || f.startsWith('.github/')

/** 這張 PR 能不能免檢查表：回 { exempt, why, abuse }；abuse＝貼了標籤但改了不該豁免的檔案 */
export function exemption({ title = '', headRef = '', labels = [], files = [] } = {}) {
  if (/^tmp:/i.test(title.trim())) return { exempt: true, why: '臨時 CI 載具 PR（標題 tmp:）' }
  if (headRef.startsWith('release/')) return { exempt: true, why: 'release 分支' }
  if (labels.includes(EXEMPT_LABEL)) {
    const bad = files.filter(f => !isDocOrCi(f))
    if (files.length === 0) return { exempt: false, abuse: '貼了「免檢查表」標籤但看不到改了哪些檔案', why: '' }
    if (bad.length) return { exempt: false, abuse: `貼了「免檢查表」標籤，但改了文件與 CI 設定以外的檔案：${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 個` : ''}`, why: '' }
    return { exempt: true, why: '免檢查表標籤（改的檔案只有文件與 CI 設定）' }
  }
  return { exempt: false, why: '' }
}

/** 最多列 5 個檔名，多的寫總數 */
const listFiles = list => `${list.slice(0, 5).join('、')}${list.length > 5 ? ` 等 ${list.length} 個` : ''}`

/**
 * 找 PR 說明裡自成一行的「關鍵字：原因」（全形、半形冒號都收）。回 { found, ok, reason }：
 * found＝有這一行；ok＝原因過得了 descOk；有好幾行時取第一個原因寫清楚的。
 * 一定要在行首（前面只准有空白、清單符號、引言符號、粗體記號）：範本裡教人怎麼寫的那句話寫在括號或註解裡，不會被當成已經申報。
 */
export function declared(body, key) {
  let first = null
  for (const l of stripComments(body).split(/\r?\n/)) {
    const m = new RegExp(`^[\\s>*_-]*${key}[\\s*_]*[：:](.*)$`).exec(l)
    if (!m) continue
    const reason = m[1].replace(/\*+/g, '').trim()
    if (descOk(reason)) return { found: true, ok: true, reason }
    first ??= { found: true, ok: false, reason }
  }
  return first ?? { found: false, ok: false, reason: '' }
}

// ---------- 只改一邊畫面 ----------
// 清單依 relay/asn/ui/ 的實際載入關係訂（2026-11-27 盤點）。原則：只有那一邊會載入的才算那一邊，兩邊都載入的是共用、不算任何一邊。
const UI_DIR = 'relay/asn/ui/'
/** 手機畫面檔：只有手機版（m.html）載入的頁面、腳本、樣式；另加 lib/mobile*.mjs（扣掉下面那份例外） */
export const MOBILE_UI = ['m.html', 'm.js', 'mobile.css']
/**
 * 名字叫 mobile、但電腦版的頁面也載入的模組：算共用，不算手機那一邊。
 * 例如 mobile-rooms.mjs 是手機和電腦共用的群組邏輯；把它算成手機，「只改 list.html＋mobile-rooms.mjs」會被當成兩邊都改了。
 * 這份清單有守門測試拿實際的 import 關係比對（pr-checklist.test.mjs）：電腦版開始或不再載入某個 mobile*.mjs 時，測試會紅，照訊息改這裡。
 */
export const SHARED_MOBILE_MODULES = [
  'mobile-call.mjs', 'mobile-dictation.mjs', 'mobile-fourth.mjs', 'mobile-guides.mjs', 'mobile-launch.mjs',
  'mobile-ops.mjs', 'mobile-rooms.mjs', 'mobile-settings.mjs', 'mobile-setup.mjs', 'mobile.mjs',
]
/**
 * 電腦畫面檔：只有電腦版載入、而且手機在 m.html 裡有對應畫面的頁面與它的腳本（名單、設定與指引、聊天窗、登入、首次引導）。
 * - style.css 不在這裡：m.html 也載入它（mobile.css 只在它上面改尺寸與排法），是共用的樣式。
 * - 通知小窗、密碼框、安裝進度、截圖（toast／askpass／setup-progress／shot）是電腦才有的小視窗，手機沒有對應的頁面，不列。
 */
export const DESKTOP_UI = ['list.html', 'list.js', 'panel.html', 'panel.js', 'chat.html', 'chat.js', 'login.html', 'login.js', 'onboard.html', 'onboard.js']
const SIDE_NAME = { mobile: '手機', desktop: '電腦' }

/** 這個檔算哪一邊的畫面：'mobile'、'desktop'，或 ''（共用的檔、不是畫面檔） */
export function uiSide(f) {
  const p = String(f ?? '')
  if (!p.startsWith(UI_DIR)) return ''
  const rel = p.slice(UI_DIR.length)
  if (MOBILE_UI.includes(rel)) return 'mobile'
  if (DESKTOP_UI.includes(rel)) return 'desktop'
  const m = /^lib\/(mobile[^/]*\.mjs)$/.exec(rel)
  return m && !SHARED_MOBILE_MODULES.includes(m[1]) ? 'mobile' : ''
}

/** 這張 PR 是不是只動到一邊的畫面檔：回 { side, files }；side＝'mobile'／'desktop'，兩邊都動或都沒動是 '' */
export function oneSided(files = []) {
  const mobile = files.filter(f => uiSide(f) === 'mobile')
  const desktop = files.filter(f => uiSide(f) === 'desktop')
  if (mobile.length && !desktop.length) return { side: 'mobile', files: mobile }
  if (desktop.length && !mobile.length) return { side: 'desktop', files: desktop }
  return { side: '', files: [] }
}

/** 只改一邊的檢查：只動到一邊時，PR 說明要有一行「只改一邊：原因」。回 { required, ok, side, files, reason, why } */
export function oneSidedCheck({ files = [], body = '' } = {}) {
  const os = oneSided(files)
  if (!os.side) return { required: false, ok: true, side: '', files: [], reason: '', why: '' }
  const here = SIDE_NAME[os.side]
  const other = SIDE_NAME[os.side === 'mobile' ? 'desktop' : 'mobile']
  const seen = `只動到${here}的畫面檔（${listFiles(os.files)}），${other}的畫面檔完全沒動`
  const d = declared(body, ONE_SIDED_KEY)
  if (d.ok) return { required: true, ok: true, ...os, reason: d.reason, why: `${seen}；PR 說明寫的原因：${d.reason}` }
  const how = `怎麼辦：補上${other}那一邊；或在 PR 說明另外加一行「${ONE_SIDED_KEY}：是哪個平台本來就沒有這個功能」（${other}那一邊其實改在共用的檔，也寫在這一行）。`
  const why = d.found
    ? `這張 PR ${seen}。PR 說明裡「${ONE_SIDED_KEY}：」後面的原因沒寫清楚（太短，或還是範本的「…」）。${how}`
    : `這張 PR ${seen}。${how}`
  return { required: true, ok: false, ...os, reason: d.reason, why }
}

/** 測試檔路徑 */
export const isTestPath = f => /(^|\/)(tests?|__tests__|golden)\//.test(f) || /([._-]test\.|_test\.|tests\.rs$)/.test(f)

/** 從 unified diff（-U0）取出每個檔案新增的行：Map(檔名 → [行…]) */
export function addedLines(diff) {
  const out = new Map()
  let file = ''
  for (const l of String(diff ?? '').split(/\r?\n/)) {
    const m = /^\+\+\+ b\/(.+)$/.exec(l)
    if (m) { file = m[1]; if (!out.has(file)) out.set(file, []); continue }
    if (l.startsWith('+') && !l.startsWith('+++') && file) out.get(file).push(l.slice(1))
  }
  return out
}

/** 「復發」標籤：PR 說明要寫「復發單號：#N」，而且這張 PR 要加一支以 N 命名的守門測試（檔名有 N，或新增的測試程式裡有 N） */
export function recurrence({ labels = [], body = '', files = [], added = new Map() } = {}) {
  if (!labels.includes(RECUR_LABEL)) return { required: false, ok: true, why: '' }
  const m = /復發單號\s*[：:]\s*#?(\d+)/.exec(stripComments(body))
  if (!m) return { required: true, ok: false, why: '有「復發」標籤，PR 說明要寫「復發單號：#單號」' }
  const n = m[1]
  const num = new RegExp(`(^|[^0-9])${n}([^0-9]|$)`)
  const byName = files.filter(f => isTestPath(f) && num.test(f))
  if (byName.length) return { required: true, ok: true, n, why: `守門測試檔：${byName[0]}` }
  for (const [f, lines] of added) {
    if (!(isTestPath(f) || f.endsWith('.rs') || f.endsWith('.ts'))) continue
    if (lines.some(l => num.test(l) && /(test|fn |assert|describe|it\()/.test(l))) return { required: true, ok: true, n, why: `守門測試：${f}` }
  }
  return { required: true, ok: false, n, why: `復發的 PR 必須加一支以單號 #${n} 命名的守門測試（檔名含 ${n}，或新增的測試裡寫上 ${n}）` }
}

// ---------- 復發：機器比對歷史 ----------
// 定義（紀律 二.6）：這張 PR 是修正，而且它修的那張單在目標分支上已經修過並且發過版，就是復發。
// 下面這幾個函式是這條定義唯一的實作；復發報告（recur-report.mjs）也從這裡匯入，不另寫一份。

/** 標題是不是修正：fix（不分大小寫；前面不是英文字母，後面也不是別的字，所以 fixes／fixed／fixing 算、prefix／fixture 不算）、修、復發 */
export const isFixTitle = t => /(?<![A-Za-z])fix(?:e[sd]|ing)?(?![A-Za-z])|修|復發/i.test(String(t ?? ''))

/** 標題是不是發版提交（release: 開頭） */
export const isReleaseTitle = t => String(t ?? '').startsWith('release: ')

/**
 * 標題裡提到的單號（#數字，不重複，照出現順序）。
 * 結尾括號裡的「(#123)」是合併時自動加在標題後面的 PR 編號，不算單號。
 * 知道這張 PR 自己的編號（own）時改成精確比對：結尾括號裡不是自己編號的，是作者自己寫的單號，照算；自己的編號出現在哪裡都不算。
 */
export function ticketNumbers(title, { own } = {}) {
  let t = String(title ?? '')
  const mine = own == null ? '' : String(own)
  const tail = /\s*\(#(\d+)\)\s*$/.exec(t)
  if (tail && (!mine || tail[1] === mine)) t = t.slice(0, tail.index)
  const out = []
  for (const m of t.matchAll(/#(\d+)/g)) if (m[1] !== mine && !out.includes(m[1])) out.push(m[1])
  return out
}

/**
 * 走一遍歷史（由舊到新），照定義記帳。items 是提交（或提交標題）的陣列，titleOf 取出標題。回 { hits, released }：
 *  - released：Map(單號 → 最近一筆「已經發過版」的修正)，也就是之後再修這張單就算復發的依據。
 *  - hits：歷史裡每一筆復發 [{ n, current, prior }]（current＝這次的修正，prior＝先前那筆已發版的修正）。
 * 修正先記在「還沒發版」；遇到發版提交，才全部轉成「已經發過版」。所以修完還沒發版就再補一張，不算復發。
 */
export function scanRecurrences(items = [], titleOf = x => x) {
  const pending = new Map()
  const released = new Map()
  const hits = []
  for (const it of items) {
    const title = titleOf(it)
    if (isReleaseTitle(title)) {
      for (const [n, fix] of pending) released.set(n, fix)
      pending.clear()
      continue
    }
    if (!isFixTitle(title)) continue
    for (const n of ticketNumbers(title)) {
      if (released.has(n)) hits.push({ n, current: it, prior: released.get(n) })
      pending.set(n, it)
    }
  }
  return { hits, released }
}

/**
 * 這張 PR 是不是復發。輸入 PR 標題與目標分支的提交標題（由舊到新），回命中的 [{ n（單號）, prior（先前那筆修正的標題） }]；沒命中回 []。
 * own＝這張 PR 自己的編號（有給就不會把它當成單號）。
 */
export function recurrenceHits(title, baseTitles = [], { own } = {}) {
  if (!isFixTitle(title)) return []
  const nums = ticketNumbers(title, { own })
  if (!nums.length) return []
  const { released } = scanRecurrences(baseTitles)
  return nums.filter(n => released.has(n)).map(n => ({ n, prior: released.get(n) }))
}

/**
 * 機器比對出來的復發：沒貼「復發」標籤也照復發處理（要寫復發單號、要有以單號命名的守門測試）。
 * 退路：PR 說明自成一行的「不是復發：原因」，放行，並把原因印進報告給審查的人看。
 * 回 { required, ok, hits, waived（放行時的原因）, why }
 */
export function autoRecurrence({ title = '', number, baseTitles = [], body = '', files = [], added = new Map() } = {}) {
  const hits = recurrenceHits(title, baseTitles, { own: number })
  if (!hits.length) return { required: false, ok: true, hits, waived: '', why: '' }
  const nums = hits.map(h => `#${h.n}`).join('、')
  const priors = hits.map(h => `${hits.length > 1 ? `#${h.n} ` : ''}「${h.prior}」`).join('；')
  const seen = `標題是修正，修的 ${nums} 在主線上已經修過並且發過版（先前那筆修正：${priors}），機器判定是復發`
  const no = declared(body, NOT_RECUR_KEY)
  if (no.ok) return { required: true, ok: true, hits, waived: no.reason, why: `${seen}；PR 說明寫「${NOT_RECUR_KEY}：${no.reason}」，請審查的人確認這個原因` }
  const rc = recurrence({ labels: [RECUR_LABEL], body, files, added })
  if (rc.ok) return { required: true, ok: true, hits, waived: '', why: `${seen}，照復發處理；復發單號 #${rc.n}，${rc.why}` }
  const ways = `兩條路擇一：一、是復發：在 PR 說明寫「復發單號：#${hits[0].n}」，並在這張 PR 加一支以單號命名的守門測試（檔名含單號，或新增的測試裡寫上單號）。二、確定不是復發：在 PR 說明另外加一行「${NOT_RECUR_KEY}：原因」，審查的人會看這一句。`
  const lack = rc.n ? `PR 說明寫了復發單號 #${rc.n}，但這張 PR 沒有以 ${rc.n} 命名的守門測試。`
    : no.found ? `PR 說明裡「${NOT_RECUR_KEY}：」後面的原因沒寫清楚（太短，或還是範本的「…」）。` : ''
  return { required: true, ok: false, hits, waived: '', why: `這張 PR 的${seen}。${lack}${ways}` }
}

/** 整合：回 { pass, lines（報告）, errors }。baseTitles＝目標分支的提交標題（由舊到新）；沒給（取不到歷史）就略過復發的自動比對 */
export function evaluate({ title, number, body, headRef, labels = [], files = [], added = new Map(), baseTitles }) {
  const errors = []
  const lines = []
  const ex = exemption({ title, headRef, labels, files })
  if (ex.abuse) errors.push(ex.abuse)
  if (ex.exempt) lines.push(`- ✅ 免檢查表：${ex.why}`)
  else {
    for (const r of parseChecklist(body)) {
      if (r.ok) lines.push(`- ✅ ${r.label}`)
      else { lines.push(`- ❌ ${r.label}：${r.why}`); errors.push(`「${r.label}」${r.why}`) }
    }
    const os = oneSidedCheck({ files, body })
    if (os.required) {
      if (os.ok) lines.push(`- ✅ 只改一邊：${os.why}`)
      else { lines.push(`- ❌ 只改一邊：${os.why}`); errors.push(os.why) }
    }
  }
  // 復發：貼了標籤的照舊（豁免的 PR 也要）；沒貼標籤、也不是豁免的 PR，由機器比對歷史
  const rc = recurrence({ labels, body, files, added })
  if (rc.required) {
    if (rc.ok) lines.push(`- ✅ 復發：${rc.why}`)
    else { lines.push(`- ❌ 復發：${rc.why}`); errors.push(rc.why) }
  } else if (!ex.exempt) {
    if (!Array.isArray(baseTitles)) lines.push('- （略過）復發的自動比對：取不到目標分支的提交歷史')
    else {
      const auto = autoRecurrence({ title, number, baseTitles, body, files, added })
      if (auto.required) {
        if (auto.ok) lines.push(`- ✅ 復發：${auto.why}`)
        else { lines.push(`- ❌ 復發：${auto.why}`); errors.push(auto.why) }
      }
    }
  }
  return { pass: errors.length === 0, lines, errors }
}

// core.quotePath=false：不加的話，git 會把中文檔名印成 "docs/\345\276…"（加引號、轉八進位），
// isDocOrCi／isTestPath 認不出來，只改中文檔名文件的 PR 貼「免檢查表」會被誤擋。
function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd })
}

/** 取 base...HEAD 改到的檔名與新增行（檔名保留原字，不轉義） */
export function changedFiles(base, cwd) {
  const files = git(['diff', '--name-only', `${base}...HEAD`], cwd).split(/\r?\n/).filter(Boolean)
  const added = addedLines(git(['diff', '-U0', '--no-color', `${base}...HEAD`], cwd))
  return { files, added }
}

/**
 * 取一條分支的歷史，由舊到新，每筆提交一行（format 是 git log 的格式，預設只取標題）。復發的自動比對與復發報告都用這個。
 * --topo-order：預設的排法照提交時間交錯，分支上早就寫好、但發版之後才合進來的修正，會被排到那次發版前面，錯算成「修過又發過版」
 *   （2026-11-27 拿主線實測：不加有 42 筆修正排錯，加了是 0）。加了之後，分支上的提交緊跟在把它合進來的那筆前面，也就是照「進主線的先後」排。
 * --no-merges：合併提交本身不是修正，標題是機器產生的（「Merge pull request #編號 from 某人/fix/分支名」），
 *   分支名裡的 fix 和 PR 自己的編號會被認成「修過某張單」。主線上的發版提交沒有一筆是合併提交（同一天實測），拿掉不影響「發過版」的判斷。
 */
export function historyLines(ref, { format = '%s', cwd } = {}) {
  return git(['log', '--reverse', '--topo-order', '--no-merges', `--format=${format}`, ref], cwd).split(/\r?\n/).filter(Boolean)
}

function main() {
  const evPath = process.env.GITHUB_EVENT_PATH
  const ev = evPath && fs.existsSync(evPath) ? JSON.parse(fs.readFileSync(evPath, 'utf8')) : null
  const pr = ev?.pull_request
  if (!pr) { console.log('不是 pull_request 事件，略過'); return 0 }
  const base = `origin/${pr.base.ref}`
  let files = [], added = new Map()
  try {
    ;({ files, added } = changedFiles(base))
  } catch (e) {
    console.log(`::warning::取不到改動的檔案清單（${String(e.message).split('\n')[0]}），豁免、只改一邊與復發檢查可能不準`)
  }
  // 取不到歷史只略過復發的自動比對（evaluate 會在報告裡寫明），不讓整個檢查因此紅
  let baseTitles = null
  try {
    baseTitles = historyLines(base)
  } catch (e) {
    console.log(`::warning::取不到目標分支的提交歷史（${String(e.message).split('\n')[0]}），這次略過復發的自動比對`)
  }
  const labels = (pr.labels ?? []).map(l => l.name)
  const res = evaluate({ title: pr.title, number: pr.number, body: pr.body, headRef: pr.head?.ref ?? '', labels, files, added, baseTitles })
  const md = ['## PR 範本檢查', '', ...res.lines, '', res.pass ? '通過。' : '**沒通過**：到 PR 說明把三項必填檢查勾起來並寫說明，其他紅的項目照那一項寫的做法處理（範本見 .github/pull_request_template.md）；只改文件／CI 的 PR 可加標籤「免檢查表」。', ''].join('\n')
  console.log(md)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  for (const e of res.errors) console.log(`::error::${e}`)
  return res.pass ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
