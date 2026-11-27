// 退場清單（docs/退場清單.md）的守門測試（開發紀律第二之一節）。
// 由來：10-23 就決定機器橋只維護 Rust 一份，但舊的 Node 版一直留著，11-27 還有新功能抄進去。
// 規則：決定要被取代的舊實作登記進清單之後只能變小——不新增檔案、行數不增加，直到刪除。
// 這支純讀檔：解析清單的三張表，照清單「怎麼數」那一節的數法實際數一次，再跟表一的基準比。
// 檢查核心是純函式（countRetiring、parseDoc、checkRetiring）；下半段是「還原驗證」：把清單故意改壞，確認每一種都會紅。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DOC = 'docs/退場清單.md'
// 登記過的列（退場中＋已退場）不能比這個少：防整張表被清掉、或表格解析壞了卻沒人發現。
// 刪掉程式之後那一列是搬到「已退場」表，不是消失，所以兩張表合起來算。
export const MIN_ROWS = 4

// ---- 數法（跟清單「怎麼數」那一節同一套）----
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__'])
const skipFile = name => /\.test\.|_test\./.test(name) || /\.(md|txt)$/.test(name)

/** 數一個退場中的路徑。回 { files 檔數, lines 換行字元總數, list 算進去的檔（從該路徑起算，用 / 分隔） } */
export function countRetiring(absPath) {
  const list = []
  let lines = 0
  const read = (file, rel, isFile) => {
    list.push(rel)
    if (!isFile) return
    const buf = fs.readFileSync(file)
    if (buf.includes(0)) return   // 二進位檔：算檔數，不算行數
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) lines++
  }
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), r) }
      else if (!skipFile(ent.name)) read(path.join(dir, ent.name), r, ent.isFile())
    }
  }
  if (fs.statSync(absPath).isDirectory()) walk(absPath, '')
  else read(absPath, path.basename(absPath), true)   // 登記的是單一個檔
  return { files: list.length, lines, list: list.sort() }
}

