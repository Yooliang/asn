// #2441 守門：橋（Rust 版與 Linux 的 Node 版）會送進名單的夥伴狀態字串 ⇄ ui/lib/partner-status.mjs 的唯一對照表，雙向對得上。
// 橋送了、表裡沒有 → 紅（前端會把它顯示成「狀態不明」，要先登記）；表裡標「橋會送」、橋其實不送 → 紅；
// 表裡標「外部來源」（Claude 外掛、舊版、別的工具）、橋卻送了 → 紅（要改標成橋會送）。做法比照 rust-events-contract.test.mjs。
// 另外：整個 ui/ 不准再出現第二份夥伴狀態字表（狀態字一律從對照表取）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RAW_STATUS, SCREEN_STATUS, STATUS_LABEL } from '../ui/lib/partner-status.mjs'

const BRIDGE = fileURLToPath(new URL('../src-tauri/src/bridge/', import.meta.url))
const MACHINE = fileURLToPath(new URL('../../machine/', import.meta.url))
const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const walk = (d, ext) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name), ext) : e.name.endsWith(ext) ? [path.join(d, e.name)] : []))

// 從 open（指向 `{`）找配對的 `}`；跳過字串、原始字串、字元、註解裡的大括號。找不到就丟錯（掃描壞掉要紅，不能靜默變綠）
function matchBrace(t, open) {
  let depth = 0
  for (let i = open; i < t.length; i++) {
    const c = t[i]
    if (c === '/' && t[i + 1] === '/') { const e = t.indexOf('\n', i); if (e < 0) break; i = e; continue }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue }
    if (c === 'r' && !/\w/.test(t[i - 1] ?? '')) {
      const raw = /^r(#*)"/.exec(t.slice(i, i + 12))
      if (raw) { const close = `"${raw[1]}`; const e = t.indexOf(close, i + raw[0].length); if (e < 0) break; i = e + close.length - 1; continue }
    }
    if (c === '"') { for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\') i++; continue }
    if (c === "'") { const m = /^'(?:\\.[^']*|[^\\'])'/.exec(t.slice(i, i + 12)); if (m) i += m[0].length - 1; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  throw new Error('找不到配對的大括號（守門掃描器讀不懂這段 Rust，請修掃描器）')
}
// 丟掉所有 `#[cfg(test)] mod xxx { … }` 區塊（可以在檔案中段，後面的正式碼照掃）
const stripTestMods = t => {
  const re = /^[ \t]*#\[cfg\(test\)\]\s*\n\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/gm
  let out = '', pos = 0, m
  while ((m = re.exec(t)) && m.index >= pos) {
    out += t.slice(pos, m.index)
    pos = matchBrace(t, m.index + m[0].length - 1) + 1
    re.lastIndex = pos
  }
  return out + t.slice(pos)
}
const dropComments = t => t.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
// 只看正式碼：測試模組（任何位置）與整行註解不算；tests 資料夾、tests.rs 整個不看
const prod = f => dropComments(stripTestMods(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')))
const isProdFile = f => !/[\\/]tests[\\/]/.test(f) && !/[\\/]tests\.rs$/.test(f)
// 函式本體：從 `fn name` 之後第一個 `{` 到它配對的 `}`
const fnBody = (text, name) => {
  const i = text.search(new RegExp(`\\bfn ${name}\\b`))
  if (i < 0) return ''
  const open = text.indexOf('{', i)
  return open < 0 ? '' : text.slice(open, matchBrace(text, open) + 1)
}
const VAL = '[a-z][a-z_-]*'
const lits = s => [...s.matchAll(new RegExp(`"(${VAL})"`, 'g'))].map(m => m[1])

// 從 Rust 正式碼抓「會當作名單 status 送出」的字面值（每一種寫法都有自我測試）
export function sentStatuses(files) {
  const out = new Map()   // 值 → 來源檔
  const add = (v, f) => { if (!out.has(v)) out.set(v, path.basename(f)) }
  for (const f of files.filter(isProdFile)) {
    const t = prod(f)
    for (const m of t.matchAll(new RegExp(`"status"\\s*:\\s*"(${VAL})"`, 'g'))) add(m[1], f)                       // json!({ "status": "idle" })
    for (const m of t.matchAll(new RegExp(`\\bstatus\\s*=\\s*(?:Some\\(\\s*)?"(${VAL})"`, 'g'))) add(m[1], f)       // next.status = "login-required".into()；status = Some("x".into())
    for (const m of t.matchAll(new RegExp(`\\bstatus:\\s*Some\\(\\s*"(${VAL})"`, 'g'))) add(m[1], f)               // status: Some("idle".into())
    for (const m of t.matchAll(new RegExp(`\\bstatus:\\s*Some\\(\\s*if\\b[^{]*\\{\\s*"(${VAL})"\\s*\\}\\s*else\\s*\\{\\s*"(${VAL})"`, 'g'))) { add(m[1], f); add(m[2], f) }   // Some(if busy { "busy" } else { "idle" }.into())
    for (const m of t.matchAll(new RegExp(`\\blet status = if\\b[^{]*\\{\\s*"(${VAL})"\\s*\\}\\s*else\\s*\\{\\s*"(${VAL})"`, 'g'))) { add(m[1], f); add(m[2], f) }   // pi：let status = if … { "busy" } else { "idle" }
    for (const m of t.matchAll(new RegExp(`\\bconst\\s+\\w*STATUS\\w*\\s*:\\s*&(?:'static\\s+)?str\\s*=\\s*"(${VAL})"`, 'g'))) add(m[1], f)   // 常數：const ROSTER_STATUS_X: &str = "x"
    for (const m of fnBody(t, 'map_mod_state').matchAll(new RegExp(`=>\\s*\\(\\s*"(${VAL})"`, 'g'))) add(m[1], f)  // Claude 外掛狀態檔 → 視窗狀態
    for (const v of lits(fnBody(t, 'roster_status'))) add(v, f)                                                    // ACP 工作者名單狀態的優先序函式（直接寫的字）
    // roster_status 會回傳的健康名：只算它真的用到的 Health 成員（Health::name 的其他成員不會進名單，不能湊數）
    const used = new Set([...fnBody(t, 'roster_status').matchAll(/Health::(\w+)/g)].map(m => m[1]))
    for (const m of t.matchAll(new RegExp(`Health::(\\w+)\\s*=>\\s*"(${VAL})"`, 'g'))) if (used.has(m[1])) add(m[2], f)
    for (const v of lits(fnBody(t, 'respond_status'))) add(v, f)                                                   // 自動回信視窗
  }
  return out
}

// Linux 的 Node 版橋：relay/machine/engines 底下與 bridge-aegis.mjs 送進名單的狀態字
const nodeFiles = () => [...walk(path.join(MACHINE, 'engines'), '.mjs'), path.join(MACHINE, 'bridge-aegis.mjs')]
export function sentNodeStatuses(files) {
  const out = new Map()
  const add = (v, f) => { if (!out.has(v)) out.set(v, path.basename(f)) }
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    for (const m of t.matchAll(new RegExp(`\\bstatus:\\s*'(${VAL})'`, 'g'))) add(m[1], f)                                             // status: 'login-required'
    for (const m of t.matchAll(new RegExp(`\\bstatus:\\s*[^,}\\n]*?\\?\\s*'(${VAL})'\\s*:\\s*'(${VAL})'`, 'g'))) { add(m[1], f); add(m[2], f) }   // status: busy ? 'busy' : 'idle'
    for (const m of t.matchAll(/\bstatus:\s*\(\)\s*=>[^\n]*/g)) for (const v of m[0].matchAll(new RegExp(`'(${VAL})'`, 'g'))) add(v[1], f)   // status: () => (… 'busy' … 'idle')
  }
  return out
}

const sentRust = sentStatuses(walk(BRIDGE, '.rs'))
const sentNode = sentNodeStatuses(nodeFiles())
const sent = new Map([...sentNode, ...sentRust])
const tableBridge = Object.entries(RAW_STATUS).filter(([, v]) => v.origin === 'bridge').map(([k]) => k)
const tableExternal = Object.entries(RAW_STATUS).filter(([, v]) => v.origin === 'external').map(([k]) => k)

test('橋（Rust 與 Node）送出的每一種狀態，前端對照表都有登記（橋多送一種、前端沒接就紅）', () => {
  const missing = [...sent.keys()].filter(v => !Object.prototype.hasOwnProperty.call(RAW_STATUS, v)).sort()
  assert.deepEqual(missing, [], `橋送了、ui/lib/partner-status.mjs 的 RAW_STATUS 沒有：${missing.map(v => `${v}（${sent.get(v)}）`).join('、')}`)
})

test('標成「橋會送」的狀態，橋真的會送（對照表不放橋不會送的值）', () => {
  const dead = tableBridge.filter(v => !sent.has(v)).sort()
  assert.deepEqual(dead, [], '對照表標橋會送、橋不送：刪掉，或改標 external 並寫明來源')
})

test('標成「外部來源」的別名，橋不能送（送了就該改標成橋會送）', () => {
  const wrong = tableExternal.filter(v => sent.has(v)).sort()
  assert.deepEqual(wrong, [])
})

test('掃描有抓到東西：數量對得上（掃描規則壞掉不會兩邊都空集合照綠）', () => {
  assert.deepEqual([...sentRust.keys()].sort(), ['busy', 'idle', 'limit', 'login-required', 'quota', 'running', 'stopped', 'waiting'])
  assert.deepEqual([...sentNode.keys()].sort(), ['busy', 'idle', 'limit', 'login-required', 'quota'])
  for (const must of ['login-required', 'quota', 'limit', 'stopped', 'waiting', 'running']) assert.ok(sent.has(must), `要抓到：${must}`)
})

test('固定斷言：roster_status 一定抓得到的值（從 Rust 那支函式本身取，不靠別處湊數）', () => {
  const f = path.join(BRIDGE, 'engines', 'acp_worker.rs')
  const body = fnBody(prod(f), 'roster_status')
  assert.ok(body.length > 40, '要找得到 roster_status 函式本體')
  const got = sentStatuses([f])
  for (const must of ['stopped', 'busy', 'idle', 'login-required', 'quota']) assert.ok(got.has(must), `roster_status 要抓到：${must}`)
  assert.ok(!got.has('unavailable'), 'Health::Unavailable 不會進名單（listed() 會把它藏掉），不能算「橋會送」')
})

test('每個對照到的畫面狀態都有登記屬性；橋送的值沒有一個會變成「狀態不明」', () => {
  for (const [raw, v] of Object.entries(RAW_STATUS)) assert.ok(SCREEN_STATUS[v.to], `${raw} → ${v.to} 沒有畫面狀態屬性`)
  for (const v of sent.keys()) assert.notEqual(RAW_STATUS[v]?.to, 'unknown', v)
})

test('整個 ui/ 不再有第二份夥伴狀態字表：每一份「線上／忙碌／…」字表都要從 partner-status.mjs 取', () => {
  const labels = [...new Set(Object.values(STATUS_LABEL))]   // 例：線上、忙碌、要重新登入…
  // 工作管理員的程序狀態字（多了「接回中」「可能卡住了」這類夥伴名單沒有的狀態）是另一件事，登記為例外
  const EXEMPT = new Set(['partner-status.mjs', 'task-manager.mjs'])
  const files = [...walk(UI, '.mjs'), ...walk(UI, '.js')].filter(f => !EXEMPT.has(path.basename(f)))
  const hits = []
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return
      // 一個物件字面值裡同時出現兩個以上不同的狀態字當值（`online: '線上', busy: '忙碌'` 這種字表）
      const n = labels.filter(lb => new RegExp(`:\\s*['"\`]${lb}['"\`]`).test(l)).length
      if (n >= 2) hits.push(`${path.relative(UI, f)}:${i + 1}`)
    })
  }
  assert.deepEqual(hits, [], `這些地方自己寫了一份狀態字表，改從 ui/lib/partner-status.mjs 取：${hits.join('、')}`)
})

test('掃描器自我測試（Rust）：各種寫法都抓得到，測試模組（含檔案中段的）與註解不算', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-status-contract-'))
  try {
    const f = path.join(tmp, 'a.rs')
    fs.writeFileSync(f, [
      'fn a() { let _ = json!({ "name": n, "status": "s-json" }); }',
      'fn b(n: &mut W) { n.status = "s-assign".into(); }',
      'fn c() -> W { W { status: Some("s-some".into()) } }',
      'fn d() -> W { W { status: Some(if busy { "s-if-a" } else { "s-if-b" }.into()) } }',
      'fn e() { let status = if x { "s-let-a" } else { "s-let-b" }; }',
      'fn map_mod_state(s: &str) -> Option<(&\'static str, Option<&\'static str>)> {',
      '    Some(match s {',
      '        "busy" => ("s-mod", None),',
      '    })',
      '}',
      'enum Health { A, Ok, Hidden }',
      'impl Health { fn name(self) -> &\'static str { match self { Health::A => "s-health", Health::Ok => "ok", Health::Hidden => "s-hidden" } } }',
      'fn roster_status(a: bool, h: Health) -> &\'static str {',
      '    if a { "s-roster" } else if h == Health::A { h.name() } else { "s-roster-b" }',
      '}',
      'fn f2(n: &mut W) { n.status = Some("s-assign-some".into()); }',
      'const ROSTER_STATUS_X: &str = "s-const";',
      'fn g() { let _ = json!({ "status": "s_under" }); }',
      '// "status": "s-comment"',
      '#[cfg(test)]',
      'mod t { fn x() { let _ = json!({ "status": "s-in-test", "b": "}" }); let c = \'}\'; } }',
      'fn after_test_mod() { let _ = json!({ "status": "s-after-test" }); }',
      '',
    ].join('\n'))
    assert.deepEqual([...sentStatuses([f]).keys()].sort(), ['s-after-test', 's-assign', 's-assign-some', 's-const', 's-health', 's-if-a', 's-if-b', 's-json', 's-let-a', 's-let-b', 's-mod', 's-roster', 's-roster-b', 's-some', 's_under'])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('掃描器自我測試（Node 版橋）：各種寫法都抓得到，註解不算', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-status-contract-js-'))
  try {
    const f = path.join(tmp, 'a.mjs')
    fs.writeFileSync(f, [
      "const a = { name: 'x', status: 'j-plain' }",
      "const b = { name: 'x', status: busy ? 'j-t-a' : 'j-t-b', cwd: 1 }",
      "const c = { status: () => (r ? 'j-fn-a' : health === 'j-fn-b' ? health : 'j-fn-c') }",
      "// status: 'j-comment'",
      "if (t.status === 'completed') {}",
      '',
    ].join('\n'))
    assert.deepEqual([...sentNodeStatuses([f]).keys()].sort(), ['j-fn-a', 'j-fn-b', 'j-fn-c', 'j-plain', 'j-t-a', 'j-t-b'])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('掃描器自我測試（ui 字表）：自己寫一份狀態字表會被抓到', () => {
  const labels = [...new Set(Object.values(STATUS_LABEL))]
  const line = "const STATUS = { online: '線上', busy: '忙碌' }"
  assert.ok(labels.filter(lb => new RegExp(`:\\s*['"\`]${lb}['"\`]`).test(line)).length >= 2)
})
