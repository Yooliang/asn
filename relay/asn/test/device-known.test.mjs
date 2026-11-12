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

test('joinKnown：列的 key＝紀錄的 node；不在畫面列表裡的（含已永久移除的設備）是舊紀錄，才有地方取消授權或忘記', () => {
  const devs = [{ key: 'A' }, { key: 'B' }]
  const peers = [{ node: 'B' }, { node: 'R' }, { node: 'Z' }, { node: '' }, null]
  const j = joinKnown(devs, peers)
  assert.deepEqual(Object.keys(j.byNode).sort(), ['B', 'R', 'Z'])
  assert.deepEqual(j.old.map(p => p.node), ['R', 'Z'])
  assert.deepEqual(joinKnown(undefined, undefined), { byNode: {}, old: [] })
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(panel, /joinKnown\(devs\.value, peers\.value\)/, '只傳畫面上的列，不傳已移除的')
  assert.match(panel, /return devs\.value\.length \? j : \{ \.\.\.j, old: \[\] \}/, '名單還沒讀到不全歸舊紀錄')
})

test('「允許替這台登入」：是手機、或已經勾過（不論是不是手機）都要顯示，勾過的一定取消得掉', () => {
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(panel, /<template v-if="curDev\.phone \|\| curKnown\.loginOk">\s*<label class="chk"><input type="checkbox" :checked="curKnown\.loginOk"/)
})

test('改名失敗：錯誤顯示在名字下面，開始改名與取消時清掉；重讀名單失敗不算改名失敗', () => {
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(panel, /st\.known\.renameError/)
  assert.match(panel, /renameCancel = \(\) => \{[^}]*act\('device-rename-clear'\)/)
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const fn = list.slice(list.indexOf('async function renameDevice('), list.indexOf('async function forgetKnown('))
  assert.ok(fn.indexOf("invoke('device_rename'") < fn.indexOf('return null') && fn.indexOf('return null') < fn.indexOf('core.refreshRoster()'), '重讀名單在改名成功之後、另外接錯誤')
  assert.match(list, /watch\(selfDeviceName, n => \{ if \(!nickFocus\.value\) nickText\.value = n \}\)/, '輸入中不被名單刷新蓋掉')
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

test('詳情的兩個勾選框：送出後把勾選狀態還原成目前的值（按「先不要」不殘留打勾，#1367）', () => {
  const src = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(src, /act\('known-login-ok', \{ node: curKnown\.id, on: \$event\.target\.checked \}\); \$event\.target\.checked = curKnown\.loginOk"/)
  assert.match(src, /act\('known-input-no-ask', \{ node: curKnown\.id, on: \$event\.target\.checked \}\); \$event\.target\.checked = curKnown\.inputNoAsk"/)
  assert.doesNotMatch(src, /act\('known-login-ok', \{[^}]*\}\)"/, '每一顆允許登入的勾選框都要還原')
})

test('顯示用名字：像指紋或含「指紋」的當成沒有名字（設備列表、認得的電腦都套）', async () => {
  const { displayDeviceName } = await import('../ui/lib/device-known.mjs')
  for (const [n, want] of [['工作機', '工作機'], ['  Oppo 手機 ', 'Oppo 手機'], ['aaaaaaaa', 'aaaaaaaa'], ['12d01662', ''], ['我的指紋', ''], ['81be 4164', ''], ['', '']]) assert.equal(displayDeviceName(n), want, n)
  const { normalizeView } = await import('../ui/lib/known-peers.mjs')
  assert.equal(normalizeView({ peers: [{ node: 'pc', name: '工作機 a93cc519', fingerprint: 'a93cc519' }] }).peers[0].label, '未命名的電腦')
  const tree = fs.readFileSync(new URL('../ui/lib/device-tree.mjs', import.meta.url), 'utf8')
  assert.match(tree, /const named = displayDeviceName\(/)
})
