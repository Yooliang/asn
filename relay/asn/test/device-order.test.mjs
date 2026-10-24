// 設備頁籤的手動排序與自動隱藏（純邏輯）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyDeviceOrder, deviceFieldsFromSaved, deviceFieldsToSave, hiddenDeviceNodes, isDeviceHidden, moveDevice, normalizeKeys, reorderDevice, showDevice } from '../ui/lib/device-order.mjs'
import { deviceTabs } from '../ui/lib/tabs.mjs'
import { pageTabs } from '../ui/lib/dims.mjs'
import { launchDeviceRows } from '../ui/lib/partner-launch-ui.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'

const F = (node, device, nick, status = 'online', extra = {}) => ({ id: `${node}/${nick}`, node, device, nick, status, unread: 0, archived: false, ...extra })
const keys = rows => rows.map(r => r.key)
const R = (...ks) => ks.map(key => ({ key }))

// ---------- 排序合併 ----------
test('applyDeviceOrder：沒有手動順序＝維持自動順序', () => {
  assert.deepEqual(keys(applyDeviceOrder(R('H', 'A', 'B'), { selfNode: 'H', deviceOrder: [] })), ['H', 'A', 'B'])
})
test('applyDeviceOrder：手動排過的在前，新設備與沒排過的接在後面維持自動順序', () => {
  const out = applyDeviceOrder(R('H', 'A', 'B', 'C', 'D'), { selfNode: 'H', deviceOrder: ['C', 'A'] })
  assert.deepEqual(keys(out), ['H', 'C', 'A', 'B', 'D'])
})
test('applyDeviceOrder：本機永遠第一，就算手動順序把它排在中間；順序裡已不存在的設備略過', () => {
  const out = applyDeviceOrder(R('H', 'A', 'B'), { selfNode: 'H', deviceOrder: ['B', 'H', 'GONE', 'A'] })
  assert.deepEqual(keys(out), ['H', 'B', 'A'])
})
test('applyDeviceOrder：本機不在列內時不會憑空多出來', () => {
  assert.deepEqual(keys(applyDeviceOrder(R('A', 'B'), { selfNode: 'H', deviceOrder: ['B'] })), ['B', 'A'])
})

// ---------- 舊存檔相容與儲存還原 ----------
test('舊存檔沒有 deviceOrder／deviceShown＝空陣列；壞值也當沒有', () => {
  assert.deepEqual(deviceFieldsFromSaved({}), { deviceOrder: [], deviceShown: [] })
  assert.deepEqual(deviceFieldsFromSaved(undefined), { deviceOrder: [], deviceShown: [] })
  assert.deepEqual(deviceFieldsFromSaved({ deviceOrder: 'x', deviceShown: { a: 1 } }), { deviceOrder: [], deviceShown: [] })
  assert.deepEqual(normalizeKeys(['a', '', 'a', 3, null, 'b']), ['a', 'b'])
})
test('順序存檔後可原樣還原', () => {
  const saved = JSON.parse(JSON.stringify(deviceFieldsToSave({ deviceOrder: ['B', 'A'], deviceShown: ['Z'] })))
  assert.deepEqual(saved, { deviceOrder: ['B', 'A'], deviceShown: ['Z'] })
  assert.deepEqual(deviceFieldsFromSaved(saved), { deviceOrder: ['B', 'A'], deviceShown: ['Z'] })
})
test('沒排過時 deviceTabs 結果與原規則完全一樣（本機第一、有人在線在前）', () => {
  const friends = [F('W', '工作機', 'a', 'offline'), F('H', '家用機', 'b'), F('A', '牧陽', 'c')]
  const base = deviceTabs(friends, { selfNode: 'H', nodeOrder: ['W', 'H', 'A'] })
  const withEmpty = deviceTabs(friends, { selfNode: 'H', nodeOrder: ['W', 'H', 'A'], deviceOrder: [], shown: [] })
  assert.deepEqual(keys(base.all), ['H', 'A', 'W'])
  assert.deepEqual(withEmpty, base)
})
test('deviceTabs：手動順序蓋過自動規則，新設備接在已排序設備之後', () => {
  const friends = [F('H', '家', 'h'), F('A', 'A機', 'a'), F('B', 'B機', 'b', 'offline'), F('N', '新機', 'n')]
  const t = deviceTabs(friends, { selfNode: 'H', nodeOrder: ['A', 'B', 'N'], deviceOrder: ['B', 'A'] })
  assert.deepEqual(keys(t.all), ['H', 'B', 'A', 'N'])
})
test('launchDeviceRows 與 buildDeviceTree 套用同一份手動順序', () => {
  const friends = [F('H', '家', 'h'), F('A', 'A機', 'a'), F('B', 'B機', 'b')]
  assert.deepEqual(keys(launchDeviceRows(friends, { selfNode: 'H', nodeOrder: ['A', 'B'], deviceOrder: ['B', 'A'] })), ['H', 'B', 'A'])
  assert.deepEqual(buildDeviceTree({ friends, nodeOrder: ['A', 'B'], selfNode: 'H', deviceOrder: ['B', 'A'] }).map(d => d.key), ['H', 'B', 'A'])
})

