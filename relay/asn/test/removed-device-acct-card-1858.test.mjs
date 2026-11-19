// #1858：永久移除的設備不能還出現在帳號卡上（設定 → 帳號每張卡下的設備按鈕）。
// 設備頁、分頁、開新夥伴都走 isDeviceRemoved；帳號卡的設備按鈕（電腦設定頁與手機帳號頁共用 deviceButtons）也要走同一份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deviceButtons } from '../ui/lib/account-roster.mjs'
import { isDeviceRemoved } from '../ui/lib/device-order.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')

// 後台回報「用過這個帳號的設備」：本機 S、電腦 A、電腦 B（B 已在設備頁永久移除）
const usedOn = [{ node: 'S', label: '本機', current: true }, { node: 'A', label: '電腦甲' }, { node: 'B', label: '電腦乙' }]
const targets = [{ node: 'A', name: '電腦甲', enabled: true }, { node: 'B', name: '電腦乙', enabled: true }]

test('#1858 帳號卡的設備按鈕：永久移除的設備不出現；沒移除時照舊', () => {
  const none = deviceButtons(usedOn, targets, 'S', () => '', [])
  assert.deepEqual(none.map(b => b.node), ['S', 'A', 'B'], '沒有移除任何設備時三台都在')
  const out = deviceButtons(usedOn, targets, 'S', () => '', ['B'])
  assert.deepEqual(out.map(b => b.node), ['S', 'A'], '永久移除的 B 不能再有按鈕')
  assert.equal(out.find(b => b.node === 'A').target?.node, 'A', '其他設備的切換目標照舊')
})

test('#1858 移除的設備只在「切換目標」裡出現（後台還沒回報用過）也不能補成按鈕', () => {
  const out = deviceButtons([{ node: 'S', current: true }], targets, 'S', () => '', ['B'])
  assert.deepEqual(out.map(b => b.node), ['S', 'A'])
})

test('#1858 本機永遠不算移除（跟設備頁同一份判斷：清單裡寫了本機也不理）', () => {
  assert.equal(isDeviceRemoved('S', ['S'], { selfNode: 'S' }), false)
  const out = deviceButtons(usedOn, targets, 'S', () => '', ['S', 'B'])
  assert.ok(out.some(b => b.node === 'S'), '本機的按鈕還在')
  assert.ok(!out.some(b => b.node === 'B'))
})

test('#1858 沒帶清單（舊呼叫方式）等於沒有移除：不報錯、照舊顯示', () => {
  assert.deepEqual(deviceButtons(usedOn, targets, 'S').map(b => b.node), ['S', 'A', 'B'])
})

test('#1858 守門：電腦設定頁與手機帳號頁都把「永久移除清單」交給 deviceButtons（兩邊一份邏輯）', () => {
  const panel = read('ui/lib/settings-panel.mjs'), list = read('ui/list.js'), m = read('ui/m.js')
  assert.match(panel, /deviceButtons\([^\n]*props\.st\.deviceRemoved\)/, '電腦：帳號卡的設備按鈕要帶移除清單')
  assert.match(list, /deviceRemoved: devPrefs\.deviceRemoved/, '電腦：設定頁的狀態要帶 deviceRemoved')
  assert.match(m, /const acctDevButtons = [^\n]*deviceButtons\([^\n]*devPrefs\.deviceRemoved\)/, '手機：帳號卡的設備按鈕要帶移除清單')
})
