// 提示類 class 掃描（#2425）：給 test/hint-classes.test.mjs 用。掃 ui 底下的 html／js／mjs／css，
// 找出「名稱像提示」或「掛在 role=status／alert／note 元素上」的 class。規範見 docs/畫面規範.md〈四之一、訊息與提示的位置〉。
import fs from 'node:fs'
import path from 'node:path'

// 名稱以 - 分隔的片段裡有這幾個字，就算提示類
export const HINT_RE = /(?:^|-)(note|hint|err|error|warn|warning|why|tip|notice|banner|toast)s?(?:$|-)/
// 共用元件自己的 class（AsnStatus、AsnNote 和它們的修飾 class）不算。逐一列出（對照 kit.css 與 ui-kit.mjs），不用前綴放行：
// 前綴會把 asn-note-error、asn-note-ok 這種規範禁止的種類也放過。asn-note-fail 是舊的「訂閱已停止」說明（#1646），跟 AsnNote 無關，記在基準裡
export const ALLOW_CLASSES = Object.freeze(new Set([
  'asn-status', 'k-busy', 'k-ok', 'k-fail', 'k-empty', 'k-unreadable',
  'asn-note', 'asn-note-info', 'asn-note-warn', 'asn-note-banner', 'asn-note-text', 'asn-note-action',
  'asn-toast', 'asn-toast-text', 'asn-toast-close',   // AsnToast（#2425 位置 D）；種類沿用 k-ok、k-fail
]))
export const ALLOW_RE = { test: n => ALLOW_CLASSES.has(n) }
export const SCAN_EXT = new Set(['.html', '.js', '.mjs', '.css'])
const SKIP_DIRS = new Set(['vendor', 'node_modules'])
const TOKEN = /^[A-Za-z_][\w-]*$/

// 下面每個函式回傳 [{ n: class 名稱, pos: 在原文裡的位置 }]。位置用來去重：同一處被好幾關抓到只算一次，
// 所以「用處數」＝class 真的出現在 class 位置的次數（註解、一般字串、一般字眼都不算）
const blank = s => ' '.repeat(s.length)   // 同長度換成空白，位置不位移
const words = (s, off = 0) => [...s.matchAll(/\S+/g)].filter(m => TOKEN.test(m[0])).map(m => ({ n: m[0], pos: off + m.index }))
// :class 的運算式：取引號字串（拆空白）與物件寫法的鍵
const exprTokens = (e, off = 0) => {
  const out = []
  for (const m of e.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) out.push(...words(m[1] ?? m[2] ?? m[3] ?? '', off + m.index + 1))
  for (const m of e.matchAll(/[{,]\s*([A-Za-z_][\w-]*)\s*:/g)) out.push({ n: m[1], pos: off + m.index + m[0].search(/[A-Za-z_]/) })
  return out
}
const ATTR = /(?:^|[\s"'`])(:|v-bind:)?class\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const attrClasses = (tag, off = 0) => {
  const out = []
  for (const m of tag.matchAll(ATTR)) {
    const val = m[2] ?? m[3] ?? ''
    const start = off + m.index + m[0].length - 1 - val.length
    if (m[1]) out.push(...exprTokens(val, start))
    else {
      for (const i of val.matchAll(/\$\{([^}]*)\}/g)) out.push(...exprTokens(i[1], start + i.index + 2))   // 模板字串的 ${} 插值裡的運算式
      out.push(...words(val.replace(/\{\{[\s\S]*?\}\}/g, blank).replace(/\$\{[^}]*\}/g, blank), start))
    }
  }
  return out
}

