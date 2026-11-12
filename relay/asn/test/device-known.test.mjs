// 設備名規則（和後台一致）、設備列表與認得的電腦的對應、列表每列的按鈕
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NAME_RULE_HINT, deviceNameError, joinKnown, shortFp } from '../ui/lib/device-known.mjs'

const U = n => String.fromCharCode(n)

test('deviceNameError：合規的名字回空字串', () => {
  for (const n of ['Oppo 手機', '  手機  ', 'abc 1234', 'a'.repeat(40), 'Facade Bedded', '30家用', 'aaaaaaaa']) assert.equal(deviceNameError(n), '', JSON.stringify(n))
})

test('deviceNameError：不合規回規則提示（含 8 碼日期／電話，預期被擋）', () => {
  const bad = ['', '   ', 'a'.repeat(41), 'a\nb', 'a' + U(0x200b) + 'b', 'a' + U(0x202e) + 'b', U(0xfeff) + 'abc', 'Oppo（指紋 12d01662）', '指紋', '12d01662', 'x DEAD1EEF', '81be 4164', '81be' + U(0x3000) + '4164', '20261112', 'aaaaaaaa1', 'a81be 4164', 'Pixel 8a1b2c3d4']
  for (const n of bad) assert.equal(deviceNameError(n), NAME_RULE_HINT, JSON.stringify(n))
  assert.equal(NAME_RULE_HINT, '名字不合規則：1～40 字，不能含「指紋」兩個字，也不能像指紋（8 個英數字連在一起，或 4 碼＋空白＋4 碼）')
})

test('joinKnown：列的 key＝紀錄的 node；不在列表（含已移除）裡的是舊紀錄', () => {
  const devs = [{ key: 'A' }, { key: 'B' }], removed = [{ key: 'R' }]
  const peers = [{ node: 'B' }, { node: 'R' }, { node: 'Z' }, { node: '' }, null]
  const j = joinKnown(devs, removed, peers)
  assert.deepEqual(Object.keys(j.byNode).sort(), ['B', 'R', 'Z'])
  assert.deepEqual(j.old.map(p => p.node), ['Z'])
  assert.deepEqual(joinKnown(undefined, undefined, undefined), { byNode: {}, old: [] })
})

test('shortFp：前 8 字，4 個一組', () => {
  assert.equal(shortFp('81be41640123abcd'), '81be 4164')
  assert.equal(shortFp(''), '')
})

test('守門：設備列表每列只有 4 個按鈕（上移／下移／帳號／詳情），電腦版畫面沒有「已確認／未確認」', () => {
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const li = panel.slice(panel.indexOf('<li v-for="d in devs"'), panel.indexOf('</li>', panel.indexOf('<li v-for="d in devs"')))
  const btns = [...li.matchAll(/<button[\s\S]*?<\/button>/g)].map(m => m[0].replace(/<[^>]+>/g, '').replace(/\{\{\s*DEVICE_TEXT\.(\w+)\s*\}\}/, '$1'))
  assert.deepEqual(btns, ['moveUp', 'moveDown', '帳號', '詳情'])
  assert.ok(li.includes('DEVICE_TEXT.moveUp') && li.includes('DEVICE_TEXT.moveDown'))
  assert.doesNotMatch(panel, /已確認|未確認/)
  assert.ok(li.includes('shortFp(joined.byNode[d.key].fingerprint)') && li.includes('d.phone'))
})

test('守門：檔案裡沒有看不見的字元（零寬、雙向）直接寫進來', () => {
  const s = fs.readFileSync(new URL('../ui/lib/device-known.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(s, /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/)
})
