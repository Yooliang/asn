// 訊息內文的 Markdown 渲染（純函式，電腦版與手機版共用；issue #169）。
// 安全設計（兩道）：
//   1. 自寫小型渲染器、不 vendor 第三方函式庫：輸出的每一個標籤都由這裡的程式碼自己寫出，
//      內文只會以 esc() 跳脫後的「文字」進場——原文中的 <script>、<img onerror>、<iframe>、&#x6A; 這類實體一律只是顯示出來的字，
//      沒有任何一條路徑能把原文的 HTML 原樣帶進輸出。
//   2. 輸出再過一次白名單淨化（sanitize）：標籤、屬性、連結協定逐一檢查，有任何一項不合就整則退回「跳脫成純文字」。
// 不支援圖片（避免外連追蹤）；連結只准 http／https／mailto，點擊由外層攔下、改用系統瀏覽器開。
import { emo, esc } from './text.mjs'

const MAX_LEN = 60000          // 超過就不做 Markdown（退回純文字），避免長訊息卡畫面
const CACHE_MAX = 400
const MAX_DEPTH = 6            // 清單／引用巢狀上限，超過的部分當一般文字

export const MD_TAGS = {
  p: [], br: [], hr: [], strong: [], em: [], del: [], code: [], pre: ['class'],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: [], li: [], blockquote: [],
  table: [], thead: [], tbody: [], tr: [], th: ['class'], td: ['class'],
  a: ['href', 'rel'], div: ['class'], span: ['class', 'title'],
}
const CLASS_OK = /^(md-tablewrap|md-code|emo|al-l|al-c|al-r)$/
const HREF_OK = /^(?:https?:\/\/[^\s<>"'`\\]+|mailto:[^\s<>"'`\\]+)$/i

// ---- 行內 ----
const PUNCT = '\\`*_{}[]()#+-.!~|>:<"\'&/$%^=,;?@'
const isWord = c => !!c && /[\p{L}\p{N}]/u.test(c)

function linkOf(url) {
  url = String(url ?? '').trim()
  return HREF_OK.test(url) && url.length <= 2000 ? url : null
}
const aTag = (url, inner) => `<a href="${esc(url)}" rel="noopener noreferrer nofollow">${inner}</a>`
const textOut = s => emo(s).replace(/\r?\n/g, '<br>')

function trimUrl(u) {
  // 去掉句尾標點與不成對的右括號
  for (;;) {
    const last = u[u.length - 1]
    if (/[.,;:!?'"。，、；：！？）」』】》]/.test(last ?? '') && !(last === ')' && (u.match(/\(/g) || []).length >= (u.match(/\)/g) || []).length)) u = u.slice(0, -1)
    else break
  }
  return u
}

function inline(s, depth = 0) {
  if (depth > MAX_DEPTH) return textOut(s)
  let out = '', buf = '', i = 0
  const flush = () => { if (buf) { out += textOut(buf); buf = '' } }
  const n = s.length
  while (i < n) {
    const c = s[i]
    // 反斜線跳脫
    if (c === '\\' && i + 1 < n && PUNCT.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue }
    // 行內程式碼：同樣長度的反引號包住；內容不換表情
    if (c === '`') {
      let j = i; while (s[j] === '`') j++
      const run = s.slice(i, j)
      const close = s.indexOf(run, j)
      let k = close
      while (k !== -1 && s[k + run.length] === '`') k = s.indexOf(run, k + run.length + 1)   // 結尾反引號不能更長
      if (k !== -1 && k > j) {
        flush()
        out += `<code>${esc(s.slice(j, k).replace(/\n/g, ' ').replace(/^ (.*\S.*) $/, '$1'))}</code>`
        i = k + run.length; continue
      }
      buf += run; i = j; continue
    }
    // 連結 [文字](網址 "標題")
    if (c === '[') {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\s]*>|[^\s)]*(?:\([^\s)]*\)[^\s)]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(s.slice(i, i + 4000))
      if (m) {
        const url = linkOf(m[2].replace(/^<|>$/g, ''))
        flush()
        out += url ? aTag(url, inline(m[1], depth + 1)) : inline(m[1], depth + 1)
        i += m[0].length; continue
      }
    }
    // <https://…> 自動連結（其他尖括號一律當文字）
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i, i + 2100))
      if (m && linkOf(m[1])) { flush(); out += aTag(m[1], esc(m[1])); i += m[0].length; continue }
    }
    // 裸網址
    if ((c === 'h' || c === 'H') && !isWord(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>"'`\\]+/i.exec(s.slice(i, i + 2100))
      if (m) {
        const u = trimUrl(m[0])
        if (u.length > 8 && linkOf(u)) { flush(); out += aTag(u, esc(u)); i += u.length; continue }
      }
    }
    // 粗斜體、刪除線
    if (c === '*' || c === '_' || c === '~') {
      const rest = s.slice(i)
      let m, tag
      if (c === '~') { m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest); tag = m && 'del' }
      else {
        const q = c === '*' ? '\\*' : '_'
        const wordOk = c === '*' || !isWord(s[i - 1])   // 底線在字中間不算（snake_case_name）
        if (wordOk) {
          if ((m = new RegExp(`^${q}${q}${q}(?=[^\\s${q}])([\\s\\S]*?[^\\s${q}])${q}${q}${q}`).exec(rest))) tag = 'strong+em'
          else if ((m = new RegExp(`^${q}${q}(?=\\S)([\\s\\S]*?\\S)${q}${q}`).exec(rest))) tag = 'strong'
          else if ((m = new RegExp(`^${q}(?=[^\\s${q}])([\\s\\S]*?[^\\s${q}])${q}(?!${q})`).exec(rest))) tag = 'em'
          if (m && c === '_' && isWord(s[i + m[0].length])) m = null
        }
      }
      if (m && tag) {
        flush()
        const inner = inline(m[1], depth + 1)
        out += tag === 'strong+em' ? `<strong><em>${inner}</em></strong>` : `<${tag}>${inner}</${tag}>`
        i += m[0].length; continue
      }
    }
    buf += c; i++
  }
  flush()
  return out
}

