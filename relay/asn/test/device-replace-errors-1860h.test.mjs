// #1860 H：設備取代的白話錯誤在 Edge Function（TS）與 Rust 各一份，這裡鎖住兩份文字與代碼集合完全相同。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n')
const ts = read('supabase', 'functions', '_shared', 'device_replace.ts')
const rs = read('relay', 'asn', 'src-tauri', 'src', 'relay.rs')

function tsErrors() {
  const block = ts.match(/const ERRORS[^=]*=\s*\{([\s\S]*?)\n\};/)
  assert.ok(block, '找不到 TS 的 ERRORS')
  const out = {}
  for (const m of block[1].matchAll(/^\s*(\w+):\s*\{\s*status:\s*\d+,\s*message:\s*"([^"]+)"\s*\}/gm)) out[m[1]] = m[2]
  return out
}

function rustErrors() {
  const fn = rs.match(/pub fn device_replace_error[\s\S]*?\n\}\n/)
  assert.ok(fn, '找不到 Rust 的 device_replace_error')
  const out = {}
  for (const m of fn[0].matchAll(/else if ([^{]*)\{\s*"([^"]+)"\.into\(\)|if (has\([^{]*)\{\s*"([^"]+)"\.into\(\)/g)) {
    const cond = m[1] ?? m[3]; const msg = m[2] ?? m[4]
    for (const k of cond.matchAll(/has\("([a-z_]+)"\)/g)) out[k[1]] = msg   // 只收代碼（小寫加底線）；「HTTP 401」這類狀態碼不算
  }
  return out
}

test('#1860H 設備取代的白話：TS 與 Rust 的代碼集合與每句文字完全相同', () => {
  const a = tsErrors(), b = rustErrors()
  assert.ok(Object.keys(a).length >= 5, '至少抽到 5 個代碼（含 bad_request）')
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), '兩邊代碼集合相同')
  for (const k of Object.keys(a)) assert.equal(b[k], a[k], `${k} 的白話兩邊要一樣`)
})
