// #2441 守門：橋（Rust）會送進名單的夥伴狀態字串 ⇄ ui/lib/partner-status.mjs 的唯一對照表，雙向對得上。
// 橋送了、表裡沒有 → 紅（前端會把它顯示成「狀態不明」，要先登記）；表裡標「橋會送」、Rust 其實不送 → 紅；
// 表裡標「外部來源」（Claude 外掛、舊版）、Rust 卻送了 → 紅（要改標成橋會送）。做法比照 rust-events-contract.test.mjs。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RAW_STATUS, SCREEN_STATUS } from '../ui/lib/partner-status.mjs'

const BRIDGE = fileURLToPath(new URL('../src-tauri/src/bridge/', import.meta.url))
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.rs') ? [path.join(d, e.name)] : []))
// 只看正式碼：丟掉測試模組（`#[cfg(test)] mod xxx {` 到檔尾）與整行註解；tests 資料夾整個不看
const prod = f => {
  const t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
  const m = /^#\[cfg\(test\)\]\s*\n\s*(?:pub\s+)?mod\s+\w+\s*\{/m.exec(t)
  return (m ? t.slice(0, m.index) : t).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
}
const isProdFile = f => !/[\\/]tests[\\/]/.test(f) && !/[\\/]tests\.rs$/.test(f)
// 函式本體：從 `fn name` 到下一個行首的 `}`（Rust 慣例縮排，函式結尾的 } 在行首或同縮排）
const fnBody = (text, name) => {
  const i = text.search(new RegExp(`\\bfn ${name}\\b`))
  if (i < 0) return ''
  const rest = text.slice(i)
  const j = rest.search(/\n(?: {0,4})\}\n/)
  return j < 0 ? rest : rest.slice(0, j)
}
const lits = s => [...s.matchAll(/"([a-z][a-z-]*)"/g)].map(m => m[1])

// Health::Ok 的名字 "ok" 是健康檢查用字（遠端管理的設備快照），不是夥伴狀態，不會進名單
const NOT_A_STATUS = new Set(['ok'])

// 從 Rust 正式碼抓「會當作名單 status 送出」的字面值（每一種寫法都有自我測試）
export function sentStatuses(files) {
  const out = new Map()   // 值 → 來源檔
  const add = (v, f) => { if (!NOT_A_STATUS.has(v) && !out.has(v)) out.set(v, path.basename(f)) }
  for (const f of files.filter(isProdFile)) {
    const t = prod(f)
    for (const m of t.matchAll(/"status"\s*:\s*"([a-z][a-z-]*)"/g)) add(m[1], f)                        // json!({ "status": "idle" })
    for (const m of t.matchAll(/\bstatus\s*=\s*"([a-z][a-z-]*)"/g)) add(m[1], f)                         // next.status = "login-required".into()
    for (const m of t.matchAll(/\bstatus:\s*Some\(\s*"([a-z][a-z-]*)"/g)) add(m[1], f)                   // status: Some("idle".into())
    for (const m of t.matchAll(/\bstatus:\s*Some\(\s*if\b[^{]*\{\s*"([a-z][a-z-]*)"\s*\}\s*else\s*\{\s*"([a-z][a-z-]*)"/g)) { add(m[1], f); add(m[2], f) }   // Some(if busy { "busy" } else { "idle" }.into())
    for (const m of t.matchAll(/\blet status = if\b[^{]*\{\s*"([a-z][a-z-]*)"\s*\}\s*else\s*\{\s*"([a-z][a-z-]*)"/g)) { add(m[1], f); add(m[2], f) }   // pi：let status = if … { "busy" } else { "idle" }
    for (const m of fnBody(t, 'map_mod_state').matchAll(/=>\s*\(\s*"([a-z][a-z-]*)"/g)) add(m[1], f)    // Claude 外掛狀態檔 → 視窗狀態
    for (const m of t.matchAll(/Health::\w+\s*=>\s*"([a-z][a-z-]*)"/g)) add(m[1], f)                    // ACP 工作者的健康名
    for (const v of lits(fnBody(t, 'roster_status'))) add(v, f)                                          // ACP 工作者名單狀態的優先序函式
    for (const v of lits(fnBody(t, 'respond_status'))) add(v, f)                                         // 自動回信視窗
  }
  return out
}

const sent = sentStatuses(walk(BRIDGE))
const tableBridge = Object.entries(RAW_STATUS).filter(([, v]) => v.origin === 'bridge').map(([k]) => k)
const tableExternal = Object.entries(RAW_STATUS).filter(([, v]) => v.origin === 'external').map(([k]) => k)

test('橋送出的每一種狀態，前端對照表都有登記（橋多送一種、前端沒接就紅）', () => {
  const missing = [...sent.keys()].filter(v => !Object.prototype.hasOwnProperty.call(RAW_STATUS, v)).sort()
  assert.deepEqual(missing, [], `Rust 送了、ui/lib/partner-status.mjs 的 RAW_STATUS 沒有：${missing.map(v => `${v}（${sent.get(v)}）`).join('、')}`)
})

test('標成「橋會送」的狀態，Rust 真的會送（對照表不放橋不會送的值）', () => {
  const dead = tableBridge.filter(v => !sent.has(v)).sort()
  assert.deepEqual(dead, [], '對照表標橋會送、Rust 不送：刪掉，或改標 external 並寫明來源')
})

test('標成「外部來源」的別名，Rust 不能送（送了就該改標成橋會送）', () => {
  const wrong = tableExternal.filter(v => sent.has(v)).sort()
  assert.deepEqual(wrong, [])
})

test('掃描有抓到東西：數量對得上（掃描規則壞掉不會兩邊都空集合照綠）', () => {
  assert.deepEqual([...sent.keys()].sort(), ['busy', 'idle', 'limit', 'login-required', 'quota', 'running', 'stopped', 'unavailable', 'waiting'])
  for (const must of ['login-required', 'quota', 'limit', 'stopped', 'waiting', 'running']) assert.ok(sent.has(must), `要抓到：${must}`)
})

test('每個對照到的畫面狀態都有登記屬性；橋送的值沒有一個會變成「狀態不明」', () => {
  for (const [raw, v] of Object.entries(RAW_STATUS)) assert.ok(SCREEN_STATUS[v.to], `${raw} → ${v.to} 沒有畫面狀態屬性`)
  for (const v of sent.keys()) assert.notEqual(RAW_STATUS[v]?.to, 'unknown', v)
})

test('掃描器自我測試：各種寫法都抓得到，測試模組與註解不算', () => {
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
      'impl H { fn name(self) -> &\'static str { match self { Health::A => "s-health", Health::Ok => "ok" } } }',
      'fn roster_status(a: bool) -> &\'static str {',
      '    if a { "s-roster" } else { "s-roster-b" }',
      '}',
      '// "status": "s-comment"',
      '#[cfg(test)]',
      'mod t { fn x() { let _ = json!({ "status": "s-in-test" }); } }',
      '',
    ].join('\n'))
    assert.deepEqual([...sentStatuses([f]).keys()].sort(), ['s-assign', 's-health', 's-if-a', 's-if-b', 's-json', 's-let-a', 's-let-b', 's-mod', 's-roster', 's-roster-b', 's-some'])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
