// 通知種類登記表（docs/通知種類.md）的守門測試。
// 由來：系統通知的種類散在後台、前端分類表、設計文件三處，各寫各的、對不上；收發室訊息的前綴有六種寫法混用。
// 規則改成「種類只認登記表一份」，這支測試負責擋：
//  1. 後台（supabase/migrations/*.sql）寄出的每一種通知，都登記在表一，狀態是「使用中」。
//  2. 表一寫「使用中」的，後台真的有在寄。
//  3. 表一每一列的分類，等於前端 noticeCategory 實際分到的結果。
//  4. 前端分類表（notice.mjs 的 TOPIC_CAT）列出的每個鍵，都在表一。
//  5. 前綴棘輪：五種舊前綴的實際次數不能超過表二登記的數字。
//  6. 表格格式：種類代碼的寫法、不重複，分類與狀態的值在允許的清單內。
// 標準答案一律從程式來源直接取得（讀檔或匯入），不在測試裡手抄一份種類清單。純讀檔，不連網路。
// 每一項檢查都是「回傳錯誤清單」的純函式；本檔最後一段是還原驗證：把登記表故意改壞，確認每一種都會報錯。
// 跑法：在 relay/asn 底下 node --test test/notice-topics-registry.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOTICE_CATS, NOTICE_CAT_ALL, noticeCategory } from '../ui/lib/notice.mjs'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const DOC = 'docs/通知種類.md'
const MIGRATIONS = 'supabase/migrations'
const NOTICE_SRC = 'relay/asn/ui/lib/notice.mjs'
const BRIDGE = 'relay/asn/src-tauri/src/bridge'
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
const fail = errs => `\n${errs.join('\n')}`

// ---------- 登記表的格式 ----------
const TOPIC_HEAD = ['種類代碼', '分類', '誰寄出', '什麼時候寄（一句白話）', '狀態']
const PREFIX_HEAD = ['前綴寫法', '目前次數', '規則']
const CODE_RE = /^[a-z_]{1,30}$/   // 和資料庫的檢查式同一個規則
const CAT_ZH = { stuck: '卡住', login: '登入', quota: '額度', security: '安全', other: '其他' }
const CATS = Object.values(CAT_ZH)
const USED = '使用中', OLD = '舊名'
const STATUSES = [USED, OLD]
const RULE_NEW = '新訊息一律用這個', RULE_OLD = '舊寫法，只能減少，不准新增'

