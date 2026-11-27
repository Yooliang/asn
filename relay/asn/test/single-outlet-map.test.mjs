// 守門：唯一出口地圖（docs/唯一出口.md）不過期（開發紀律第零節第 3、4 條）。
// 由來：前端共用模組兩百多個、Rust 檔三百多個，沒有一頁寫「這類事情的唯一出口在哪」；不記得前情的夥伴搜不到既有做法就再寫一份。
// 地圖本身也是一張清單，沒有守門的清單過幾天就不能信，所以這支逐列檢查：
//   ① 表頭固定五欄、至少 15 列、每列五欄、沒有空格子
//   ②「唯一出口」欄每列至少一個反引號路徑，而且檔案或資料夾真的存在（出口搬家或改名，這裡就紅，逼人回來改地圖）
//   ③「守門測試」欄不是「無（靠人）」的，至少寫一個反引號路徑，而且都存在（守門被刪掉卻還寫著，等於騙人）
//   ④「還沒收斂的副本」欄列出的反引號路徑都存在（副本刪掉了，就把這欄改成「無」）
//   ⑤ 同一個「要做的事」只出現一次（兩列各指一個出口，就不是唯一出口）
//   ⑥ 這三欄裡的反引號只准包「路徑」或「函式名」：有斜線或句點的當路徑查，其餘要長得像函式名；看不懂的一律紅，不會悄悄略過
// 檢查核心是純函式 checkMap(文字, 查檔函式)；最後兩支是還原驗證：把真的地圖故意改壞，確認每一種都抓得到。
// 只讀檔、不連網、只用 node 內建模組。「怎麼用」那一欄是給人讀的一句話，這裡不檢查內容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DOC = 'docs/唯一出口.md'

export const HEADER = ['要做的事', '唯一出口', '怎麼用（一句話）', '守門測試', '還沒收斂的副本']
export const NO_GUARD = '無（靠人）'
export const NO_COPY = '無'
export const MIN_ROWS = 15
const [TASK, OUTLET, , GUARD, COPIES] = [0, 1, 2, 3, 4]

/** 表格的一行切成各欄：反引號裡的直線、前面有反斜線的直線都不算分隔 */
export function splitRow(line) {
  const cells = []
  let cur = ''
  let inCode = false
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\' && body[i + 1] === '|') { cur += '|'; i++; continue }
    if (c === '`') inCode = !inCode
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  cells.push(cur.trim())
  return cells
}

