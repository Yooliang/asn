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
const isTestFile = f => /\/tests?\/|tests\.rs$|_tests?\.rs$/.test(f.split(path.sep).join('/'))

// 例外（不是進「通知」對話的）：
//  - 代夥伴寄的「轉交失敗」說明（core.rs fail_notice_text）：字頭是給對方橋認「這封本身是通知」用的（fail_notice.rs note_if_notice）
//  - 傳給本機視窗的說明（tell_window、沒指定收件視窗的附註），不經 send_back 寄給人
const HEAD_ALLOWED = [
  ['core.rs', '[收發室] {target} 收到信了'],
  ['core.rs', '[收發室] 轉交給 {target} 失敗'],
  ['core.rs', '[收發室] 你傳給收發室的代寄信沒有寄出'],
  ['mail.rs', '[收發室] 這封信沒有指定收件視窗'],
  ['fail_notice.rs', '[收發室] '],
  ['dev_prefix.rs', '[收發室] '],         // 要去掉的舊字頭常數
  ['acp_approvals.rs', '[收發室]'],        // 解析夥伴回覆時要剝掉的字頭，不是寄出的文字
]
const rsLiterals = () => {
  const dir = path.join(ROOT, 'src-tauri', 'src', 'bridge')
  const out = []
  for (const f of walk(dir).filter(f => f.endsWith('.rs') && !isTestFile(f))) {
    let src = fs.readFileSync(f, 'utf8')
    const cut = src.search(/#\[cfg\(test\)\]/)
    if (cut >= 0) src = src.slice(0, cut)
    for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) out.push({ file: path.basename(f), text: m[1], rel: path.relative(ROOT, f) })
  }
  return out
}

test('守門（Rust）：bridge/ 底下所有以「[收發室]」開頭的字串常值不含「這台」', () => {
  const hits = rsLiterals().filter(l => l.text.startsWith('[收發室]'))
  assert.ok(hits.length >= 3, `掃到的 [收發室] 常值太少（${hits.length}），規則可能失效`)
  assert.deepEqual(hits.filter(l => l.text.includes('這台')).map(l => `${l.rel}: ${l.text}`), [])
})

test('守門（Rust）：會進「通知」對話的文字不以「[收發室]」開頭（只有明列的例外）', () => {
  const bad = rsLiterals().filter(l => l.text.startsWith('[收發室]') && !HEAD_ALLOWED.some(([f, p]) => f === l.file && l.text.startsWith(p)))
  assert.deepEqual(bad.map(l => `${l.rel}: ${l.text}`), [])
})

test('守門（Rust）：acp_worker.rs 的錯誤說明（會被接進「轉交給 X 失敗」通知）不含「這台」', () => {
  const bad = rsLiterals().filter(l => l.file === 'acp_worker.rs' && l.text.includes('這台'))
  assert.deepEqual(bad.map(l => l.text), [])
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

test('守門（Node 橋）：bridge.mjs 給 sendBack 的系統通知不以「[收發室]」開頭；acp-worker.mjs 的錯誤說明不含「這台」', () => {
  const src = fs.readFileSync(path.join(ROOT, '..', 'machine', 'bridge.mjs'), 'utf8')
  const calls = [...src.matchAll(/await sendBack\(([^\n]*)\)/g)].map(m => m[1])
  assert.ok(calls.length >= 3)
  assert.deepEqual(calls.filter(c => /[`'"]\[收發室\]/.test(c)), [])
  const acp = fs.readFileSync(path.join(ROOT, '..', 'machine', 'engines', 'acp-worker.mjs'), 'utf8')
  const lines = acp.split('\n').filter(l => /需要登入|請登入|終端機執行 agy/.test(l))
  assert.ok(lines.length >= 2)
  assert.deepEqual(lines.filter(l => l.includes('這台')), [])
})