const cellsOf = line => { const t = line.trim(); return t.length > 1 && t.startsWith('|') && t.endsWith('|') ? t.slice(1, -1).split('|').map(s => s.trim()) : null }
const unquote = s => (/^`[^`]+`$/.test(s ?? '') ? s.slice(1, -1) : null)   // 反引號包住的內容；沒包＝null
// 取出表頭逐字等於 head 的那張表的資料列（表頭下一行是分隔線，再往下到第一個不是表格的行為止）
function tableOf(md, head) {
  const lines = md.split('\n')
  const at = lines.findIndex(l => cellsOf(l)?.join('|') === head.join('|'))
  if (at < 0) return null
  const rows = []
  for (let i = at + 2; i < lines.length && cellsOf(lines[i]); i++) rows.push({ cells: cellsOf(lines[i]), line: i + 1 })
  return rows
}
const topicRows = md => tableOf(md, TOPIC_HEAD)?.map(({ cells: c, line }) => ({ code: unquote(c[0]), raw: c[0], cat: c[1], sender: c[2], when: c[3], status: c[4], n: c.length, line }))
const prefixRows = md => tableOf(md, PREFIX_HEAD)?.map(({ cells: c, line }) => ({ form: unquote(c[0]), raw: c[0], count: c[1], rule: c[2], n: c.length, line }))
const noTable = head => [`${DOC} 找不到表頭逐字是「| ${head.join(' | ')} |」的表`]

// ---------- 後台寄出的種類：從 supabase/migrations/*.sql 取 ----------
// 資料庫異動檔是歷史紀錄，舊檔不會改，所以取的是「所有檔案加起來」。三種寫法各自怎麼抓：
//  寫法一（字面值）：public.asn_relay_send_notice(p_node, 'login', …) → 第二個參數是單引號字串，就是種類。
//  寫法二（case 對應）：第二個參數是 case … end → 只取 then／else 後面的字面值；
//    when 後面拿來比對的值不取（例如 forward_stuck_manual 是呼叫端傳進來的參數值，不是種類）。
//  寫法三（'notice:x' 常數）：完整的單引號字串 'notice:<種類>'，例如 v_kind constant text := 'notice:bridge'。
//    查詢條件、網頁不收的清單裡同樣的字面值也一併抓（寧可多抓）。
// 看不懂的寫法（第二個參數是變數、'notice:' 後面接了別的變數…）不略過，直接報錯，逼人回來更新這裡的取法。
// 多抓到、其實沒在寄的，在 NOT_SENT 明確排除並寫原因（表一那一列要刪掉或改成「舊名」）。
const NOT_SENT = new Map([
  // ['種類代碼', '為什麼不算後台在寄'],
])
const FORMS = ['字面值', 'case 對應', "'notice:x' 常數"]
const stripSqlComments = src => src.replace(/^[ \t]*--.*$/gm, '')   // 只拿掉整行註解，行數不變；行尾註解不動（寧可多抓）
const lineOf = (src, i) => src.slice(0, i).split('\n').length
const sqlLiteral = s => /^'([^']*)'$/.exec(s)?.[1] ?? null

// 從左括號後面開始，讀出第 n 個參數（0 起算）：看得懂單引號字串（兩個單引號是跳脫）與巢狀括號；讀不到回 null
function argAt(src, from, n) {
  let depth = 0, cur = '', k = 0
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === "'") {
      let j = i + 1
      while (j < src.length && !(src[j] === "'" && src[j + 1] !== "'")) j += src[j] === "'" ? 2 : 1
      cur += src.slice(i, j + 1)
      i = j
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && depth > 0) depth--
    else if ((c === ',' || c === ')') && depth === 0) {
      if (k === n) return cur.trim()
      if (c === ')') return null
      k++
      cur = ''
      continue
    }
    cur += c
  }
  return null
}

// 掃一個檔：found＝抓到的種類（哪一種寫法、在哪裡），unknown＝看不懂的寫法
function scanSql(rel, raw) {
  const src = stripSqlComments(raw), found = [], unknown = []
  const at = i => `${rel} 第 ${lineOf(src, i)} 行`
  const hit = (kind, form, i) => found.push({ kind, form, where: at(i) })
  const odd = (i, why) => unknown.push(`${at(i)}：${why}。原文：${src.slice(i, i + 160).split('\n')[0]}`)
  for (const m of src.matchAll(/\basn_relay_send_notice\s*\(/g)) {
    // 前面是 function 的是定義、授權或刪除（create function …(p_node text, …)、revoke … on function …(text, …)），不是呼叫
    if (/\bfunction\s+(?:if\s+(?:not\s+)?exists\s+)?(?:[a-z_]+\.)?$/i.test(src.slice(Math.max(0, m.index - 60), m.index))) continue
    const arg = argAt(src, m.index + m[0].length, 1)
    if (arg === null) { odd(m.index, '讀不到第二個參數'); continue }
    if (sqlLiteral(arg) !== null) { hit(sqlLiteral(arg), FORMS[0], m.index); continue }
    if (!/^case\b[\s\S]*\bend$/i.test(arg)) { odd(m.index, '種類不是字面值，也不是 case 對應'); continue }
    const outs = [...arg.matchAll(/\b(?:then|else)\s+(\S+)/gi)].map(x => x[1])
    if (!outs.length) odd(m.index, 'case 對應裡沒有任何結果')
    for (const o of outs) {
      if (sqlLiteral(o) !== null) hit(sqlLiteral(o), FORMS[1], m.index)
      else odd(m.index, 'case 對應的結果不是字面值')
    }
  }
  for (const m of src.matchAll(/'notice:([^']*)'/g)) {
    const k = m[1]
    if (CODE_RE.test(k)) { hit(k, FORMS[2], m.index); continue }
    if (k === '%') continue   // like 'notice:%'：問的是「是不是通知」，不是某一種
    // 'notice:' || 變數：共用寄送函式自己組類別（種類來自呼叫端，已由寫法一、二抓到）與鎖的名字（接節點代號）是認得的，其他都報錯
    const next = /^\s*\|\|\s*([A-Za-z_.]+)/.exec(src.slice(m.index + m[0].length))?.[1]
    if (k === '' && (next === 'p_topic' || next === 'p_node')) continue
    odd(m.index, k === '' ? "'notice:' 後面接的東西認不得" : '種類不合格式')
  }
  return { found, unknown }
}

function scanMigrations() {
  const files = fs.readdirSync(path.join(REPO, MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()
  const found = [], unknown = []
  for (const f of files) {
    const r = scanSql(`${MIGRATIONS}/${f}`, read(`${MIGRATIONS}/${f}`))
    found.push(...r.found)
    unknown.push(...r.unknown)
  }
  const sent = new Map()   // 種類 → 出現的位置（排除 NOT_SENT 之後）
  for (const h of found) if (!NOT_SENT.has(h.kind)) sent.set(h.kind, [...(sent.get(h.kind) ?? []), h.where])
  return { files, found, unknown, sent }
}

// ---------- 前端分類表的鍵：解析 notice.mjs 原始碼裡 TOPIC_CAT 的物件字面值（它沒有匯出） ----------
// 回傳 [鍵, 值] 的清單；找不到物件、或裡面有看不懂的寫法（展開、計算鍵…）回 null
function topicCatEntries(src) {
  const at = src.search(/\bconst\s+TOPIC_CAT\s*=\s*\{/)
  if (at < 0) return null
  const rest = src.slice(src.indexOf('{', at) + 1).replace(/\/\/.*$/gm, '')   // 註解先拿掉
  const end = rest.indexOf('}')
  if (end < 0) return null
  const entry = /([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*(?:'([^']*)'|"([^"]*)")/g
  const body = rest.slice(0, end)
  if (body.replace(entry, '').replace(/[\s,]/g, '') !== '') return null
  return [...body.matchAll(entry)].map(m => [m[1].replace(/^['"]|['"]$/g, ''), m[2] ?? m[3]])
}

// ---------- 前綴：六種寫法與數法 ----------
// 一律把寫法當成完整字串，數它在檔案全文出現幾次（註解與檔內的測試區塊也算）。
//  - 「（收發室）」「（收發室提醒）」「（收發室更正）」「（收發室：」在「室」後面的字各不相同，完整字串互不包含，不會重複算。
//  - 「收發室：」是「（收發室：」的後段，所以要扣掉前面緊接著「（」的那些。
//  - 「[收發室]」就是這五個字元逐字比對（用字串切，不用正規式，方括號不會被當成字元集合）。
const times = (text, s) => text.split(s).length - 1
const PREFIXES = [
  { form: '（收發室）', rule: RULE_NEW, count: t => times(t, '（收發室）') },   // 新訊息用這個，不設上限
  { form: '[收發室]', rule: RULE_OLD, count: t => times(t, '[收發室]') },
  { form: '（收發室提醒）', rule: RULE_OLD, count: t => times(t, '（收發室提醒）') },
  { form: '（收發室更正）', rule: RULE_OLD, count: t => times(t, '（收發室更正）') },
  { form: '（收發室：', rule: RULE_OLD, count: t => times(t, '（收發室：') },
  { form: '收發室：', rule: RULE_OLD, count: t => times(t, '收發室：') - times(t, '（收發室：') },
]
const GOOD_PREFIX = PREFIXES[0].form
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
// 測試檔不算（rel 是從版本庫根目錄起算、用正斜線的路徑）
const isRustTest = rel => {
  const base = rel.split('/').pop()
  return rel.includes('/tests/') || base === 'tests.rs' || base.endsWith('_tests.rs') || base.startsWith('tests_')
}
// 各寫法的實際次數：form → { n, files: ['core.rs（6）', …] }
function countPrefixes(texts) {
  const counts = new Map(PREFIXES.map(p => [p.form, { n: 0, files: [] }]))
  for (const [name, text] of texts) {
    for (const p of PREFIXES) {
      const n = p.count(text)
      if (n > 0) { counts.get(p.form).n += n; counts.get(p.form).files.push(`${name}（${n}）`) }
    }
  }
  return counts
}
function bridgePrefixes() {
  const files = walk(path.join(REPO, BRIDGE)).map(f => path.relative(REPO, f).split(path.sep).join('/')).filter(f => f.endsWith('.rs') && !isRustTest(f)).sort()
  return { files, counts: countPrefixes(files.map(f => [f.slice(BRIDGE.length + 1), read(f)])) }
}

// ---------- 六項檢查（純函式，回傳錯誤清單） ----------
const coded = rows => (rows ?? []).filter(r => r.code !== null && r.n === TOPIC_HEAD.length)

// 第 1 項：後台寄出的每一種都登記在表一，狀態是「使用中」
function checkSentRegistered(rows, sent) {
  const by = new Map(coded(rows).map(r => [r.code, r]))
  const errs = []
  for (const [kind, where] of sent) {
    const r = by.get(kind)
    if (!r) errs.push(`後台有寄 ${kind}（${where[0]}），但 ${DOC} 表一沒有登記。請在表一加一列：種類代碼、分類、誰寄出、什麼時候寄，狀態寫「${USED}」`)
    else if (r.status !== USED) errs.push(`後台有寄 ${kind}（${where[0]}），但 ${DOC} 第 ${r.line} 行的狀態是「${r.status}」，要改成「${USED}」`)
  }
  return errs
}

// 第 2 項：表一寫「使用中」的，後台真的有在寄
const checkUsedIsSent = (rows, sent) => coded(rows).filter(r => r.status === USED && !sent.has(r.code))
  .map(r => `${DOC} 第 ${r.line} 行的 ${r.code} 寫「${USED}」，但 ${MIGRATIONS} 裡找不到後台寄它的地方。已經不寄了就刪掉這一列；前端分類表還留著它，就把狀態改成「${OLD}」`)

// 第 3 項：表一每一列的分類，等於前端實際分到的結果
const checkCategories = (rows, catOf = noticeCategory) => coded(rows).flatMap(r => {
  const real = CAT_ZH[catOf('notice:' + r.code)]
  return real === r.cat ? [] : [`${DOC} 第 ${r.line} 行：${r.code} 登記的分類是「${r.cat}」，但前端實際分到「${real}」。表一要照程式現在的結果填；要改分類，表一和前端分類表（${NOTICE_SRC} 的 TOPIC_CAT）同一張 PR 一起改`]
})

// 第 4 項：前端分類表列出的每個鍵都在表一
function checkFrontKeys(rows, entries) {
  if (!entries) return [`${NOTICE_SRC} 裡找不到 TOPIC_CAT 的物件字面值，或裡面有這支測試看不懂的寫法。請更新測試的解析`]
  const have = new Set(coded(rows).map(r => r.code))
  return entries.filter(([k]) => !have.has(k)).map(([k]) => `前端分類表（${NOTICE_SRC} 的 TOPIC_CAT）有 ${k}，但 ${DOC} 表一沒有這一列。後台有寄就登記成「${USED}」，沒在寄就登記成「${OLD}」`)
}

// 第 5 項：前綴棘輪。表二要有六種寫法各一列；舊寫法的實際次數不能超過登記的數字
function checkPrefixes(rows, counts) {
  if (!rows) return noTable(PREFIX_HEAD)
  const errs = []
  for (const r of rows) {
    if (r.n !== PREFIX_HEAD.length) errs.push(`${DOC} 第 ${r.line} 行：這一列有 ${r.n} 欄，應該是 ${PREFIX_HEAD.length} 欄`)
    else if (!PREFIXES.some(p => p.form === r.form)) errs.push(`${DOC} 第 ${r.line} 行：前綴寫法「${r.raw}」不在六種寫法裡（要用反引號包住）`)
  }
  for (const p of PREFIXES) {
    const mine = rows.filter(r => r.form === p.form && r.n === PREFIX_HEAD.length)
    if (mine.length !== 1) { errs.push(`${DOC} 表二：前綴「${p.form}」要剛好登記一列，現在有 ${mine.length} 列`); continue }
    const r = mine[0]
    if (!/^\d+$/.test(r.count)) { errs.push(`${DOC} 第 ${r.line} 行：前綴「${p.form}」的目前次數「${r.count}」不是數字`); continue }
    if (r.rule !== p.rule) errs.push(`${DOC} 第 ${r.line} 行：前綴「${p.form}」的規則欄要寫「${p.rule}」`)
    const now = counts.get(p.form)
    if (p.rule === RULE_OLD && now.n > Number(r.count)) {
      errs.push(`前綴「${p.form}」登記 ${r.count} 次，實際 ${now.n} 次，多了 ${now.n - Number(r.count)} 次。舊寫法只能減少、不准新增：新訊息請改用「${GOOD_PREFIX}」。目前出現在：${now.files.join('、')}`)
    }
  }
  return errs
}

// 第 6 項：表一的格式
function checkTopicFormat(rows) {
  if (!rows) return noTable(TOPIC_HEAD)
  const errs = rows.length ? [] : [`${DOC} 表一是空的`]
  const seen = new Set()
  for (const r of rows) {
    const at = `${DOC} 第 ${r.line} 行`
    if (r.n !== TOPIC_HEAD.length) { errs.push(`${at}：這一列有 ${r.n} 欄，應該是 ${TOPIC_HEAD.length} 欄`); continue }
    if (r.code === null || !CODE_RE.test(r.code)) errs.push(`${at}：種類代碼「${r.raw}」不合規定。要用反引號包住，只用小寫英文與底線，1 到 30 個字`)
    else if (seen.has(r.code)) errs.push(`${at}：種類代碼 ${r.code} 重複登記`)
    seen.add(r.code)
    if (!CATS.includes(r.cat)) errs.push(`${at}：分類「${r.cat}」不在允許的清單裡（${CATS.join('、')}）`)
    if (!STATUSES.includes(r.status)) errs.push(`${at}：狀態「${r.status}」不在允許的清單裡（${STATUSES.join('、')}）`)
    if (!r.sender || !r.when) errs.push(`${at}：「誰寄出」和「什麼時候寄」不能空白`)
  }
  return errs
}

// ---------- 實際資料 ----------
const doc = read(DOC)
const ROWS = topicRows(doc)
const PROWS = prefixRows(doc)
const SQL = scanMigrations()
const FRONT = topicCatEntries(read(NOTICE_SRC))
const PREFIX = bridgePrefixes()

test('通知種類：取法自我檢查（三種寫法都抓得到、沒有看不懂的寫法、分類名稱和前端一致）', () => {
  assert.ok(SQL.files.length > 0, `${MIGRATIONS} 底下沒有 .sql 檔，資料夾是不是搬了`)
  assert.equal(SQL.unknown.length, 0, `後台寄通知的地方有這支測試看不懂的寫法：請改成字面值或 case 對應，或更新測試的取法${fail(SQL.unknown)}`)
  for (const form of FORMS) {
    assert.ok(SQL.found.some(h => h.form === form), `「${form}」這種寫法一個都沒抓到，多半是後台改了寫法或函式名稱，請更新測試的取法`)
  }
  for (const k of NOT_SENT.keys()) assert.ok(SQL.found.some(h => h.kind === k), `排除清單裡的 ${k} 已經抓不到了，請從 NOT_SENT 拿掉`)
  assert.deepEqual(CAT_ZH, Object.fromEntries(NOTICE_CATS.filter(c => c.key !== NOTICE_CAT_ALL).map(c => [c.key, c.label])),
    `前端的分類（${NOTICE_SRC} 的 NOTICE_CATS）改了：${DOC} 的分類用字和這支測試的 CAT_ZH 要一起改`)
  // 解析出來的前端分類表要和實際行為一致（確認解析沒有抓錯物件）
  assert.ok(FRONT && FRONT.length > 0, `${NOTICE_SRC} 的 TOPIC_CAT 解析不出來`)
  for (const [k, v] of FRONT) assert.equal(noticeCategory('notice:' + k), v, `TOPIC_CAT 解析出 ${k} 歸 ${v}，和 noticeCategory 的實際結果不一樣`)
  assert.ok(PREFIX.files.length > 0, `${BRIDGE} 底下沒有掃到任何 .rs 檔，資料夾是不是搬了`)
  assert.ok([...PREFIX.counts.values()].some(c => c.n > 0), '六種前綴一個都沒數到，請檢查掃描範圍')
})

test('通知種類 1：後台寄出的每一種通知都登記在表一，狀態是「使用中」', () => {
  assert.ok(SQL.sent.size > 0, '後台寄出的種類一個都沒抓到')
  const errs = checkSentRegistered(ROWS, SQL.sent)
  assert.equal(errs.length, 0, fail(errs))
})

test('通知種類 2：表一寫「使用中」的種類，後台真的有在寄', () => {
  const errs = checkUsedIsSent(ROWS, SQL.sent)
  assert.equal(errs.length, 0, fail(errs))
})

test('通知種類 3：表一每一列的分類等於前端實際分到的分類', () => {
  const errs = checkCategories(ROWS)
  assert.equal(errs.length, 0, fail(errs))
})

test('通知種類 4：前端分類表列出的每個種類都在表一', () => {
  const errs = checkFrontKeys(ROWS, FRONT)
  assert.equal(errs.length, 0, fail(errs))
})

test('通知種類 5：前綴棘輪，五種舊寫法的實際次數不超過表二登記的數字', t => {
  const errs = checkPrefixes(PROWS, PREFIX.counts)
  assert.equal(errs.length, 0, fail(errs))
  // 舊寫法變少了不算錯，只提醒把表上的數字改小（不改的話，之後又加回來擋不到）
  for (const p of PREFIXES.filter(x => x.rule === RULE_OLD)) {
    const reg = Number(PROWS.find(r => r.form === p.form).count), now = PREFIX.counts.get(p.form).n
    if (now < reg) t.diagnostic(`前綴「${p.form}」登記 ${reg} 次，實際只剩 ${now} 次：請把 ${DOC} 表二的數字改成 ${now}`)
  }
})

test('通知種類 6：表一格式（種類代碼的寫法、不重複，分類與狀態在允許的清單內）', () => {
  const errs = checkTopicFormat(ROWS)
  assert.equal(errs.length, 0, fail(errs))
})

// ---------- 還原驗證：把登記表或來源故意改壞，確認每一種都會報錯 ----------
// 只看「改壞之後多出來的錯」（fresh），所以登記表本身有錯時，紅的只有上面那幾項，這一段不會跟著亂紅。
const firstUsed = () => ROWS.find(r => r.status === USED && SQL.sent.has(r.code))   // 第一個後台真的有在寄的使用中種類
const READY = Boolean(ROWS && PROWS && FRONT?.length && firstUsed() && PREFIXES.every(p => /^\d+$/.test(PROWS.find(r => r.form === p.form)?.count ?? '')))
const skip = READY ? false : '登記表或前端分類表讀不出來，先修好上面幾項'
const lines = doc.split('\n')
const editLine = (n, fn) => lines.map((l, i) => (i === n - 1 ? fn(l) : l)).filter(l => l !== null).join('\n')
const fresh = (errs, base) => errs.filter(e => !base.includes(e))

test('還原驗證：表一少一個使用中的種類、狀態寫成舊名，第 1 項都會報錯', { skip }, () => {
  const r = firstUsed(), base = checkSentRegistered(ROWS, SQL.sent)
  const dropped = fresh(checkSentRegistered(topicRows(editLine(r.line, () => null)), SQL.sent), base)
  assert.equal(dropped.length, 1, fail(dropped))
  assert.match(dropped[0], new RegExp(`後台有寄 ${r.code}（.*沒有登記`))
  const renamed = fresh(checkSentRegistered(topicRows(editLine(r.line, l => l.replace(`| ${USED} |`, `| ${OLD} |`))), SQL.sent), base)
  assert.equal(renamed.length, 1, fail(renamed))
  assert.match(renamed[0], new RegExp(`後台有寄 ${r.code}（.*要改成「${USED}」`))
})

test('還原驗證：表一多一個後台沒在寄的使用中種類，第 2 項會報錯；前端有、表上沒有，第 4 項會報錯', { skip }, () => {
  const r = firstUsed()
  const extra = fresh(checkUsedIsSent(topicRows(editLine(r.line, l => `${l}\n${l.replace('`' + r.code + '`', '`zz_not_sent`')}`)), SQL.sent), checkUsedIsSent(ROWS, SQL.sent))
  assert.equal(extra.length, 1, fail(extra))
  assert.match(extra[0], /zz_not_sent 寫「使用中」/)
  const key = FRONT.map(([k]) => k).find(k => ROWS.some(x => x.code === k))
  const gone = fresh(checkFrontKeys(ROWS.filter(x => x.code !== key), FRONT), checkFrontKeys(ROWS, FRONT))
  assert.equal(gone.length, 1, fail(gone))
  assert.match(gone[0], new RegExp(`有 ${key}，但`))
})

test('還原驗證：某一列的分類改錯，第 3 項會報錯', { skip }, () => {
  const r = firstUsed(), real = CAT_ZH[noticeCategory('notice:' + r.code)]
  const wrong = CATS.find(c => c !== r.cat && c !== real)
  const errs = fresh(checkCategories(topicRows(editLine(r.line, l => l.replace(`| ${r.cat} |`, `| ${wrong} |`)))), checkCategories(ROWS))
  assert.equal(errs.length, 1, fail(errs))
  assert.match(errs[0], new RegExp(`${r.code} 登記的分類是「${wrong}」，但前端實際分到「${real}」`))
})

test('還原驗證：表二舊寫法的數字比實際少 1、程式裡舊前綴多到超過登記，第 5 項都會報錯；新寫法變多不報錯', { skip }, () => {
  const base = checkPrefixes(PROWS, PREFIX.counts)
  // 表上的數字改成比「登記的數字、實際次數」兩者都少 1（登記的數字可以比實際大，只減登記的那個不一定會超過）。
  // 舊寫法全部清到 0 之後沒有數字可以再減，這一段就不做；下面「程式多寫」那一段照樣驗
  const r = PROWS.find(x => x.rule === RULE_OLD && Math.min(Number(x.count), PREFIX.counts.get(x.form).n) > 0)
  if (r) {
    const now = PREFIX.counts.get(r.form).n, lower = Math.min(Number(r.count), now) - 1
    const less = fresh(checkPrefixes(prefixRows(editLine(r.line, l => l.replace(`| ${r.count} |`, `| ${lower} |`))), PREFIX.counts), base)
    assert.equal(less.length, 1, fail(less))
    assert.ok(less[0].includes(`前綴「${r.form}」登記 ${lower} 次，實際 ${now} 次`) && less[0].includes(`改用「${GOOD_PREFIX}」`), less[0])
  }
  // 程式這邊：每一種各加到「比登記的多 1」。舊寫法只會多出自己那一種的錯（不會重複算到別種）；新寫法不報錯
  const real = PREFIX.files.map(f => [f.slice(BRIDGE.length + 1), read(f)])
  for (const p of PREFIXES) {
    const reg = Number(PROWS.find(x => x.form === p.form)?.count)
    const more = Math.max(1, reg - PREFIX.counts.get(p.form).n + 1)
    const errs = fresh(checkPrefixes(PROWS, countPrefixes([...real, ['新檔.rs', `let s = "${p.form}多一句";\n`.repeat(more)]])), base)
    assert.equal(errs.length, p.rule === RULE_OLD ? 1 : 0, `多寫「${p.form}」${fail(errs)}`)
    if (errs.length) assert.ok(errs[0].startsWith(`前綴「${p.form}」`), errs[0])
  }
})

test('還原驗證：表一格式改壞（代碼大寫、重複、分類與狀態不在清單內），第 6 項都會報錯', { skip }, () => {
  const r = firstUsed()
  const bad = fn => checkTopicFormat(topicRows(editLine(r.line, fn)))
  assert.match(fail(bad(l => l.replace('`' + r.code + '`', '`Bad-Code`'))), /種類代碼「`Bad-Code`」不合規定/)
  assert.match(fail(bad(l => l.replace('`' + r.code + '`', r.code))), /不合規定。要用反引號包住/)
  assert.match(fail(bad(l => `${l}\n${l}`)), new RegExp(`種類代碼 ${r.code} 重複登記`))
  assert.match(fail(bad(l => l.replace(`| ${r.cat} |`, '| 雜項 |'))), /分類「雜項」不在允許的清單裡/)
  assert.match(fail(bad(l => l.replace(`| ${USED} |`, '| 停用 |'))), /狀態「停用」不在允許的清單裡/)
})

test('取法驗證：後台三種寫法都抓得到；定義、授權、註解、比對用的值不算；看不懂的寫法會報錯', () => {
  const sql = [
    "-- v_res := public.asn_relay_send_notice(p_node, 'in_comment', v_body);",
    'create or replace function public.asn_relay_send_notice(p_node text, p_topic text, p_body text)',
    "  v_kind := 'notice:' || p_topic;",
    "  perform pg_advisory_xact_lock(hashtext('notice:' || p_node || ':' || v_kind));",
    'revoke all on function public.asn_relay_send_notice(text, text, text) from public;',
    "  v_res := public.asn_relay_send_notice(coalesce(p_node, ''), 'aa_literal', v_body, 3, interval '1 hour');",
    "  v_res := public.asn_relay_send_notice(p_node, case when p_kind = 'cmp_a' then 'bb_case' when p_kind in ('cmp_b', 'cmp_c') then 'cc_case' else 'dd_case' end, v_body);",
    "  v_kind constant text := 'notice:ee_const';",
    "  if coalesce(r.kind, '') like 'notice:%' then",
    "  perform pg_advisory_xact_lock(hashtext('misroute_notice:' || p_node));",
  ].join('\n')
  const ok = scanSql('測試.sql', sql)
  assert.deepEqual(ok.unknown, [])
  assert.deepEqual(ok.found.map(h => `${h.kind}｜${h.form}`).sort(), [`aa_literal｜${FORMS[0]}`, `bb_case｜${FORMS[1]}`, `cc_case｜${FORMS[1]}`, `dd_case｜${FORMS[1]}`, `ee_const｜${FORMS[2]}`])
  assert.equal(ok.found.find(h => h.kind === 'aa_literal').where, '測試.sql 第 6 行')
  for (const odd of [
    '  v_res := public.asn_relay_send_notice(p_node, v_topic, v_body);',
    "  v_res := public.asn_relay_send_notice(p_node, case when p_x then v_a else 'b' end, v_body);",
    "  v_kind := 'notice:' || v_other;",
    "  v_kind := 'notice:Bad-Kind';",
  ]) assert.equal(scanSql('測試.sql', odd).unknown.length, 1, odd)
})