// ---- 讀清單 ----
export const HEADS = {
  retiring: ['路徑', '是什麼', '由誰取代', '負責人', '刪除條件', '基準檔數', '基準行數'],
  log: ['日期', '路徑', '基準怎麼改', '原因', 'PR'],
  retired: ['路徑', '刪除日期', 'PR'],
}
const NONE_YET = '（還沒有）'
const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
/** 一格裡用反引號包起來的字串 */
export const ticks = cell => [...String(cell).matchAll(/`([^`]+)`/g)].map(m => m[1])
const int = s => (/^\d[\d,]*$/.test(s) ? Number(s.replace(/,/g, '')) : NaN)
const blank = s => s.replace(/[\s\-—–]/g, '') === ''
const same = p => p.replace(/\/+$/, '')

/** 把清單的三張表讀出來（靠表頭認表，不靠小節標題）。每列 { line 行號, cells 各欄文字 } */
export function parseDoc(md) {
  const out = { retiring: [], log: [], retired: [] }
  let cur = null
  md.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim().startsWith('|')) { cur = null; return }
    const cells = splitRow(raw)
    const head = Object.keys(HEADS).find(k => HEADS[k].join('|') === cells.join('|'))
    if (head) { cur = head; return }
    if (!cur || cells.every(c => /^:?-+:?$/.test(c))) return
    out[cur].push({ line: i + 1, cells })
  })
  return out
}

// 「基準怎麼改」欄寫「檔數 80」「行數 7984 → 7990」這種樣子；取該項最後一個數字（改完之後的值），沒提到就回 null
const KEYS = { files: '檔數', lines: '行數' }
const numAfter = (text, key) => {
  const at = text.indexOf(key)
  if (at < 0) return null
  let seg = text.slice(at + key.length)
  for (const k of Object.values(KEYS)) { const j = seg.indexOf(k); if (j >= 0) seg = seg.slice(0, j) }
  const nums = seg.match(/\d[\d,]*/g)
  return nums ? Number(nums.at(-1).replace(/,/g, '')) : null
}

/** 檢查整份清單。root 是 repo 根目錄；回 { errors: [{ kind, msg }], rows: 表一各列（存在的會帶 actual 實際數字） } */
export function checkRetiring(md, root, count = countRetiring) {
  const t = parseDoc(md)
  const errors = []
  const bad = (kind, msg) => errors.push({ kind, msg })
  const exists = rel => fs.existsSync(path.join(root, rel))
  const inRepo = rel => !path.isAbsolute(rel) && !/^[\\/]/.test(rel) && !rel.split(/[\\/]/).includes('..')

  // 表一：退場中
  const rows = []
  for (const { line, cells } of t.retiring) {
    if (cells.length !== 7) { bad('row-shape', `表一第 ${line} 行不是七欄（現在 ${cells.length} 欄）：${cells.join(' | ')}`); continue }
    const ps = ticks(cells[0])
    if (ps.length !== 1 || !inRepo(ps[0])) { bad('row-shape', `表一第 ${line} 行的「路徑」欄要剛好一個反引號路徑，從 repo 根目錄起算：${cells[0]}`); continue }
    rows.push({ line, path: ps[0], by: cells[2], owner: cells[3], cond: cells[4], baseFiles: int(cells[5]), baseLines: int(cells[6]) })
  }
  for (const r of rows) if (rows.some(o => o !== r && o.line < r.line && same(o.path) === same(r.path))) bad('dup', `表一重複登記：\`${r.path}\`（第 ${r.line} 行）`)

  // 表三：已退場（刪掉之後搬過來的）
  const retired = []
  for (const { line, cells } of t.retired) {
    if (cells[0] === NONE_YET) continue
    const ps = ticks(cells[0])
    if (cells.length !== 3 || ps.length !== 1 || blank(cells[1])) { bad('retired-shape', `「已退場」表第 ${line} 行要三欄：反引號路徑、刪除日期、PR：${cells.join(' | ')}`); continue }
    retired.push(ps[0])
    if (exists(ps[0])) bad('retired-exists', `\`${ps[0]}\` 寫在「已退場」表，但它還在：還沒刪就留在「退場中」表（搬到「已退場」不能用來躲開基準）`)
    if (rows.some(r => same(r.path) === same(ps[0]))) bad('retired-dup', `\`${ps[0]}\` 同時寫在「退場中」和「已退場」兩張表，只能留一邊`)
  }
  if (rows.length + retired.length < MIN_ROWS) bad('row-count', `「退場中」${rows.length} 列＋「已退場」${retired.length} 列，合起來少於 ${MIN_ROWS} 列：登記過的列不能直接拿掉，程式刪掉之後是把那一列搬到「已退場」表（表頭被改掉也會讀不到列）`)

  // 表二：基準調整紀錄
  if (t.log.length === 0) bad('log-empty', '「基準調整紀錄」一列都沒有：至少要有建立基準那一筆')
  for (const { line, cells } of t.log) {
    if (cells.length !== 5 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0]) || ticks(cells[1]).length !== 1 || blank(cells[2]) || blank(cells[3])) {
      bad('log-shape', `「基準調整紀錄」第 ${line} 行要五欄：日期（年-月-日）、一個反引號路徑、基準怎麼改、原因、PR，前四欄不能空：${cells.join(' | ')}`)
    }
  }
  // 某個路徑最後一筆紀錄寫的數字（紀錄由上往下，新的加在最下面）
  const lastLogged = (p, key) => t.log.filter(l => same(ticks(l.cells[1] ?? '')[0] ?? '') === same(p)).map(l => numAfter(l.cells[2] ?? '', key)).filter(n => n !== null).at(-1)

  for (const r of rows) {
    const p = `\`${r.path}\``
    if (blank(r.owner)) bad('owner-empty', `${p} 沒寫負責人：退場要有人負責到刪掉為止`)
    if (blank(r.cond)) bad('cond-empty', `${p} 沒寫刪除條件：什麼情況下可以刪，用白話寫`)
    const by = ticks(r.by)
    if (by.length === 0) bad('by-none', `${p} 的「由誰取代」欄至少要有一個反引號路徑（從 repo 根目錄起算），指到取代它的程式`)
    for (const b of by) if (!inRepo(b) || !exists(b)) bad('by-missing', `${p} 的「由誰取代」寫了 \`${b}\`，但找不到這個路徑（這一欄的反引號只放路徑；取代者搬家或改名了就一起改）`)
    if (!Number.isInteger(r.baseFiles) || !Number.isInteger(r.baseLines)) { bad('base-bad', `${p} 的基準檔數、基準行數要填整數`); continue }

    for (const [key, base] of [['files', r.baseFiles], ['lines', r.baseLines]]) {
      const last = lastLogged(r.path, KEYS[key])
      if (last === undefined) bad('log-missing', `「基準調整紀錄」裡找不到 ${p} 的${KEYS[key]}：登記時要有一列建立基準（寫成「${KEYS.files} 12、${KEYS.lines} 345」這種樣子）`)
      else if (base !== last) bad('log-mismatch', `${p} 的基準${KEYS[key]}是 ${base}，「基準調整紀錄」最後一筆寫的卻是 ${last}：改基準（調高或調低）要在同一張 PR 到「基準調整紀錄」最下面加一列，「基準怎麼改」寫成「${KEYS[key]} ${last} → ${base}」，並寫原因`)
    }

    if (!exists(r.path)) { bad('path-missing', `${p} 不存在：已經刪掉的話，把這一列從「退場中」搬到「已退場」表（寫刪除日期和 PR）；只是搬家或改名，就把路徑改對`); continue }
    const a = r.actual = count(path.join(root, r.path))
    const fix = `這個路徑已登記退場，只修不加：\n    新功能請做在取代它的那一邊（${r.by}）；\n    真的是修正才多出來的，在同一張 PR 把 ${DOC} 表一的基準調高，並在「基準調整紀錄」加一列寫原因。`
    if (a.files > r.baseFiles) bad('files-over', `${p} 的檔數超過基準：基準 ${r.baseFiles} 個、實際 ${a.files} 個（多 ${a.files - r.baseFiles} 個）。${fix}\n    目前數到的 ${a.files} 個檔（測試、.md、.txt、node_modules 不算；本機若有沒進版控的檔也會被數到）：\n      ${a.list.join('\n      ')}`)
    if (a.lines > r.baseLines) bad('lines-over', `${p} 的行數超過基準：基準 ${r.baseLines} 行、實際 ${a.lines} 行（多 ${a.lines - r.baseLines} 行）。${fix}`)
  }
  return { errors, rows }
}