/** 找出表頭等於 HEADER 的那張表；回 { tables: 找到幾張, rows: [{ line: 行號（從 1 起算）, cells }] } */
export function parseMap(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n')
  const isHeader = l => l.trim().startsWith('|') && splitRow(l).join('\u0000') === HEADER.join('\u0000')
  const heads = lines.map((l, i) => (isHeader(l) ? i : -1)).filter(i => i >= 0)
  if (heads.length !== 1) return { tables: heads.length, rows: [] }
  const rows = []
  for (let i = heads[0] + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push({ line: i + 1, cells: splitRow(lines[i]) })
  const sep = lines[heads[0] + 1] ?? ''
  return { tables: 1, sepOk: /^\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(sep.trim()), rows }
}

/** 一格裡所有用反引號包起來的字 */
export const ticked = cell => [...String(cell).matchAll(/`([^`]+)`/g)].map(m => m[1])
/** 長得像 repo 內路徑：有斜線或句點，而且沒有空白 */
export const isPathLike = s => /[/.]/.test(s) && !/\s/.test(s)
/** 長得像函式名、常數名、巨集名（可以帶 :: 與結尾的 () 或 !） */
export const isNameLike = s => /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*(\(\)|!)?$/.test(s)
export const pathsIn = cell => ticked(cell).filter(isPathLike)
/** 路徑要從 repo 根目錄起算：不准絕對路徑、不准往上跳、不准反斜線 */
const wellFormed = p => !path.isAbsolute(p) && !p.includes('\\') && !p.split('/').includes('..') && !p.startsWith('./')
const existsInRepo = p => fs.existsSync(path.join(ROOT, p))
const startsWithWord = (cell, word) => cell === word || new RegExp(`^${word}[（(；;，,。：:\\s]`).test(cell)

/**
 * 檢查整份地圖，回 [{ kind, line, msg }]；沒有問題回空陣列。
 * kind：table（表不見了或不只一張）、rows（列數不夠）、cols（欄數不對）、empty（有空格子）、
 *       outlet（出口欄沒寫路徑）、guard（守門欄沒寫路徑也不是「無（靠人）」）、copies（副本欄沒寫路徑也不是「無」）、
 *       missing（路徑不存在或寫法不對）、token（反引號裡的東西看不懂）、dup（要做的事重複）
 */
export function checkMap(md, exists = existsInRepo) {
  const errs = []
  const add = (kind, line, msg) => errs.push({ kind, line, msg })
  const { tables, sepOk, rows } = parseMap(md)
  if (tables !== 1) {
    add('table', 0, tables === 0 ? `找不到表頭是「${HEADER.join('｜')}」的表（欄位名稱與順序是固定的）` : `表頭是「${HEADER.join('｜')}」的表有 ${tables} 張，只能有一張`)
    return errs
  }
  if (!sepOk) add('table', 0, '表頭下一行不是分隔線（|---|---|…）')
  if (rows.length < MIN_ROWS) add('rows', 0, `表只有 ${rows.length} 列，至少要 ${MIN_ROWS} 列（整張表被截掉了？）`)
  const seen = new Map()
  for (const { line, cells } of rows) {
    const where = `第 ${line} 行「${cells[TASK] ?? ''}」`
    if (cells.length !== HEADER.length) { add('cols', line, `${where}有 ${cells.length} 欄，要正好 ${HEADER.length} 欄（格子裡要寫直線請放進反引號）`); continue }
    cells.forEach((c, i) => { if (!c) add('empty', line, `${where}的「${HEADER[i]}」是空的`) })
    const key = cells[TASK].replace(/\s+/g, '')
    if (seen.has(key)) add('dup', line, `${where}和第 ${seen.get(key)} 行重複：同一件事只能有一列`)
    else seen.set(key, line)
    for (const col of [OUTLET, GUARD, COPIES]) {
      for (const t of ticked(cells[col])) {
        if (isPathLike(t)) {
          if (!wellFormed(t)) add('missing', line, `${where}的「${HEADER[col]}」：\`${t}\` 要寫成從 repo 根目錄起算的相對路徑`)
          else if (!exists(t)) add('missing', line, `${where}的「${HEADER[col]}」：\`${t}\` 不存在`)
        } else if (!isNameLike(t)) add('token', line, `${where}的「${HEADER[col]}」：\`${t}\` 看不出是路徑還是函式名（路徑要有斜線，函式名只用英數與底線）`)
      }
    }
    if (pathsIn(cells[OUTLET]).length === 0) add('outlet', line, `${where}的「唯一出口」沒有用反引號寫出檔案路徑`)
    if (cells[GUARD] && !startsWithWord(cells[GUARD], NO_GUARD) && pathsIn(cells[GUARD]).length === 0) add('guard', line, `${where}的「守門測試」要嘛寫「${NO_GUARD}」，要嘛用反引號寫出測試檔路徑`)
    if (cells[COPIES] && !startsWithWord(cells[COPIES], NO_COPY) && pathsIn(cells[COPIES]).length === 0) add('copies', line, `${where}的「還沒收斂的副本」要嘛寫「${NO_COPY}」，要嘛用反引號列出副本的路徑`)
  }
  return errs
}

const fmt = errs => errs.map(e => `  ${e.msg}`).join('\n')
const of = (errs, ...kinds) => errs.filter(e => kinds.includes(e.kind))
const colOf = (errs, col) => errs.filter(e => e.msg.includes(`的「${HEADER[col]}」`))

