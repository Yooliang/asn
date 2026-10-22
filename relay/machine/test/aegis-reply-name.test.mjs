// 守門：Aegis 橋回信的寄件視窗名要和名單（roster）上的名字一致（中文名優先），
// 不能用 Aegis 回的 member（拼音 slug），否則收件人會看到「另一個拼音名字的視窗」在回信。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge-aegis.mjs'), 'utf8')

test('Aegis 回信與名單用同一個名字（displayName），不用 Aegis 回的 member', () => {
  assert.match(src, /const displayName = slug => memberNames\.get\(slug\) \|\| slug/)
  assert.doesNotMatch(src, /r\.data\?\.member/, '回信寄件人不能取 Aegis 回的 member')
  assert.match(src, /const from = displayName\(slug\)/)
  assert.match(src, /name: displayName\(slug\)/, '名單也要用同一個函式')
  assert.doesNotMatch(src, /replyAndAck\([^)]*,\s*slug\)/, '回信不能直接用 slug 當寄件視窗')
})
