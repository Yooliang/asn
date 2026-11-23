// #2161 PR0 守門：「在線門檻」不准再裸寫在新的 migration 裡，前端也不准再冒出新的新鮮度字面量。
// 後續 PR 會把後台 SQL 的 `interval '3 minutes'` 改成引用 relay.online_window()；這支先把門關上，避免一邊改一邊又有新的裸寫進來。
// 檔名含 `_sql`：CI（asn-linux-build.yml）跑的是 `run-root-tests.mjs _sql login_domains`，靠這個篩選字才會被跑到。
// 只讀原始碼文字，不連資料庫。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const rdAbs = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

// ───────── 1. migration 守門 ─────────

// 基準線：建這支守門時最新的 migration 時間戳。含基準線以前的一律不檢查（歷史包袱，由 PR1 以後逐步清）；之後新增的才查。
const BASELINE = '20261122210000'

// 允許清單：檔名（例如 '20261201000000_foo.sql'）。確實「不是在線門檻」的 3 分鐘（例如某功能自己的逾時）才加進來，必須在這裡寫理由。
const ALLOW = []

/** 剝掉 SQL 註解（`--` 到行尾、區塊註解），但保留單引號字串內的內容（字串裡的 -- 不是註解）。 */
export function stripSqlComments(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j++; break }
        j++
      }
      out += sql.slice(i, j)
      i = j
    } else if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (c === '/' && d === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out
}

const MIN = String.raw`min(?:ute)?s?`
const RAW_PATTERNS = [
  new RegExp(String.raw`'\s*3\s+${MIN}\s*'`, 'i'),                 // interval '3 minutes'、'3 min'、'3 minute'::interval
  /'\s*180\s+sec(?:ond)?s?\s*'/i,                                    // interval '180 seconds'
  new RegExp(String.raw`interval\s+'\s*3\s*'\s*${MIN}`, 'i'),                // interval '3' minute（標準寫法）
  /'\s*0?0:03:00(?:\.0+)?\s*'/,                                      // interval '00:03:00'
  /\bmake_interval\s*\([^)]*\bmins\s*=>\s*3(?![\d.])/i,              // make_interval(mins => 3)
  new RegExp(String.raw`(?<![\d.])3\s*\*\s*interval\s+'\s*1\s+${MIN}\s*'`, 'i'),   // 3 * interval '1 minute'
  new RegExp(String.raw`interval\s+'\s*1\s+${MIN}\s*'\s*\*\s*3(?![\d.])`, 'i'),    // interval '1 minute' * 3
  /(?<![\d.])3\s*\*\s*interval\s+'\s*60\s+sec(?:ond)?s?\s*'/i,       // 3 * interval '60 seconds'
]

/** 找出（已剝註解的）SQL 裡裸寫的 3 分鐘在線門檻；回傳命中的片段陣列（沒有就空陣列）。 */
export function findRawOnlineWindow(sqlText) {
  const code = stripSqlComments(sqlText)
  const hits = []
  for (const re of RAW_PATTERNS) {
    const m = re.exec(code)
    if (m) hits.push(m[0])
  }
  return hits
}

const MIG_DIR = new URL('supabase/migrations/', ROOT)
const migFiles = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
const stamp = f => f.split('_')[0]

test('#2161 前提：掃得到 migration（>100 支）、基準線檔案存在、允許清單項目都存在', () => {
  assert.ok(migFiles.length > 100, `只掃到 ${migFiles.length} 支 migration，掃描可能空過`)
  assert.ok(migFiles.some(f => stamp(f) === BASELINE), `基準線 ${BASELINE} 對不到任何 migration 檔`)
  for (const a of ALLOW) assert.ok(migFiles.includes(a), `ALLOW 裡的 ${a} 不存在（清單過期）`)
})