const doc = fs.existsSync(path.join(ROOT, DOC)) ? fs.readFileSync(path.join(ROOT, DOC), 'utf8').replace(/\r\n/g, '\n') : ''
const real = checkMap(doc)
const map = parseMap(doc)

test('解析表格：表頭固定五欄，表至少有 15 列，每列欄數正確、沒有空格子', () => {
  assert.ok(doc, `找不到 ${DOC}`)
  const bad = of(real, 'table', 'rows', 'cols', 'empty')
  assert.equal(bad.length, 0, `\n${fmt(bad)}`)
  assert.ok(map.rows.length >= MIN_ROWS)
  for (const r of map.rows) assert.equal(r.cells.length, HEADER.length)
})

test('「唯一出口」欄：每一列至少有一個反引號路徑，而且每個路徑的檔案或資料夾都存在', () => {
  const bad = [...of(real, 'outlet'), ...colOf(of(real, 'missing'), OUTLET)]
  assert.equal(bad.length, 0, `出口搬家或改名了就改這張表；出口整個拿掉了就刪掉那一列：\n${fmt(bad)}`)
  assert.ok(map.rows.every(r => pathsIn(r.cells[OUTLET]).length >= 1))
})

test('「守門測試」欄：不是「無（靠人）」的，每個反引號路徑都存在', () => {
  const bad = [...of(real, 'guard'), ...colOf(of(real, 'missing'), GUARD)]
  assert.equal(bad.length, 0, `守門改名了就一起改這張表；守門真的拿掉了，就把這欄改成「${NO_GUARD}」：\n${fmt(bad)}`)
  // 防假綠：表裡真的有寫守門的列，也真的有寫「無（靠人）」的寫法可以走
  assert.ok(map.rows.filter(r => pathsIn(r.cells[GUARD]).length > 0).length >= 10, '寫了守門測試路徑的列不到 10 列，解析是不是壞了？')
})

test('「還沒收斂的副本」欄：列出的每個反引號路徑都存在（副本刪掉了就把這欄改成「無」）', () => {
  const bad = [...of(real, 'copies'), ...colOf(of(real, 'missing'), COPIES)]
  assert.equal(bad.length, 0, `副本收掉了是好事：把它從這欄拿掉，全部收完就改成「${NO_COPY}」：\n${fmt(bad)}`)
})

test('同一個「要做的事」不重複出現', () => {
  const bad = of(real, 'dup')
  assert.equal(bad.length, 0, `\n${fmt(bad)}`)
  assert.equal(new Set(map.rows.map(r => r.cells[TASK].replace(/\s+/g, ''))).size, map.rows.length)
})

test('三個路徑欄裡的反引號只包路徑或函式名（看不懂的不會被悄悄略過）', () => {
  const bad = of(real, 'token')
  assert.equal(bad.length, 0, `\n${fmt(bad)}`)
  assert.equal(isPathLike('relay/asn/ui/lib/event-hub.mjs'), true)
  assert.equal(isPathLike('CLAUDE.md'), true)
  assert.equal(isPathLike('invoke'), false)
  for (const ok of ['invoke', 'createWindowHub()', 'ui_log::append', 'elog!', 'RUST_EVENTS', 'asn_relay_send_notice']) assert.equal(isNameLike(ok), true, ok)
  for (const no of ['v-html', '兩個 字', 'a b', '']) assert.equal(isNameLike(no), false, no)
})

// ---- 還原驗證：把地圖故意改壞，確認每一種都抓得到 ----
const kinds = (text, exists) => new Set(checkMap(text, exists).map(e => e.kind))
const lines = () => doc.split('\n')
/** 把第 n 列（從 0 起算）用 f(各欄) 改掉，回新的整份文字 */
const editRow = (n, f) => {
  const ls = lines()
  const r = map.rows[n]
  ls[r.line - 1] = `| ${f([...r.cells]).join(' | ')} |`
  return ls.join('\n')
}
const firstRowWith = pred => map.rows.findIndex(r => pred(r.cells))
/** 把這一格裡第一個路徑改成不存在的檔名 */
const breakFirstPath = cell => cell.replace(`\`${pathsIn(cell)[0]}\``, `\`${pathsIn(cell)[0]}.不存在\``)