// ---------- 移動 ----------
test('moveDevice：上移／下移與邊界；本機不能動、也不能被超過', () => {
  const full = ['A', 'B', 'C']
  assert.deepEqual(moveDevice(full, 'B', -1, { selfNode: 'H' }), ['B', 'A', 'C'])
  assert.deepEqual(moveDevice(full, 'B', 1, { selfNode: 'H' }), ['A', 'C', 'B'])
  assert.deepEqual(moveDevice(full, 'A', -1, { selfNode: 'H' }), full)
  assert.deepEqual(moveDevice(full, 'C', 1, { selfNode: 'H' }), full)
  assert.deepEqual(moveDevice(['H', 'A', 'B'], 'H', 1, { selfNode: 'H' }), ['A', 'B'])
  assert.deepEqual(moveDevice(full, 'ZZ', 1, { selfNode: 'H' }), full)
})
test('moveDevice：跳過看不到的（隱藏的）設備，隱藏設備的相對位置不變', () => {
  assert.deepEqual(moveDevice(['A', 'X', 'B'], 'B', -1, { selfNode: 'H', visible: ['A', 'B'] }), ['B', 'X', 'A'])
})
test('reorderDevice：拖到某頁籤前／後；拖到本機＝排到第一；拖自己或本機不變', () => {
  const full = ['A', 'B', 'C']
  assert.deepEqual(reorderDevice(full, 'C', 'A', false, { selfNode: 'H' }), ['C', 'A', 'B'])
  assert.deepEqual(reorderDevice(full, 'A', 'C', true, { selfNode: 'H' }), ['B', 'C', 'A'])
  assert.deepEqual(reorderDevice(full, 'C', 'H', true, { selfNode: 'H' }), ['C', 'A', 'B'])
  assert.deepEqual(reorderDevice(full, 'H', 'A', false, { selfNode: 'H' }), full)
  assert.deepEqual(reorderDevice(full, 'A', 'A', false, { selfNode: 'H' }), full)
})