const fmt = errs => errs.map(e => `・${e.msg}`).join('\n')

// ---- 真的清單、真的資料夾 ----
const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8')
const cache = new Map()
const count = abs => cache.get(abs) ?? cache.set(abs, countRetiring(abs)).get(abs)   // 還原驗證會重複檢查很多次，每個路徑只數一次
const real = checkRetiring(doc, ROOT, count)
const kinds = text => new Set(checkRetiring(text, ROOT, count).errors.map(e => e.kind))
// 某一種錯裡、講某個路徑的那幾筆（訊息都以反引號路徑開頭）。還原驗證用：只看被改壞的那一列，別的列本來就有錯時不跟著紅
const hits = (text, kind, about) => checkRetiring(text, ROOT, count).errors.filter(e => e.kind === kind && e.msg.startsWith(about))
const clean = (...ks) => { const hit = real.errors.filter(e => ks.includes(e.kind)); if (hit.length) assert.fail(`\n${fmt(hit)}`) }

test(`退場清單：登記的列（退場中＋已退場）至少 ${MIN_ROWS} 列，每列七欄，路徑不重複`, () => {
  clean('row-count', 'row-shape', 'dup')
})

test('退場清單：每一列的路徑都還在（已經刪掉的要搬到「已退場」表）', () => {
  clean('path-missing')
})

test('退場清單：每一列都寫了由誰取代，而且取代者真的存在', () => {
  clean('by-none', 'by-missing')
})

test('退場清單：每一列都有負責人和刪除條件', () => {
  clean('owner-empty', 'cond-empty')
})

test('退場清單棘輪：每一列的檔數、行數都不超過基準（只修不加）', t => {
  for (const r of real.rows.filter(x => x.actual)) {
    const slack = r.actual.files < r.baseFiles || r.actual.lines < r.baseLines ? '。已經變少了，可以把基準調低（表一改數字，「基準調整紀錄」加一列）' : ''
    t.diagnostic(`${r.path}：實際 ${r.actual.files} 個檔、${r.actual.lines} 行（基準 ${r.baseFiles} 個檔、${r.baseLines} 行）${slack}`)
  }
  clean('base-bad', 'files-over', 'lines-over')
})

