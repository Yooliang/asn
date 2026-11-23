// #2183 守門：ui/ 裡不准把 e.message 直接拿去畫面顯示。
// 為什麼：Tauri 的 Err(String) 以字串拋出，e.message 會是 undefined（畫面什麼都沒有）；就算有值也是後端原文。
// 顯示一律走 plainMessage(e)；寫 log／console 的原文照舊（那是原文該去的地方）。
// 掃：ui/ 底下全部 .js／.mjs／.html（list.js、m.js、chat.js、lib/ 全在內），vendor 除外。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWN_PEER_FAILED_TEXT, plainMessage } from '../ui/lib/plain-errors.mjs'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))

// 允許清單：{ file, line（該行去頭尾空白後的內容）, 原因 }。目前沒有。
export const ALLOW = []

const V = String.raw`\b(?:e|err|error|ex)\.message\b`
// 「拿去顯示」的寫法（直接取 .message，不含包在 friendlyXxx(...) 轉白話函式裡的）
export const DISPLAY_FORMS = [
  ['指派給畫面狀態', new RegExp(String.raw`(?<![=!<>])=\s*${V}(?!\s*[.(\[])`)],
  ['塞進顯示字串', new RegExp(String.raw`\$\{\s*${V}\s*(?:\}|\|\||\?\?)`)],
  ['字串相加', new RegExp(String.raw`\+\s*${V}|${V}\s*\+`)],
  ['message 欄位', new RegExp(String.raw`\bmessage\s*:\s*${V}`)],
  ['丟給提示函式', new RegExp(String.raw`\b(?:say|toast|notify|alert|showError)\(\s*${V}`)],
]
// 同一個述句（以 ; { } 切）裡有 console／log 呼叫，視為只寫 log
const LOG_CALL = /\bconsole\.\w+\(|\b(?:this\.)?(?:log|stateLog\.\w+)\(/

export function findDisplayMessage(src) {
  const hits = []
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/^\s*\/\/.*$/, '')
    for (const [why, re] of DISPLAY_FORMS) {
      const m = re.exec(code)
      if (!m) continue
      const seg = code.slice(0, m.index).replace(/\$\{[^}]*\}/g, '').split(/[;{}]/).pop()   // 先拿掉字串裡的 ${...}，免得被當成述句邊界
      if (LOG_CALL.test(seg)) continue
      hits.push({ line: i + 1, why, text: line.trim() })
    }
  })
  return hits
}

function walk(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'vendor') continue
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, out)
    else if (/\.(?:js|mjs|html)$/.test(d.name)) out.push(p)
  }
  return out
}

test('ui/ 裡沒有把 e.message 直接拿去畫面顯示的寫法（改用 plainMessage(e)）', () => {
  const bad = []
  for (const f of walk(UI)) {
    const rel = path.relative(UI, f).replace(/\\/g, '/')
    for (const h of findDisplayMessage(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))) {
      if (ALLOW.some(a => a.file === rel && a.line === h.text)) continue
      bad.push(`ui/${rel}:${h.line}（${h.why}）${h.text.slice(0, 100)}`)
    }
  }
  assert.deepEqual(bad, [], `這些地方把 e.message 直接顯示在畫面上，請改 plainMessage(e)：\n${bad.join('\n')}`)
})

test('守門本身有效：抓得到各種顯示寫法、放過只寫 log 與轉白話函式', () => {
  for (const bad of [
    'catch (e) { x.value = e.message }',
    'catch (e) { a.msg = e.message; a.busy = false }',
    'note = `念不出來：${e.message}`',
    'note = `念不出來：${e.message || "失敗"}`',
    'say("失敗：" + err.message)',
    'return { ok: false, message: e.message }',
    'catch (e) { say(e.message) }',
    "console.info('x'); box.error = error.message",
  ]) assert.equal(findDisplayMessage(bad).length, 1, bad)
  for (const ok of [
    "catch (e) { console.info('[ASN] 複製失敗', e.message) }",
    'this.log(`load failed: ${e.message}`)',
    'upd.manual = updateCheckErrorText(e.message)',
    'if (/不合規則/.test(String(e.message))) throw e',
    'if (historyUnsupported(e.message)) this.historyOff = true',
    'x.value = plainMessage(e)',
    'if (a === e.message) return',
    '// x.value = e.message（註解）',
  ]) assert.deepEqual(findDisplayMessage(ok), [], ok)
})

test('plainMessage：字串、Error、帶 message 的物件都取得出白話；取不到就回通用白話、不回空字串', () => {
  assert.equal(plainMessage('名字太長了'), '名字太長了')
  assert.equal(plainMessage(new Error('登入過期了')), '登入過期了')
  assert.equal(plainMessage({ message: '沒有權限' }), '沒有權限')
  for (const v of [undefined, null, '', '   ', new Error(''), {}, { message: 42 }, 42]) {
    assert.equal(plainMessage(v), KNOWN_PEER_FAILED_TEXT, String(v))
  }
  assert.notEqual(plainMessage(undefined), '')
})