test('#2161 findRawOnlineWindow：正例都抓得到', () => {
  const pos = [
    "select now() - interval '3 minutes'",
    "select now() - INTERVAL '3 MINUTES'",
    "select now() - interval  '3 minute'",
    "select now() - interval '3 min'",
    "select now() - interval '3 mins'",
    "select now() - '3 minutes'::interval",
    "select now() - interval '180 seconds'",
    "select now() - interval '3' minute",
    "select now() - interval '180 secs'",
    "select now() - interval '00:03:00'",
    "select now() - make_interval(mins => 3)",
    "select now() - make_interval(secs => 1, mins => 3)",
    "select now() - 3 * interval '1 minute'",
    "select now() - interval '1 minute' * 3",
    "select now() - 3*interval '1 minutes'",
    "select now() - 3 * interval '60 seconds'",
    "select 1 -- 無關\n where seen_at > now() - interval '3 minutes'",
    "/* 說明 */ select interval '3 minutes'",
  ]
  for (const s of pos) assert.ok(findRawOnlineWindow(s).length > 0, `應該抓到卻沒抓到：${s}`)
})

test('#2161 findRawOnlineWindow：反例不誤報', () => {
  const neg = [
    "select now() - interval '1 minute'",
    "select now() - interval '30 minutes'",
    "select now() - interval '13 minutes'",
    "select now() - interval '2 minutes'",
    "select now() - interval '24 hours'",
    "select now() - interval '300 seconds'",
    "select now() - interval '1800 seconds'",
    "select now() - interval '00:30:00'",
    "select now() - make_interval(mins => 30)",
    "select now() - make_interval(mins => 3.5)",
    "select now() - 13 * interval '1 minute'",
    "select now() - 30 * interval '1 minute'",
    "select now() - interval '1 minute' * 30",
    "select 1 -- interval '3 minutes' 只在註解裡\n",
    "/* interval '3 minutes' */ select 1",
    "/* 多行\n interval '3 minutes'\n */ select 1",
    "update t set done_at = now() - interval '2 minutes' where id = 1",
    "select relay.online_window()",
  ]
  for (const s of neg) assert.deepEqual(findRawOnlineWindow(s), [], `不該報卻報了：${s}`)
})

test('#2161 基準線之後新增的 migration 不得裸寫 3 分鐘在線門檻（要引用 relay.online_window()）', () => {
  const bad = []
  for (const f of migFiles) {
    if (stamp(f) <= BASELINE) continue
    if (ALLOW.includes(f)) continue
    const hits = findRawOnlineWindow(rdAbs(new URL(f, MIG_DIR)))
    if (hits.length) bad.push(`${f}：${hits.join(' | ')}`)
  }
  assert.deepEqual(bad, [], `這些 migration 裸寫了 3 分鐘門檻，請改用 relay.online_window()；若確實不是在線門檻，加進 ALLOW 並寫理由：\n${bad.join('\n')}`)
})

// ───────── 2. 前端守門 ─────────

const UI_DIR = new URL('relay/asn/ui/', ROOT)

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'node_modules') continue
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const relUi = u => u.href.slice(UI_DIR.href.length)
const uiFiles = walk(UI_DIR)

// 允許清單：目前 main 上就有的「新鮮度常數」定義（檔名::常數名）。新增新的要先想能不能共用既有常數，不能才加進來。
const FRESH_DEFS = [
  'lib/account-quota.mjs::STALE_MS',
  'lib/account-roster.mjs::FIVE_HOUR_STALE_MS',
  'lib/device-state.mjs::REPORT_FRESH_MS',
]

// 目前 main 上「名字含 fresh／online／stale／seen／alive 的行」裡出現 3 分鐘字面量的既有命中（檔名::行內容摘要）。
// 現況為空：既有的 3 分鐘字面量（OFFLINE_DEBOUNCE_MS、CONT_GAP_MS 等）名字都不含上述字根。
const ALLOW_FRONT = []

/** 剝掉 JS 的 `//` 行尾註解（粗略：不處理字串裡的 //，URL 的 :// 例外保留）。 */
function stripJsLineComment(line) {
  return line.replace(/(^|[^:])\/\/.*$/, '$1')
}

const FRESH_DEF_RE = /^\s*(?:export\s+)?const\s+((?:[A-Za-z0-9_]*_)?(?:FRESH|ONLINE|STALE)_MS)\s*=/

/** 找出新鮮度常數定義，回傳 ['名字'...] */
export function findFreshDefs(src) {
  const names = []
  for (const line of src.split('\n')) {
    const m = FRESH_DEF_RE.exec(stripJsLineComment(line))
    if (m) names.push(m[1])
  }
  return names
}