// 從 i 開始取一個運算式（到同一層的 , ; ) ] } 或換行為止；括號與字串內的不算）。給 class: / className = / setAttribute('class', …) 後面用
const exprAfter = (text, i) => {
  let depth = 0
  let j = i
  for (; j < text.length; j++) {
    const c = text[j]
    if (c === '"' || c === "'" || c === '`') {
      for (j++; j < text.length && text[j] !== c; j++) if (text[j] === '\\') j++
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth-- }
    else if (depth === 0 && (c === ',' || c === ';' || c === '\n')) break
  }
  return text.slice(i, j)
}
// class 出現的上下文：class: x、className = x、className += x、setAttribute('class', x)
// （HTML 的 class="…" 屬性另外由 attrClasses 處理，這裡不放，免得把同一個標籤裡別的屬性也當成運算式）
const CLASS_CTX = /(?<![\w-])class\s*:\s*|(?<![\w-])className\s*\+?=(?!=)\s*|\bsetAttribute\(\s*(['"`])class\1\s*,\s*/g

/**
 * 一段檔案內容裡的提示類 class（已去掉白名單），連同每個 class 在 class 位置上出現的次數：Map(class → 次數)。
 * ext 是副檔名（含點）。同一個位置被好幾關抓到只算一次；註解、一般字串、屬性名、role="note" 本身都不是 class 位置，不算。
 */
export function scanTextCounts(text, ext) {
  const occ = new Map()   // class → Set(位置)
  // 結尾是 - 的是動態拼接的前綴（例如 'tone-' + 種類），不是完整的 class 名稱
  const put = (n, pos, any) => {
    if (ALLOW_RE.test(n) || n.endsWith('-') || !(any || HINT_RE.test(n))) return
    if (!occ.has(n)) occ.set(n, new Set())
    occ.get(n).add(pos)
  }
  const keep = ({ n, pos }) => put(n, pos, false)
  const keepAny = ({ n, pos }) => put(n, pos, true)
  const scanCss = (src, off) => {
    const css = src.replace(/\/\*[\s\S]*?\*\//g, blank)
    for (const h of css.matchAll(/([^{}]+)\{/g)) for (const m of h[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) keep({ n: m[1], pos: off + h.index + m.index + 1 })
  }
  const done = () => new Map([...occ].map(([n, s]) => [n, s.size]))
  if (ext === '.css') { scanCss(text, 0); return done() }
  // .html 裡的 <style> 區塊：當 CSS 掃
  for (const s of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) scanCss(s[1], s.index + s[0].indexOf('>') + 1)
  // 一般 class 屬性（含 :class 運算式、字串裡跳脫的 class=\"…\"；跳脫換成同長度的空白＋引號，位置不位移）
  for (const t of attrClasses(text)) keep(t)
  for (const t of attrClasses(text.replace(/\\(["'])/g, ' $1'))) keep(t)
  // class 出現的上下文後面的運算式：class: [...] 陣列、三元、className = / +=、setAttribute('class', …)，裡面帶引號的字串與物件鍵都算
  for (const m of text.matchAll(CLASS_CTX)) { const at = m.index + m[0].length; for (const t of exprTokens(exprAfter(text, at), at)) keep(t) }
  for (const m of text.matchAll(/\bclassList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g)) {
    const base = m.index + m[0].indexOf('(') + 1
    for (const s of m[1].matchAll(/['"`]([^'"`]*)['"`]/g)) for (const t of words(s[1], base + s.index + 1)) keep(t)
  }
  // role=status／alert／note 的元素：不管名字，掛的 class 都算（role 本身不是 class，不算次數）
  // 標籤比對要認得引號：屬性值裡的 > 不算標籤結束（例如 v-if="a > 1"）
  for (const t of text.matchAll(/<[A-Za-z][\w-]*\b(?:"[^"]*"|'[^']*'|[^<>"'])*>/g)) {
    if (/\brole\s*=\s*["'](?:status|alert|note)["']/.test(t[0])) for (const x of attrClasses(t[0], t.index)) keepAny(x)
  }
  return done()
}

/** 一段檔案內容裡的提示類 class（已去掉白名單）。ext 是副檔名（含點）。 */
export const scanText = (text, ext) => new Set(scanTextCounts(text, ext).keys())

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(path.join(dir, e.name))) : SCAN_EXT.has(path.extname(e.name)) ? [path.join(dir, e.name)] : [])

// 一段檔案內容裡每個 class 的「用處數」＝它在 class 位置上出現的次數，直接用掃描器的結果（不另外寫一份比對）。
// 註解、一般字串、屬性名（st.voice.note）、role="note" 都不算
export const countUses = (text, ext) => scanTextCounts(text, ext)

/**
 * 掃一批來源：entries 是 [{ rel: 相對 relay/asn 的路徑（用 /）, text: 內容 }]。
 * 回傳 { files, classes: Map(class → 排序後的檔案清單), uses: Map(class → 總用處數，只算掃得到那個 class 的檔) }。
 * 本機的檔與 git 某個提交上的檔共用這一支，base 與 head 的次數才是同一把尺。
 */
export function scanSources(entries) {
  const classes = new Map()
  const uses = new Map()
  const byFile = new Map()
  for (const { rel, text } of entries) {
    for (const [n, c] of countUses(text, path.extname(rel))) {
      if (!classes.has(n)) { classes.set(n, new Set()); byFile.set(n, new Map()) }
      classes.get(n).add(rel)
      byFile.get(n).set(rel, c)
      uses.set(n, (uses.get(n) ?? 0) + c)
    }
  }
  const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  return {
    files: entries.length,
    classes: new Map([...classes].sort(byName).map(([k, v]) => [k, [...v].sort()])),
    uses: new Map([...uses].sort(byName)),
    byFile,
  }
}

/** 掃 relay/asn/ui：回傳 { files: 掃到的檔案數, classes: Map(class → 排序後的檔案清單，相對 relay/asn、用 /), uses: Map(class → 總用處數) } */
export function scanUi(asnRoot) {
  const files = walk(path.join(asnRoot, 'ui'))
  return scanSources(files.map(f => ({ rel: path.relative(asnRoot, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') })))
}

// 要掃的檔：副檔名在清單內、路徑裡沒有 vendor／node_modules
export const isScanPath = p => SCAN_EXT.has(path.extname(p)) && !p.split('/').some(s => SKIP_DIRS.has(s))

/** 掃 git 某個提交上的 relay/asn/ui（不碰工作樹）。gitShow(路徑) 讀該提交上的檔，gitList() 回傳該提交上 relay/asn/ui 底下的全部路徑（從 repo 根算）。 */
export function scanUiAt(gitList, gitShow) {
  const entries = gitList()
    .filter(isScanPath)
    .map(p => ({ rel: p.replace(/^relay\/asn\//, ''), text: gitShow(p) }))
  return scanSources(entries)
}

// ── 同一張 PR 裡的搬家（#2425）──────────────────────────────────────
// 搬進 ui/parts/ 的基準那一列要有註記（放在基準檔的 moved 對照表）：{ "note": "搬家帶進共用元件、待換", "from": "來源檔" }。
// 之後換成 AsnStatus 時，那一列連註記一起清掉
export const MOVE_NOTE = '搬家帶進共用元件、待換'
export const PARTS_PREFIX = 'ui/parts/'
export const moveKey = (cls, file) => `${cls}（${file}）`

/**
 * 同一張 PR 裡的搬家比對（純函式）。
 *  baseGolden／headGolden：基準檔內容 { classes: {class: [檔…]}, moved?: {"class（檔）": { note, from }} }
 *  baseUses／headUses：base 與 head 實際掃到的各 class 總用處數（Map 或物件）
 *  baseByFile／headByFile：各 class 在每個檔的用處數（class → { 檔: 次數 }，Map 或物件）；次數都只數 class 位置
 * 一個 class 在 head 基準多記了檔（＝新增）時，要同時符合：
 *  1. 總用處數不增加（headUses ≤ baseUses）
 *  2. 檔案數：不在 ui/parts/ 的，只准一對一換檔（總檔案數不增）；目的地在 ui/parts/ 的，總檔案數最多多一個
 *  3. 目的地在 ui/parts/ 的，moved 要有註記文字，並寫明來源檔（from，必須是 base 上這個 class 記著的檔）；
 *     來源檔的用處數減少量（base 減 head）至少等於目的地新增的用處數
 * 另外：新 class 一律紅（extra）；moved 的註記必須對得上基準裡真的記著的 class／檔（orphanNote）；
 * base 上已有註記、檔還在，註記不准偷刪（droppedNote）。
 * 回傳各種違規的清單，全空才算過。
 */
export function evaluateMoves({ baseGolden, headGolden, baseUses, headUses, baseByFile, headByFile }) {
  const num = (u, k) => (u instanceof Map ? u.get(k) : u?.[k])
  const fileUse = (m, k, f) => { const c = m instanceof Map ? m.get(k) : m?.[k]; return (c instanceof Map ? c.get(f) : c?.[f]) ?? 0 }
  const bc = baseGolden.classes; const hc = headGolden.classes
  const bm = baseGolden.moved ?? {}; const hm = headGolden.moved ?? {}
  const out = { extra: [], moreFiles: [], usesGrew: [], missingNote: [], noFrom: [], badSource: [], orphanNote: [], droppedNote: [] }
  for (const [k, files] of Object.entries(hc)) {
    if (!(k in bc)) { out.extra.push(k); continue }
    const added = files.filter(f => !bc[k].includes(f))
    if (added.length === 0) continue
    const excess = files.length - bc[k].length
    const partsAdded = added.filter(f => f.startsWith(PARTS_PREFIX))
    if (excess > 1 || (excess === 1 && partsAdded.length === 0)) out.moreFiles.push(...added.map(f => moveKey(k, f)))
    const b = num(baseUses, k); const h = num(headUses, k)
    if (!Number.isFinite(b) || !Number.isFinite(h)) out.usesGrew.push(`${k}（讀不到用處數：base ${b}、head ${h}）`)
    else if (h > b) out.usesGrew.push(`${k}（${b} → ${h}）`)
    for (const f of partsAdded) {
      const key = moveKey(k, f); const e = hm[key]
      if (e?.note !== MOVE_NOTE) { out.missingNote.push(key); continue }
      if (typeof e.from !== 'string' || !e.from) { out.noFrom.push(key); continue }
      const gain = fileUse(headByFile, k, f) - fileUse(baseByFile, k, f)
      const drop = fileUse(baseByFile, k, e.from) - fileUse(headByFile, k, e.from)
      if (!bc[k].includes(e.from) || e.from === f) out.badSource.push(`${key}（來源 ${e.from} 不是 base 上這個 class 記著的檔）`)
      else if (drop < gain) out.badSource.push(`${key}（來源 ${e.from} 減少 ${drop} 處，少於新增的 ${gain} 處）`)
    }
  }
  for (const [key, e] of Object.entries(hm)) {
    const m = /^(.+)（(.+)）$/.exec(key)
    if (!m || !hc[m[1]]?.includes(m[2]) || e?.note !== MOVE_NOTE) out.orphanNote.push(key)
  }
  for (const key of Object.keys(bm)) {
    const m = /^(.+)（(.+)）$/.exec(key)
    if (m && hc[m[1]]?.includes(m[2]) && !(key in hm)) out.droppedNote.push(key)
  }
  for (const v of Object.values(out)) v.sort()
  return out
}