test('退場清單：基準調整紀錄至少有建立基準那一筆；表一的基準跟每個路徑最後一筆紀錄一致', () => {
  clean('log-empty', 'log-shape', 'log-missing', 'log-mismatch')
})

test('退場清單：「已退場」表上的路徑真的刪掉了，而且不再列在「退場中」', () => {
  clean('retired-shape', 'retired-exists', 'retired-dup')
})

// ---- 數法本身：用暫存資料夾驗 ----
test('數法：測試、Markdown、純文字說明、node_modules 不算，其他都算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-retiring-'))
  const put = (rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body) }
  try {
    put('a.mjs', '1\n2\n3\n')                      // 算：3 行
    put('sub/b.ps1', 'x\r\ny')                     // 算：1 行（最後一行沒有換行字元就不算）
    put('sub/deep/c.json', '{}\n')                 // 算：1 行
    put('.gitignore', 'node_modules\n')            // 算：1 行（點開頭的檔也算）
    put('latest.json', '{}\n')                     // 算：1 行（檔名只是剛好有 test 這幾個字）
    put('testing/d.mjs', 'x\n')                    // 算：1 行（資料夾名不是剛好 test）
    put('bin.dat', Buffer.from([1, 0, 10, 10]))    // 二進位檔：算檔數，不算行數
    put('README.md', '# 說明\n\n')                 // 以下都不算
    put('安裝說明.txt', '說明\n')
    put('test/a.test.mjs', 'x\n')
    put('test/fake-helper.mjs', 'x\n')             // test 資料夾裡的輔助檔也不算
    put('sub/tests/x.mjs', 'x\n')
    put('sub/__tests__/x.mjs', 'x\n')
    put('b.test.mjs', 'x\n')
    put('sub/c_test.go', 'x\n')
    put('node_modules/pkg/index.js', 'x\n')
    put('sub/node_modules/pkg/index.js', 'x\n')
    assert.deepEqual(countRetiring(dir), { files: 7, lines: 8, list: ['.gitignore', 'a.mjs', 'bin.dat', 'latest.json', 'sub/b.ps1', 'sub/deep/c.json', 'testing/d.mjs'] })
    // 多一個檔、多一行都數得出來；多的是測試或文件就不變
    put('sub/new.mjs', 'x\n')
    put('test/new.test.mjs', 'x\n')
    put('NOTES.md', 'x\n')
    const more = countRetiring(dir)
    assert.deepEqual([more.files, more.lines], [8, 9])
    // 登記的是單一個檔也數得出來
    assert.deepEqual(countRetiring(path.join(dir, 'a.mjs')), { files: 1, lines: 3, list: ['a.mjs'] })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 還原驗證：把清單故意改壞，每一種都要紅 ----
const COL = Object.fromEntries(HEADS.retiring.map((h, i) => [h, i]))
const rowOf = (text, p) => parseDoc(text).retiring.find(r => ticks(r.cells[0])[0] === p) ?? assert.fail(`表一找不到 ${p}`)
const withLines = (text, fn) => { const lines = text.split('\n'); fn(lines); return lines.join('\n') }
const toRow = cells => `| ${cells.join(' | ')} |`
// 換掉表一某一列的某一欄
const setCell = (text, p, col, value) => {
  const row = rowOf(text, p)
  return withLines(text, lines => { lines[row.line - 1] = toRow(row.cells.map((c, i) => (i === COL[col] ? String(value) : c))) })
}
// 某張表的表頭在第幾行（從 0 起算）
const headAt = (lines, table) => {
  const at = lines.findIndex(l => l.trim().startsWith('|') && splitRow(l).join('|') === HEADS[table].join('|'))
  assert.ok(at >= 0, `找不到表頭：${HEADS[table].join(' | ')}`)
  return at
}
// 在某張表的表頭與分隔線後面插一列
const addRow = (text, table, cells) => withLines(text, lines => { lines.splice(headAt(lines, table) + 2, 0, toRow(cells)) })
// 拿表一第一個數得到的列來改；清單本身壞到沒有任何一列數得到時，還原驗證各自報錯，不讓整支檔在載入時就倒
const R = real.rows.find(r => r.actual)
const mut = (name, fn) => test(name, () => { assert.ok(R, '表一沒有任何一列數得到（先修好上面幾項），還原驗證做不了'); fn() })

mut('還原驗證：基準行數比實際少 1 → 紅；剛好等於實際 → 不紅；訊息寫明路徑、數字和該怎麼辦', () => {
  const low = hits(setCell(doc, R.path, '基準行數', R.actual.lines - 1), 'lines-over', `\`${R.path}\``)
  assert.equal(low.length, 1)
  for (const s of [`\`${R.path}\``, `基準 ${R.actual.lines - 1} 行`, `實際 ${R.actual.lines} 行`, '多 1 行', '取代它的那一邊', '基準調整紀錄']) assert.ok(low[0].msg.includes(s), `訊息裡要有「${s}」：\n${low[0].msg}`)
  assert.equal(hits(setCell(doc, R.path, '基準行數', R.actual.lines), 'lines-over', `\`${R.path}\``).length, 0)
})

mut('還原驗證：基準檔數比實際少 1 → 紅，訊息列出目前數到的檔；剛好等於實際 → 不紅', () => {
  const low = hits(setCell(doc, R.path, '基準檔數', R.actual.files - 1), 'files-over', `\`${R.path}\``)
  assert.equal(low.length, 1)
  for (const s of [`\`${R.path}\``, `基準 ${R.actual.files - 1} 個`, `實際 ${R.actual.files} 個`, `目前數到的 ${R.actual.files} 個檔`, R.actual.list[0], '基準調整紀錄']) assert.ok(low[0].msg.includes(s), `訊息裡要有「${s}」：\n${low[0].msg}`)
  assert.equal(hits(setCell(doc, R.path, '基準檔數', R.actual.files), 'files-over', `\`${R.path}\``).length, 0)
})

mut('還原驗證：路徑改成不存在的 → 紅，訊息提示搬到「已退場」表', () => {
  const gone = hits(setCell(doc, R.path, '路徑', '`relay/沒有這個資料夾/`'), 'path-missing', '`relay/沒有這個資料夾/`')
  assert.equal(gone.length, 1)
  assert.ok(gone[0].msg.includes('搬到「已退場」表'), gone[0].msg)
})

mut('還原驗證：由誰取代沒有反引號路徑、或路徑不存在 → 紅', () => {
  assert.ok(kinds(setCell(doc, R.path, '由誰取代', '新的那一份')).has('by-none'))
  assert.ok(kinds(setCell(doc, R.path, '由誰取代', '`relay/asn/沒有這個檔.rs`')).has('by-missing'))
  assert.ok(kinds(setCell(doc, R.path, '由誰取代', '`relay/asn/` 和 `relay/asn/沒有這個檔.rs`')).has('by-missing'), '寫了好幾個，其中一個不存在也要紅')
})

mut('還原驗證：負責人、刪除條件清空（或只填一條橫線）→ 紅', () => {
  assert.ok(kinds(setCell(doc, R.path, '負責人', '')).has('owner-empty'))
  assert.ok(kinds(setCell(doc, R.path, '負責人', '—')).has('owner-empty'))
  assert.ok(kinds(setCell(doc, R.path, '刪除條件', '')).has('cond-empty'))
})

mut('還原驗證：表格結構——少一欄、重複登記、路徑沒用反引號、基準不是數字、整張表被清掉 → 紅', () => {
  const row = rowOf(doc, R.path)
  assert.ok(kinds(withLines(doc, lines => { lines[row.line - 1] = toRow(row.cells.slice(0, 6)) })).has('row-shape'))
  assert.ok(kinds(addRow(doc, 'retiring', row.cells)).has('dup'))
  assert.ok(kinds(setCell(doc, R.path, '路徑', R.path)).has('row-shape'))
  assert.ok(kinds(setCell(doc, R.path, '路徑', '`../別的地方/`')).has('row-shape'))
  assert.ok(kinds(setCell(doc, R.path, '基準行數', '很多')).has('base-bad'))
  const allRows = new Set(parseDoc(doc).retiring.map(r => r.line - 1))
  assert.ok(kinds(doc.split('\n').filter((_, i) => !allRows.has(i)).join('\n')).has('row-count'))
  const badHead = withLines(doc, lines => { lines[headAt(lines, 'retiring')] = toRow(['路徑', '說明', ...HEADS.retiring.slice(2)]) })
  assert.ok(kinds(badHead).has('row-count'), '表頭被改掉、讀不到任何一列也要紅（不能變成沒有東西可檢查而通過）')
})

mut('還原驗證：改了基準（調高、調低）卻沒在「基準調整紀錄」加一列 → 紅；補了一列 → 不紅；紀錄整個拿掉 → 紅', () => {
  const up = setCell(doc, R.path, '基準行數', R.baseLines + 14)
  assert.ok(kinds(up).has('log-mismatch'))
  const logged = text => withLines(text, lines => { lines.splice(parseDoc(text).log.at(-1).line, 0, toRow(['2026-12-01', `\`${R.path}\``, `行數 ${R.baseLines} → ${R.baseLines + 14}`, '修正需要', '#1'])) })
  assert.equal(kinds(logged(up)).has('log-mismatch'), false)
  assert.ok(kinds(logged(doc)).has('log-mismatch'), '紀錄寫了調高、表一卻沒改，也對不上')
  assert.ok(kinds(setCell(doc, R.path, '基準檔數', R.baseFiles + 1)).has('log-mismatch'))
  assert.ok(kinds(setCell(doc, R.path, '基準行數', R.baseLines - 1)).has('log-mismatch'))
  const logLines = new Set(parseDoc(doc).log.map(r => r.line - 1))
  const noLog = kinds(doc.split('\n').filter((_, i) => !logLines.has(i)).join('\n'))
  assert.ok(noLog.has('log-empty') && noLog.has('log-missing'))
  assert.ok(kinds(logged(doc).replace('| 2026-12-01 |', '| 十二月一日 |')).has('log-shape'))
})

mut('還原驗證：把還在的路徑寫進「已退場」表（想躲開基準）→ 紅；真的不存在的路徑 → 不紅', () => {
  const k = kinds(addRow(doc, 'retired', [`\`${R.path}\``, '2026-12-01', '#1']))
  assert.ok(k.has('retired-exists') && k.has('retired-dup'))
  const ok = kinds(addRow(doc, 'retired', ['`relay/沒有這個資料夾/`', '2026-12-01', '#1']))
  assert.equal(ok.has('retired-exists') || ok.has('retired-shape'), false)
  assert.ok(kinds(addRow(doc, 'retired', ['relay/沒有這個資料夾/', '', ''])).has('retired-shape'))
})

test('還原驗證：讀表工具本身——靠表頭認三張表、分隔線和別的表不算、「（還沒有）」不當成一列路徑', () => {
  const md = [
    toRow(HEADS.retiring), '|---|---|---|---|---|---|---|', '| `a/` | 舊的 | `b/` | 領隊 | 換完之後 | 1 | 2 |', '',
    '| 別的表 | 路徑 |', '|---|---|', '| x | `c/` |', '',
    toRow(HEADS.log), '|---|---|---|---|---|', '| 2026-11-27 | `a/` | 建立基準：檔數 1、行數 2 | 第一次登記 | #1 |', '',
    toRow(HEADS.retired), '|---|---|---|', `| ${NONE_YET} | | |`,
  ].join('\n')
  const t = parseDoc(md)
  assert.deepEqual([t.retiring.length, t.log.length, t.retired.length], [1, 1, 1])
  assert.deepEqual(t.retiring[0].cells, ['`a/`', '舊的', '`b/`', '領隊', '換完之後', '1', '2'])
  assert.equal(t.retiring[0].line, 3)
  assert.deepEqual(ticks('用 `a/b.rs` 和 `c/`，不是這個'), ['a/b.rs', 'c/'])
  assert.equal(numAfter('建立基準：檔數 1,234、行數 56', '檔數'), 1234)
  assert.equal(numAfter('行數 23456 → 23470（檔數不變）', '行數'), 23470)
  assert.equal(numAfter('行數 23456 → 23470（檔數不變）', '檔數'), null)
})
