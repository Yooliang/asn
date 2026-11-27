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
]))
export const ALLOW_RE = { test: n => ALLOW_CLASSES.has(n) }
export const SCAN_EXT = new Set(['.html', '.js', '.mjs', '.css'])
const SKIP_DIRS = new Set(['vendor', 'node_modules'])
const TOKEN = /^[A-Za-z_][\w-]*$/

const words = s => s.split(/\s+/).filter(t => TOKEN.test(t))
// :class 的運算式：取引號字串（拆空白）與物件寫法的鍵
const exprTokens = e => {
  const out = []
  for (const m of e.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) out.push(...words(m[1] ?? m[2] ?? m[3] ?? ''))
  for (const m of e.matchAll(/[{,]\s*([A-Za-z_][\w-]*)\s*:/g)) out.push(m[1])
  return out
}
const ATTR = /(?:^|[\s"'`])(:|v-bind:)?class\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const attrClasses = tag => {
  const out = []
  for (const m of tag.matchAll(ATTR)) {
    const val = m[2] ?? m[3] ?? ''
    if (m[1]) out.push(...exprTokens(val))
    else {
      for (const i of val.matchAll(/\$\{([^}]*)\}/g)) out.push(...exprTokens(i[1]))   // 模板字串的 ${} 插值裡的運算式
      out.push(...words(val.replace(/\{\{[\s\S]*?\}\}/g, ' ').replace(/\$\{[^}]*\}/g, ' ')))
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

/** 一段檔案內容裡的提示類 class（已去掉白名單）。ext 是副檔名（含點）。 */
export function scanText(text, ext) {
  const found = new Set()
  // 結尾是 - 的是動態拼接的前綴（例如 'tone-' + 種類），不是完整的 class 名稱
  const keep = n => { if (HINT_RE.test(n) && !ALLOW_RE.test(n) && !n.endsWith('-')) found.add(n) }
  const keepAny = n => { if (!ALLOW_RE.test(n) && !n.endsWith('-')) found.add(n) }
  const scanCss = src => {
    const css = src.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const h of css.matchAll(/([^{}]+)\{/g)) for (const m of h[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) keep(m[1])
  }
  if (ext === '.css') { scanCss(text); return found }
  // .html 裡的 <style> 區塊：當 CSS 掃
  for (const s of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) scanCss(s[1])
  // 一般 class 屬性（含 :class 運算式、字串裡跳脫的 class=\"…\"）
  for (const n of attrClasses(text)) keep(n)
  for (const n of attrClasses(text.replace(/\\(["'])/g, '$1'))) keep(n)
  // class 出現的上下文後面的運算式：class: [...] 陣列、三元、className = / +=、setAttribute('class', …)，裡面帶引號的字串與物件鍵都算
  for (const m of text.matchAll(CLASS_CTX)) for (const n of exprTokens(exprAfter(text, m.index + m[0].length))) keep(n)
  for (const m of text.matchAll(/\bclassList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g)) for (const s of m[1].matchAll(/['"`]([^'"`]*)['"`]/g)) for (const n of words(s[1])) keep(n)
  // role=status／alert／note 的元素：不管名字，掛的 class 都算
  // 標籤比對要認得引號：屬性值裡的 > 不算標籤結束（例如 v-if="a > 1"）
  for (const t of text.matchAll(/<[A-Za-z][\w-]*\b(?:"[^"]*"|'[^']*'|[^<>"'])*>/g)) {
    if (/\brole\s*=\s*["'](?:status|alert|note)["']/.test(t[0])) for (const n of attrClasses(t[0])) keepAny(n)
  }
  return found
}

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(path.join(dir, e.name))) : SCAN_EXT.has(path.extname(e.name)) ? [path.join(dir, e.name)] : [])

/** 掃 relay/asn/ui：回傳 { files: 掃到的檔案數, classes: Map(class → 排序後的檔案清單，相對 relay/asn、用 /) } */
export function scanUi(asnRoot) {
  const uiDir = path.join(asnRoot, 'ui')
  const files = walk(uiDir)
  const classes = new Map()
  for (const f of files) {
    const rel = path.relative(asnRoot, f).split(path.sep).join('/')
    for (const n of scanText(fs.readFileSync(f, 'utf8'), path.extname(f))) {
      if (!classes.has(n)) classes.set(n, new Set())
      classes.get(n).add(rel)
    }
  }
  return { files: files.length, classes: new Map([...classes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, [...v].sort()])) }
}