test('還原驗證：路徑改成不存在的檔名、欄位少一格、格子清空、同一件事寫兩列，都會紅', () => {
  assert.equal(real.length, 0, `真的地圖要先是乾淨的：\n${fmt(real)}`)
  // 出口路徑改成不存在的檔
  const broken = editRow(0, c => { c[OUTLET] = breakFirstPath(c[OUTLET]); return c })
  assert.deepEqual([...kinds(broken)], ['missing'])
  assert.match(checkMap(broken)[0].msg, /唯一出口/)
  // 出口欄只剩文字、沒有路徑
  assert.ok(kinds(editRow(0, c => { c[OUTLET] = '看程式就知道'; return c })).has('outlet'))
  // 守門測試的路徑改成不存在的檔
  const g = firstRowWith(c => pathsIn(c[GUARD]).length > 0)
  const brokenGuard = editRow(g, c => { c[GUARD] = breakFirstPath(c[GUARD]); return c })
  assert.ok(colOf(checkMap(brokenGuard), GUARD).length > 0)
  // 守門欄寫了別的字，既不是路徑也不是「無（靠人）」
  assert.ok(kinds(editRow(g, c => { c[GUARD] = '有，忘了在哪'; return c })).has('guard'))
  assert.ok(!kinds(editRow(g, c => { c[GUARD] = NO_GUARD; return c })).has('guard'), '「無（靠人）」是合法寫法')
  // 副本欄：路徑不存在、寫了字卻沒路徑
  const k = firstRowWith(c => pathsIn(c[COPIES]).length > 0)
  assert.ok(k >= 0, '地圖裡應該至少有一列誠實列出還沒收斂的副本')
  const brokenCopy = editRow(k, c => { c[COPIES] = breakFirstPath(c[COPIES]); return c })
  assert.ok(colOf(checkMap(brokenCopy), COPIES).length > 0)
  assert.ok(kinds(editRow(k, c => { c[COPIES] = '還有幾份'; return c })).has('copies'))
  assert.ok(!kinds(editRow(k, c => { c[COPIES] = NO_COPY; return c })).has('copies'), '「無」是合法寫法')
  // 少一欄、空格子、看不懂的反引號
  assert.ok(kinds(editRow(1, c => c.slice(0, 4))).has('cols'))
  assert.ok(kinds(editRow(1, c => { c[2] = ''; return c })).has('empty'))
  assert.ok(kinds(editRow(1, c => { c[OUTLET] += '、`這不是 路徑`'; return c })).has('token'))
  assert.ok(kinds(editRow(1, c => { c[OUTLET] = '`../外面/檔.mjs`'; return c })).has('missing'), '往上跳出 repo 的路徑不收')
  // 同一件事寫兩列
  assert.ok(kinds(editRow(1, c => { c[TASK] = map.rows[0].cells[TASK]; return c })).has('dup'))
})

test('還原驗證：整張表不見、表被截短、檔案全部查不到，都會紅', () => {
  assert.deepEqual([...kinds('# 唯一出口\n\n這裡沒有表。\n')], ['table'])
  assert.ok(kinds(`${doc}\n\n| ${HEADER.join(' | ')} |\n|---|---|---|---|---|\n`).has('table'), '同樣表頭的表出現兩張')
  const ls = lines()
  const short = [...ls.slice(0, map.rows[MIN_ROWS - 1].line - 1), ...ls.slice(map.rows[map.rows.length - 1].line)].join('\n')
  assert.ok(kinds(short).has('rows'), `只剩 ${MIN_ROWS - 1} 列要紅`)
  // 查檔函式一律回「不存在」：每一列的出口都要被點名（證明每一列都真的去查了檔案）
  const none = checkMap(doc, () => false)
  const named = new Set(colOf(none.filter(e => e.kind === 'missing'), OUTLET).map(e => e.line))
  assert.equal(named.size, map.rows.length)
})