const THREE_MIN_RE = /(?<![\w.])(?:60\s*\*\s*1000\s*\*\s*3|3\s*\*\s*60\s*\*\s*1000|1000\s*\*\s*60\s*\*\s*3|3\s*\*\s*1000\s*\*\s*60|180000|180_000|3\s*\*\s*60_000|60_000\s*\*\s*3|3\s*\*\s*60000|60000\s*\*\s*3)(?![\w.])/
const FRESH_NAME_RE = /fresh|online|stale|seen|alive/i

/** 找出「名字含 fresh／online／stale／seen／alive 的行」上的 3 分鐘字面量，回傳整行（去頭尾空白）。 */
export function findFreshThreeMinutes(src) {
  const hits = []
  for (const raw of src.split('\n')) {
    const line = stripJsLineComment(raw)
    if (FRESH_NAME_RE.test(line) && THREE_MIN_RE.test(line)) hits.push(line.trim())
  }
  return hits
}

test('#2161 前端 findFreshDefs／findFreshThreeMinutes：正反例', () => {
  assert.deepEqual(findFreshDefs('export const NEW_FRESH_MS = 180000'), ['NEW_FRESH_MS'])
  assert.deepEqual(findFreshDefs('  const ONLINE_MS = 1'), ['ONLINE_MS'])
  assert.deepEqual(findFreshDefs('const STALE_MS = 6 * 3600_000'), ['STALE_MS'])
  assert.deepEqual(findFreshDefs('const REFRESH_MS = 5000'), [])
  assert.deepEqual(findFreshDefs('// const X_FRESH_MS = 1'), [])
  assert.deepEqual(findFreshDefs('const FRESHNESS = 1'), [])
  for (const s of [
    'const onlineWindow = 60 * 1000 * 3', 'if (now - lastSeen < 3 * 60 * 1000)', 'const isFresh = d < 180000',
    'const aliveMs = 180_000', 'const staleAfter = 3 * 60_000', 'const staleAfter = 3*60*1000',
  ]) assert.equal(findFreshThreeMinutes(s).length, 1, s)
  for (const s of [
    'const OFFLINE_DEBOUNCE_MS = 3 * 60 * 1000', 'const REPLY_TIMEOUT_MS = 180_000', 'const online = 1800000',
    'const online = x * 1180000', 'const seen = 15 * 60 * 1000', '// online 3 * 60 * 1000', 'const online = 0.180000',
  ]) assert.deepEqual(findFreshThreeMinutes(s), [], s)
})

test('#2161 前提：前端掃得到檔案、FRESH_DEFS／ALLOW_FRONT 項目都真的存在', () => {
  assert.ok(uiFiles.length > 20, `只掃到 ${uiFiles.length} 個前端檔，掃描可能空過`)
  const found = new Set()
  for (const u of uiFiles) for (const n of findFreshDefs(rdAbs(u))) found.add(`${relUi(u)}::${n}`)
  for (const d of FRESH_DEFS) assert.ok(found.has(d), `FRESH_DEFS 裡的 ${d} 已不存在（清單過期，請移除）`)
  const hits = new Set()
  for (const u of uiFiles) for (const l of findFreshThreeMinutes(rdAbs(u))) hits.add(`${relUi(u)}::${l}`)
  for (const a of ALLOW_FRONT) assert.ok(hits.has(a), `ALLOW_FRONT 裡的 ${a} 已不存在（清單過期，請移除）`)
})

test('#2161 前端不得新增新鮮度常數定義（掃到的 ⊆ FRESH_DEFS）', () => {
  const extra = []
  for (const u of uiFiles) for (const n of findFreshDefs(rdAbs(u))) {
    const key = `${relUi(u)}::${n}`
    if (!FRESH_DEFS.includes(key)) extra.push(key)
  }
  assert.deepEqual(extra, [], `前端新增了新鮮度常數：${extra.join('、')}；請共用既有常數，確有需要再加進 FRESH_DEFS`)
})

test('#2161 前端不得在 fresh／online／stale／seen／alive 的行上新增 3 分鐘字面量', () => {
  const extra = []
  for (const u of uiFiles) for (const l of findFreshThreeMinutes(rdAbs(u))) {
    const key = `${relUi(u)}::${l}`
    if (!ALLOW_FRONT.includes(key)) extra.push(key)
  }
  assert.deepEqual(extra, [], `前端出現 3 分鐘新鮮度字面量：\n${extra.join('\n')}`)
})
