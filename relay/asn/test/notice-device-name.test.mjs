// 「通知」對話：氣泡上方寫「通知 · <設備名>」，並拿掉重複的淡色設備名行；其他對話不變。
// 守門：會進「通知」對話的系統通知文字不准出現「這台」（收在一起就分不出是哪台）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { noticeDevOf } from '../ui/lib/notice.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

test('noticeDevOf：只在通知對話、對方寄的、有設備名時回設備名', () => {
  assert.equal(noticeDevOf({ k: 'them', dev: '家用機' }, true), '家用機')
  assert.equal(noticeDevOf({ k: 'them', dev: '家用機' }, false), '', '其他對話不變')
  assert.equal(noticeDevOf({ k: 'them', dev: '家用機' }, undefined), '')
  assert.equal(noticeDevOf({ k: 'me', dev: '家用機' }, true), '')
  assert.equal(noticeDevOf({ k: 'them' }, true), '')
  assert.equal(noticeDevOf({ k: 'them', dev: '' }, true), '')
  assert.equal(noticeDevOf(null, true), '')
})

test('chatpane：寄件人行加「 · 設備名」，淡色設備名行在通知對話不再重複', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.match(pane, /<span class="who-dev" v-if="noticeDevOf\(m, isNotice\)"> · \{\{ plain\(noticeDevOf\(m, isNotice\)\) \}\}<\/span>/)
  assert.match(pane, /<div class="m-dev" v-if="m\.dev && !noticeDevOf\(m, isNotice\)">/)
  assert.match(pane, /return \{[^}]*\bnoticeDevOf\b/)
})

// ---- 守門：系統通知文字不准有「這台」 ----
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const isTestFile = f => /[\/]tests?[\/]|tests\.rs$|_tests?\.rs$|[\/]tests\.rs$/.test(f)

test('守門（Rust）：bridge/ 底下所有以「[收發室]」開頭的字串常值不含「這台」', () => {
  const dir = path.join(ROOT, 'src-tauri', 'src', 'bridge')
  const bad = []
  let seen = 0
  for (const f of walk(dir).filter(f => f.endsWith('.rs') && !isTestFile(f))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/"((?:[^"\\n]|\.)*)"/g)) {
      if (!m[1].startsWith('[收發室]')) continue
      seen++
      if (m[1].includes('這台')) bad.push(`${path.relative(ROOT, f)}: ${m[1]}`)
    }
  }
  assert.ok(seen >= 3, `掃到的 [收發室] 常值太少（${seen}），規則可能失效`)
  assert.deepEqual(bad, [])
})

test('守門（Rust）：quota.rs／held_notice.rs／misroute.rs 的通知文字不含「這台」（註解除外）', () => {
  const bad = []
  for (const n of ['quota.rs', 'held_notice.rs', 'misroute.rs']) {
    const f = path.join(ROOT, 'src-tauri', 'src', 'bridge', 'core', n)
    const code = fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').replace(/\/\/[^\n"]*$/gm, '')
    const cut = code.search(/#\[cfg\(test\)\]/)
    for (const m of (cut < 0 ? code : code.slice(0, cut)).matchAll(/"((?:[^"\\n]|\.)*)"/g)) if (m[1].includes('這台')) bad.push(`${n}: ${m[1]}`)
  }
  assert.deepEqual(bad, [])
})

test('守門（Node 橋）：bridge.mjs 給 sendBack 的系統通知文字不含「這台」', () => {
  const src = fs.readFileSync(path.join(ROOT, '..', 'machine', 'bridge.mjs'), 'utf8')
  const bad = []
  let seen = 0
  for (const m of src.matchAll(/sendBack\(([^\n]*)\)/g)) {
    if (/^async function/.test(m[0])) continue
    seen++
    if (m[1].includes('這台')) bad.push(m[0])
  }
  assert.ok(seen >= 3, `掃到的 sendBack 呼叫太少（${seen}）`)
  assert.deepEqual(bad, [])
})