// ---------- 隱藏條件：每個分支 ----------
const gone = (extra = {}) => [F('A', 'A機', 'x', 'offline', { archived: true, ...extra })]
test('隱藏：非本機、整台離線、夥伴全封存、沒未讀＝隱藏', () => {
  assert.equal(isDeviceHidden('A', gone(), { selfNode: 'H' }), true)
})
test('不隱藏：本機', () => {
  assert.equal(isDeviceHidden('H', [F('H', '家', 'x', 'offline', { archived: true })], { selfNode: 'H' }), false)
})
test('不隱藏：有在線視窗（含忙碌、暫離、ASN 視窗在線）', () => {
  for (const st of ['online', 'busy', 'away']) assert.equal(isDeviceHidden('A', [...gone(), F('A', 'A機', 'y', st, { archived: true })], { selfNode: 'H' }), false, st)
  assert.equal(isDeviceHidden('A', [...gone(), F('A', 'A機', 'asn', 'online', { engine: 'asn', archived: false })], { selfNode: 'H' }), false)
})
test('不隱藏：還有未封存的夥伴（即使離線）', () => {
  assert.equal(isDeviceHidden('A', [...gone(), F('A', 'A機', 'y', 'offline')], { selfNode: 'H' }), false)
})
test('不隱藏：有未讀（即使全封存、全離線）', () => {
  assert.equal(isDeviceHidden('A', gone({ unread: 2 }), { selfNode: 'H' }), false)
})
test('離線的 ASN 視窗不算未封存夥伴，不擋隱藏', () => {
  assert.equal(isDeviceHidden('A', [...gone(), F('A', 'A機', 'asn', 'offline', { engine: 'asn' })], { selfNode: 'H' }), true)
})
test('手動顯示過的設備不隱藏；showDevice 加入、已在就不重複', () => {
  assert.equal(isDeviceHidden('A', gone(), { selfNode: 'H', shown: ['A'] }), false)
  assert.deepEqual(showDevice(['A'], 'A'), ['A'])
  assert.deepEqual(showDevice([], 'A'), ['A'])
})
test('hiddenDeviceNodes：回傳被隱藏的節點', () => {
  const friends = [F('H', '家', 'h'), ...gone(), F('B', 'B機', 'b')]
  assert.deepEqual(hiddenDeviceNodes(friends, ['H', 'A', 'B'], { selfNode: 'H' }), ['A'])
})

// ---------- 套進頁籤 ----------
test('deviceTabs／pageTabs：隱藏的設備不在 all／visible／more，另列在 hidden；顯示後回來', () => {
  const friends = [F('H', '家', 'h'), ...gone(), F('B', 'B機', 'b')]
  const opt = { selfNode: 'H', nodeOrder: ['A', 'B'] }
  const t = deviceTabs(friends, opt)
  assert.deepEqual(keys(t.all), ['H', 'B'])
  assert.deepEqual(keys(t.hidden), ['A'])
  const p = pageTabs(friends, 'device', opt)
  assert.deepEqual(keys(p.all), ['H', 'B'])
  assert.deepEqual(keys(p.hidden), ['A'])
  assert.deepEqual(keys(deviceTabs(friends, { ...opt, shown: ['A'] }).all), ['H', 'B', 'A'])
  assert.deepEqual(pageTabs(friends, 'status', opt).hidden ?? [], [])
})
test('隱藏的設備不占用「更多」的名額', () => {
  const friends = [F('H', '家', 'h')]
  const nodes = []
  for (let i = 1; i <= 6; i++) { friends.push(F(`n${i}`, `機${i}`, `x${i}`)); nodes.push(`n${i}`) }
  friends.push(F('hid', '舊機', 'z', 'offline', { archived: true }))
  const t = deviceTabs(friends, { selfNode: 'H', nodeOrder: [...nodes, 'hid'] })
  assert.equal(t.all.length, 7)
  assert.equal(t.more.length, 2)
})
test('buildDeviceTree：隱藏旗標（設定頁保留該設備，只標記）', () => {
  const friends = [F('H', '家', 'h'), ...gone()]
  const tree = buildDeviceTree({ friends, nodeOrder: ['A'], selfNode: 'H' })
  assert.deepEqual(tree.map(d => [d.key, d.hidden]), [['H', false], ['A', true]])
  assert.equal(buildDeviceTree({ friends, nodeOrder: ['A'], selfNode: 'H', shown: ['A'] })[1].hidden, false)
})

// ---------- 接線守門 ----------
test('接線：list.js 讀寫 deviceOrder／deviceShown 並傳進頁籤與設備樹', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /deviceFieldsFromSaved\(savedMe\)/)
  assert.match(js, /deviceFieldsToSave\(/)
  assert.match(js, /deviceOrder: devPrefs\.deviceOrder/)
})
test('接線：設定頁有上移／下移與已隱藏的設備', () => {
  const s = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(s, /device-move/)
  assert.match(s, /device-show/)
  assert.match(s, /已隱藏的設備/)
})
test('接線：左邊頁籤可拖曳並支援 Alt+上下', () => {
  const h = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(h, /@dragstart="onDeviceDragStart/)
  assert.match(h, /@keydown="onDeviceTabKey/)
})