// ---- 區塊 ----
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/
const HR = /^ {0,3}([-*_])(?: *\1){2,} *$/
const HEAD = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const QUOTE = /^ {0,3}>\s?/
const ULI = /^(\s*)[-*+][ \t]+(.*)$/
const OLI = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/
const SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/
const indentOf = l => (/^\s*/.exec(l.replace(/\t/g, '    '))[0].length)

function cells(line) {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const out = []; let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++ }
    else if (t[i] === '`') { // 程式碼裡的 | 不分欄
      const j = t.indexOf('`', i + 1)
      if (j > -1) { cur += t.slice(i, j + 1); i = j } else cur += t[i]
    } else if (t[i] === '|') { out.push(cur.trim()); cur = '' }
    else cur += t[i]
  }
  out.push(cur.trim())
  return out
}
const isBlockStart = l => FENCE.test(l) || HR.test(l) || HEAD.test(l) || QUOTE.test(l) || ULI.test(l) || OLI.test(l)

function blocks(lines, depth, tight) {
  const out = []
  let i = 0
  const para = text => (tight ? inline(text, 0) : `<p>${inline(text, 0)}</p>`)
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (depth > MAX_DEPTH) { out.push(para(lines.slice(i).join('\n').trim())); break }
    let m
    // 程式碼區塊：保留原樣縮排、不換表情；沒收尾就吃到最後
    if ((m = FENCE.exec(line))) {
      const mark = m[1], body = []
      i++
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && /^[`~]+\s*$/.test(lines[i].trim()))) body.push(lines[i++])
      i++
      out.push(`<pre class="md-code"><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    if (HR.test(line)) { out.push('<hr>'); i++; continue }
    if ((m = HEAD.exec(line))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue }
    if (QUOTE.test(line)) {
      const q = []
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || (q.length && !isBlockStart(lines[i])))) q.push(lines[i++].replace(QUOTE, ''))
      out.push(`<blockquote>${blocks(q, depth + 1, false)}</blockquote>`)
      continue
    }
    // 表格：標題列＋分隔列
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && SEP.test(lines[i + 1])) {
      const head = cells(line), sep = cells(lines[i + 1])
      if (head.length === sep.length) {
        const al = sep.map(c => (c.startsWith(':') && c.endsWith(':') ? 'al-c' : c.endsWith(':') ? 'al-r' : c.startsWith(':') ? 'al-l' : ''))
        const cell = (tag, t, k) => `<${tag}${al[k] ? ` class="${al[k]}"` : ''}>${inline(t)}</${tag}>`
        let html = `<div class="md-tablewrap"><table><thead><tr>${head.map((t, k) => cell('th', t, k)).join('')}</tr></thead><tbody>`
        i += 2
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const r = cells(lines[i++])
          html += `<tr>${head.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`
        }
        out.push(`${html}</tbody></table></div>`)
        continue
      }
    }
    // 清單（含巢狀）：同縮排的同類標記為一個清單，更深縮排的行歸給上一項
    if (ULI.test(line) || OLI.test(line)) {
      const first = ULI.exec(line) || OLI.exec(line)
      const base = indentOf(first[1]), ordered = !ULI.test(line)
      const items = []
      while (i < lines.length) {
        const l = lines[i]
        const mm = ordered ? OLI.exec(l) : ULI.exec(l)
        if (mm && indentOf(mm[1]) <= base + 1 && indentOf(mm[1]) >= base - 1) {
          items.push({ head: ordered ? mm[3] : mm[2], rest: [], n: ordered ? Number(mm[2]) : 0 })
          i++
        } else if (items.length && (l.trim() === '' ? (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > base) : indentOf(l) > base)) {
          items[items.length - 1].rest.push(l); i++
        } else break
      }
      const tagName = ordered ? 'ol' : 'ul'
      const strip = rest => { const ind = Math.min(...rest.filter(x => x.trim()).map(indentOf), 1e9); return rest.map(x => x.replace(/\t/g, '    ').slice(Math.min(ind, indentOf(x)))) }
      const li = items.map(it => {
        const inner = it.rest.length ? blocks([it.head, ...strip(it.rest)], depth + 1, true) : inline(it.head)
        return `<li>${inner}</li>`
      }).join('')
      out.push(`<${tagName}>${li}</${tagName}>`)   // 序號起點（start 屬性）不在白名單，不保留
      continue
    }
    // 段落：連續的行，遇到空行或其他區塊開頭為止；單一換行也換行（聊天習慣）
    const p = [line]
    i++
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes('-'))) p.push(lines[i++])
    out.push(para(p.map(x => x.replace(/\s+$/, '')).join('\n')))
  }
  return out.join('')
}

