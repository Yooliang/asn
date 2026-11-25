// #2038 契約：Rust 原始碼送出的事件名 ⇄ ui/lib/rust-events.mjs 的事件表，雙向對得上
// Rust 送了表裡沒有 → 紅（新增事件要先登記）；表裡有但 Rust 不送 → 紅；前端沒人接的列白名單（附原因）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUST_EVENTS } from '../ui/lib/rust-events.mjs'

const SRC = fileURLToPath(new URL('../src-tauri/src/', import.meta.url))
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.rs') ? [path.join(d, e.name)] : []))
// 只看正式碼：丟掉測試模組（`#[cfg(test)] mod xxx {` 開頭到檔尾，測試模組放檔尾；`mod xxx;` 只是宣告不算）與整行註解
const prod = f => {
  const t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
  const m = /^#\[cfg\(test\)\]\s*\n\s*(?:pub\s+)?mod\s+\w+\s*\{/m.exec(t)
  return (m ? t.slice(0, m.index) : t).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
}

// 抓：.emit("x" 、.emit_to(任何, "x" 、.emit(NAME 、.emit_to(任何, path::NAME ；NAME 要全大寫（排除 EngineEvent::Reply 這類內部 trait）
export function emittedNames(files) {
  const texts = files.map(prod)
  const all = texts.join('\n')
  const consts = new Map([...all.matchAll(/\bconst\s+([A-Z][A-Z0-9_]+)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]+)"/g)].map(m => [m[1], m[2]]))
  const out = new Set()
  for (const m of all.matchAll(/\.emit\(\s*"([^"]+)"/g)) out.add(m[1])
  for (const m of all.matchAll(/\.emit_to\(\s*[^,]+,\s*"([^"]+)"/g)) out.add(m[1])
  for (const m of all.matchAll(/\.emit\(\s*(?:\w+::)*([A-Z][A-Z0-9_]+)\b/g)) if (consts.has(m[1])) out.add(consts.get(m[1]))
  for (const m of all.matchAll(/\.emit_to\(\s*[^,]+,\s*(?:\w+::)*([A-Z][A-Z0-9_]+)\b/g)) if (consts.has(m[1])) out.add(consts.get(m[1]))
  return out
}

const rustNames = emittedNames(walk(SRC))
const tableNames = new Set(Object.keys(RUST_EVENTS))
// Rust 送了前端還沒人接的（不刪 Rust，本版不改 Rust；之後另開單決定刪或接上）
const NO_LISTENER_OK = new Set(['window-spool', 'term-req-update', 'term-view-remote-input-stalled'])

test('Rust 送的每個事件都在事件表裡（新增事件要先登記）', () => {
  const missing = [...rustNames].filter(n => !tableNames.has(n)).sort()
  assert.deepEqual(missing, [], 'Rust 送了、事件表沒有：請加進 ui/lib/rust-events.mjs')
})

test('事件表的每一種 Rust 都真的會送（表不放死事件）', () => {
  const dead = [...tableNames].filter(n => !rustNames.has(n)).sort()
  assert.deepEqual(dead, [], '事件表有、Rust 不送')
})

test('掃描有抓到東西：事件數對得上表（掃描規則壞掉不會假綠）', () => {
  assert.equal(rustNames.size, 25)
  assert.equal(tableNames.size, 25)
  for (const must of ['agent-setup', 'asn:frame', 'auth-signed-out', 'attach-cache-cleared', 'term-view-remote-input-stalled', 'term-view-remote-end']) assert.ok(rustNames.has(must), `常數／間接送出的事件也要抓到：${must}`)
})

test('listeners:0 的白名單與事件表一致（只准少、不准多）', () => {
  const zero = Object.entries(RUST_EVENTS).filter(([, v]) => v.listeners === 0).map(([k]) => k).sort()
  assert.deepEqual(zero, [...NO_LISTENER_OK].sort())
})

test('掃描器自我測試：壞字／好字', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-contract-'))
  try {
    const f = path.join(tmp, 'a.rs')
    fs.writeFileSync(f, 'const FOO_EVENT: &str = "foo-evt";\nfn a(h:&H){ h.emit("lit-evt", 1); h.emit_to(label, "to-evt", 2); h.emit(FOO_EVENT, 3); h.emit(EngineEvent::Reply{}); }\n// h.emit("commented", 1)\n#[cfg(test)]\nmod t { fn x(){ h.emit("in-test", 1) } }\n')
    assert.deepEqual([...emittedNames([f])].sort(), ['foo-evt', 'lit-evt', 'to-evt'])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