// ---- 白名單淨化 ----
// 輸出只應含 MD_TAGS 的標籤與其白名單屬性；屬性值：class 限固定名稱、href 限 http(s)／mailto、rel 固定、title 只出現在 emo 的 span。
// 不合 → 回 null，呼叫端退回純文字。
export function sanitize(html) {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*(\/?)>/g
  const stripped = html.replace(re, (all, close, name, attrs) => {
    name = name.toLowerCase()
    const allowed = MD_TAGS[name]
    if (!allowed) return '\u0000'
    if (close && attrs.trim()) return '\u0000'
    const ar = /\s+([a-zA-Z-]+)="([^"]*)"/g
    let a
    while ((a = ar.exec(attrs))) {
      const [, k, v] = a
      if (!allowed.includes(k.toLowerCase())) return '\u0000'
      if (k === 'class' && !v.split(' ').every(x => CLASS_OK.test(x))) return '\u0000'
      if (k === 'rel' && v !== 'noopener noreferrer nofollow') return '\u0000'
      if (k === 'href' && !HREF_OK.test(v.replace(/&amp;/g, '&'))) return '\u0000'
    }
    return ''
  })
  // 剩下的文字裡不可再有未跳脫的 < 或 >（跳脫過的文字只會有 &lt; &gt;）、也不可有被標記的違規
  return /[<>\u0000]/.test(stripped) ? null : html
}

const cache = new Map()
// 把訊息內文轉成安全的 HTML；長度超過上限、淨化失敗都退回 emo()（跳脫＋表情）加換行
export function renderMarkdown(src) {
  const text = String(src ?? '')
  const hit = cache.get(text)
  if (hit !== undefined) { cache.delete(text); cache.set(text, hit); return hit }   // LRU：用過的移到最後
  let html
  if (text.length > MAX_LEN) html = textOut(text)
  else {
    try { html = sanitize(blocks(text.replace(/\r\n?/g, '\n').split('\n'), 0, false)) } catch { html = null }
    if (html == null) html = textOut(text)
  }
  cache.set(text, html)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return html
}

// 外層點擊處理：點到 <a href> 就擋下預設導覽、交給 open(url)（系統瀏覽器）。回傳是否處理了。
export function handleLinkClick(ev, open) {
  const a = ev?.target?.closest?.('a[href]')
  if (!a) return false
  ev.preventDefault?.()
  const url = a.getAttribute('href') || ''
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) { try { open(url) } catch { /* 開不了就算了 */ } }
  return true
}
