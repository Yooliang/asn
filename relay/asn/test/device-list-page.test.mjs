// 「設備與帳號」改成「設備列表 → 細部頁」（10-25）：共用邏輯（device-order）、電腦版設定頁、手機「選項」頁、永久移除與自動解除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
// 共用元件的插槽會在輸出裡留下片段標記（<!--[-->、<!--]-->），比對畫面文字前先拿掉
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
import {
  DEVICE_TEXT, canRemoveRow, deviceFieldsFromSaved, deviceFieldsToSave, dropAfter, dropSlot, isDeviceRemoved, moveDevice, pruneRemoved,
  removeDevice, reorderDevice, restoreDevice, visibleRows,
} from '../ui/lib/device-order.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { deviceTabs } from '../ui/lib/tabs.mjs'
import { pageTabs } from '../ui/lib/dims.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const F = (node, device, nick, status = 'online', extra = {}) => ({ id: `${node}/${nick}`, node, device, nick, status, unread: 0, archived: false, kind: 'pc', engine: 'claude', ...extra })

// ---------- 共用邏輯：永久移除 ----------
test('舊存檔沒有 deviceRemoved＝空陣列；存檔後原樣還原；壞值當沒有', () => {
  assert.deepEqual(deviceFieldsFromSaved({ deviceOrder: ['A'] }).deviceRemoved, [])
  assert.deepEqual(deviceFieldsFromSaved({ deviceRemoved: 'x' }).deviceRemoved, [])
  const saved = JSON.parse(JSON.stringify(deviceFieldsToSave({ deviceRemoved: ['R', 'R', 'S'] })))
  assert.deepEqual(saved.deviceRemoved, ['R', 'S'])
  assert.deepEqual(deviceFieldsFromSaved(saved).deviceRemoved, ['R', 'S'])
})

test('removeDevice／restoreDevice：本機不能移除；重複不重複加；恢復拿掉', () => {
  assert.deepEqual(removeDevice([], 'A', { selfNode: 'H' }), ['A'])
  assert.deepEqual(removeDevice(['A'], 'A', { selfNode: 'H' }), ['A'])
  assert.deepEqual(removeDevice(['A'], 'H', { selfNode: 'H' }), ['A'], '本機不可移除')
  assert.deepEqual(removeDevice(['A'], '', { selfNode: 'H' }), ['A'])
  assert.deepEqual(restoreDevice(['A', 'B'], 'A'), ['B'])
  assert.equal(isDeviceRemoved('H', ['H'], { selfNode: 'H' }), false, '本機就算被寫進去也不算移除')
  assert.equal(isDeviceRemoved('A', ['A'], { selfNode: 'H' }), true)
})

test('自動解除：移除後又有在線視窗（ASN 視窗也算）才從名單拿掉；仍離線（有沒有未讀都一樣）就維持', () => {
  const off = [F('A', 'A機', 'a', 'offline', { archived: true })]
  assert.deepEqual(pruneRemoved(['A'], off, { selfNode: 'H' }), ['A'], '還是離線＝維持移除')
  assert.deepEqual(pruneRemoved(['A'], [F('A', 'A機', 'a', 'online')], { selfNode: 'H' }), [], '有在線視窗＝活過來')
  assert.deepEqual(pruneRemoved(['A'], [F('A', 'A機', 'asn', 'online', { engine: 'asn' })], { selfNode: 'H' }), [], 'ASN 視窗上線也算')
  assert.deepEqual(pruneRemoved(['A'], [F('A', 'A機', 'a', 'offline', { unread: 2 })], { selfNode: 'H' }), ['A'], '離線但有舊未讀＝仍維持移除')
  assert.deepEqual(pruneRemoved(['A', 'B'], [F('B', 'B機', 'b', 'busy')], { selfNode: 'H' }), ['A'], '只解除活過來的那台')
  assert.deepEqual(pruneRemoved(['H', 'A'], [], { selfNode: 'H' }), ['A'], '本機不會留在名單裡')
  assert.deepEqual(pruneRemoved(['A'], [], { selfNode: 'H' }), ['A'], '名單還沒載入＝不解除')
})

test('別台、離線的設備都能永久移除（不必先被自動隱藏）；本機、在線的、已移除的不能', () => {
  assert.equal(canRemoveRow({ self: false, online: false, hidden: true }), true)
  assert.equal(canRemoveRow({ self: false, online: false, hidden: false }), true, '還有夥伴或未讀、沒被自動隱藏的離線設備也能移除')
  assert.equal(canRemoveRow({ self: true, online: false, hidden: true }), false)
  assert.equal(canRemoveRow({ self: false, online: true, hidden: false }), false)
  assert.equal(canRemoveRow({ self: false, online: false, hidden: true, removed: true }), false)
  assert.equal(canRemoveRow(null), false)
})

test('文字：二次確認寫明對話與帳號資料不會被刪除；已移除的設備（N）', () => {
  assert.equal(DEVICE_TEXT.confirmRemove('舊電腦'), '確定永久移除「舊電腦」嗎？它的對話與帳號資料不會被刪除，只是不再顯示。')
  assert.equal(DEVICE_TEXT.removedTitle(3), '已移除的設備（3）')
  assert.equal(DEVICE_TEXT.detail, '詳情'); assert.equal(DEVICE_TEXT.forget, '忘記')
  assert.ok(!('moveUp' in DEVICE_TEXT) && !('moveDown' in DEVICE_TEXT), '沒有上移／下移')
  assert.equal(DEVICE_TEXT.showBack, '顯示回名單'); assert.equal(DEVICE_TEXT.remove, '永久移除'); assert.equal(DEVICE_TEXT.back, '返回')
})

// ---------- 共用邏輯：各處列表都排除被移除的 ----------
const S = 'S', A = 'A', B = 'B'
const friends = [F(S, '家用機', 's'), F(A, '舊電腦', 'a', 'offline', { archived: true }), F(B, '工作機', 'b')]
test('左邊頁籤、設定列表、手機三處：被移除的設備都不見；沒移除時全都在（含已隱藏的）', () => {
  const tabs = deviceTabs(friends, { selfNode: S, nodeOrder: [A, B], removed: [A] })
  assert.deepEqual([...tabs.all, ...tabs.hidden].map(t => t.key), [S, B])
  assert.deepEqual(deviceTabs(friends, { selfNode: S, nodeOrder: [A, B] }).hidden.map(t => t.key), [A], '沒移除＝A 是自動隱藏')
  assert.deepEqual(pageTabs(friends, 'device', { selfNode: S, nodeOrder: [A, B], removed: [A] }).hidden, [])
  const tree = buildDeviceTree({ friends, nodeOrder: [A, B], selfNode: S, removed: [A] })
  assert.deepEqual(tree.map(d => [d.key, d.removed, d.hidden]), [[S, false, false], [B, false, false], [A, true, true]])
  assert.deepEqual(visibleRows(tree).map(d => d.key), [S, B]); assert.deepEqual(tree.filter(d => d.removed).map(d => d.key), [A])
  assert.deepEqual(acctDeviceTree({ friends, nodeOrder: [A, B], selfNode: S, removed: [A] }).filter(d => d.removed).map(d => d.key), [A])
  assert.equal(buildDeviceTree({ friends, nodeOrder: [A], selfNode: S, removed: [S] })[0].removed, false, '本機永遠不被移除')
})

test('列表包含被隱藏的設備（不從列表消失），只是標記 hidden', () => {
  const tree = buildDeviceTree({ friends, nodeOrder: [A, B], selfNode: S })
  assert.ok(tree.some(d => d.key === A && d.hidden === true))
})

// ---------- 共用邏輯：排序 ----------
test('順序只用拖曳（或把手上的上下鍵）：不再有上移／下移的判斷函式（#1860）', async () => {
  const mod = await import('../ui/lib/device-order.mjs')
  assert.equal(mod.moveFlags, undefined)
  assert.equal(mod.deviceRowLine({ kindLabel: '手機', online: false }), '手機 · 離線中')
  assert.equal(mod.deviceRowLine({ kindLabel: '電腦', online: true, self: true }), '電腦 · 運作中')
  assert.equal(mod.deviceRowLine({ kindLabel: '手機', online: true, self: true }), '手機 · 運作中')
  assert.equal(mod.deviceRowLine({ kindLabel: '電腦', online: true }), '電腦 · 在線')
})
test('dropAfter／dropSlot：游標在列的上半＝前、下半＝後；落在列外取最近的一端；空列表安全', () => {
  assert.equal(dropAfter(10, 0, 40), false); assert.equal(dropAfter(30, 0, 40), true)
  const rows = [{ key: 'H', top: 0, height: 50 }, { key: 'A', top: 50, height: 50 }, { key: 'B', top: 100, height: 50 }]
  assert.deepEqual(dropSlot(rows, 60), { target: 'A', after: false })
  assert.deepEqual(dropSlot(rows, 140), { target: 'B', after: true })
  assert.deepEqual(dropSlot(rows, -20), { target: 'H', after: false })
  assert.deepEqual(dropSlot(rows, 999), { target: 'B', after: true })
  assert.deepEqual(dropSlot([], 5), { target: '', after: false })
})
test('拖曳→存檔順序：拖 B 到 A 前面；拖到本機上＝排第一；本機不能拖；被移除的設備位置不被打亂', () => {
  assert.deepEqual(reorderDevice([A, B], B, A, false, { selfNode: S }), [B, A])
  assert.deepEqual(reorderDevice([A, B], B, S, false, { selfNode: S }), [B, A])
  assert.deepEqual(reorderDevice([A, B], S, A, false, { selfNode: S }), [A, B])
  assert.deepEqual(moveDevice(['A', 'R', 'B'], 'B', -1, { selfNode: S, visible: ['A', 'B'] }), ['B', 'R', 'A'], '上移跳過被移除的')
})

// ---------- 電腦版設定頁 ----------
const vend = (key, label, accounts) => ({ key, label, account: '', reported: accounts.length > 0, extra: '', accounts, switchable: false, switchHint: '' })
import { withIdentity } from './helpers/with-identity.mjs'
const dev = (key, label, o = {}) => withIdentity({ key, label, self: false, kind: '電腦', online: true, onlineText: '在線', hidden: false, removed: false, reportedText: '', empty: '', vendors: [vend('claude', 'Claude', [{ email: `${key}@b.c`, plan: 'pro', current: true }])], ...o })
const ACCT = { list: [{ email: 'a@b.c', plan: 'Max', current: true, saved: true }], current: { email: 'a@b.c', plan: 'Max', current: true, saved: true }, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, autoAdd: true, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }
const devs = () => [
  dev('H', '家用機', { self: true }), dev('W', '工作機'),
  dev('G', '舊電腦', { online: false, onlineText: '離線', hidden: true }),
  dev('X', '永久移除的機器', { online: false, onlineText: '離線', hidden: true, removed: true }),
]
const render = async (props, state = { devices: devs(), accounts: ACCT }) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state, meAv: '', catKey: 'devices', devView: 'acct', ...props }) }))
}

test('頁首：設定視窗標題已是「設備與帳號」，面板裡不再重複一個標題；說明文字、「重新整理」、「已隱藏的設備」展開區、橫向頁籤都拿掉了', async () => {
  const html = await render({})
  assert.ok(!html.includes('dv-title') && !html.includes('dv-head'), '面板裡沒有重複的標題')
  for (const gone of ['重新整理', '只有 Claude 帳號能從這裡切換', '已隱藏的設備（', 'role="tablist"', 'dv-tabs', 'dv-hidden', '顯示</button>']) assert.ok(!html.includes(gone), `不該還有「${gone}」`)
  assert.ok(!SETTING_OPS.includes('devices-refresh') && !SettingsPanel.template.includes('devices-refresh'))
})

test('進入先看全部設備的列表：由上到下一台一列，名稱＋第二行（類型 · 狀態），右邊直接一顆「詳情」；本機第一列；不是細部內容', async () => {
  const html = await render({})
  const rows = [...html.matchAll(/<li[^>]*class="dv-row[^"]*"[\s\S]*?<\/li>/g)].map(m => m[0])
  assert.equal(rows.length, 3, '列表三台（被永久移除的不在列表）')
  assert.match(rows[0], /家用機[\s\S]*電腦 · 運作中/); assert.ok(!rows[0].includes('這台'), '本機那一列不寫「這台」')
  assert.match(rows[1], /工作機[\s\S]*電腦 · 在線/)
  assert.match(rows[2], /舊電腦[\s\S]*電腦 · 離線中/); assert.ok(!html.includes('離線<'), '離線一律寫「離線中」')
  for (const r of rows) assert.equal((r.match(/<button[^>]*class="asn-btn(?![^"]*dv-grip)/g) ?? []).length, 1, '每列只有一顆文字按鈕（排序把手不算）')
  for (const r of rows) assert.match(r, /<button[^>]*class="asn-btn[^"]*"[^>]*aria-label="查看「[^」]+」的詳情"[^>]*>詳情<\/button>/)
  for (const r of rows) assert.ok(!r.includes('dv-chev') && !r.includes('dv-row-go" type="button"'), '不再整列點擊／右箭頭')
  assert.ok(!html.includes('dv-vendor') && !html.includes('w@b.c'), '列表不含廠商與帳號內容')
  assert.ok(!rows.join('').includes('永久移除的機器'), '被永久移除的不出現在列表（只在「已移除的設備」）')
})

test('列表裡被隱藏的設備：淡色（hid）、標「已隱藏」；本機不可拖（沒有 draggable、沒有上移下移）', async () => {
  const html = await render({})
  const rows = [...html.matchAll(/<li[^>]*class="dv-row[^"]*"[\s\S]*?<\/li>/g)].map(m => m[0])
  assert.match(rows[2], /class="dv-row[^"]*\bhid\b/); assert.match(rows[2], /dv-tag hid[^>]*>已隱藏/)
  assert.doesNotMatch(rows[1], /\bhid\b/)
  assert.ok(!/dv-grip"/.test(rows[0]) && !/draggable="true"/.test(rows[0]), '本機沒有把手')
  assert.match(rows[1], /<button[^>]*class="asn-btn[^"]*dv-grip"[^>]*draggable="true"/); assert.match(rows[1], /aria-label="拖曳調整「工作機」的順序/)
})

test('沒有上移／下移：順序只用把手拖曳；把手聚焦後上下鍵移動一格（送 device-move）', async () => {
  const html = await render({})
  assert.ok(!html.includes('上移') && !html.includes('下移') && !html.includes('設備順序'))
  const t = SettingsPanel.template
  assert.ok(!t.includes("dir: -1 })\">") && !t.includes('DEVICE_TEXT.moveUp'))
  assert.match(t, /@keydown="gripKey\(d\.key, \$event\)"/)
  assert.match(read('ui/lib/settings-panel.mjs'), /act\('device-move', \{ node: key, dir: ev\.key === 'ArrowUp' \? -1 : 1 \}\)/)
})

test('滑鼠拖放與整列點擊：整列 @click 進細部頁（按鈕區不觸發）、dragstart／dragover／drop 送 device-reorder', () => {
  const t = SettingsPanel.template
  assert.ok(!t.includes('onRow') && !/<li[^>]*dv-row[^>]*@click=/.test(t), '整列不再能點，只有按鈕動作')
  assert.match(t, /@dragstart="dragStart\(d\.key, \$event\)"/); assert.match(t, /@drop="drop\(d\.key, \$event\)"/)
  assert.match(read('ui/lib/settings-panel.mjs'), /act\('device-reorder', \{ drag: dragKey\.value, target: key, after: overKey\.value === key && overAfter\.value \}\)/)
  assert.ok(SETTING_OPS.includes('device-reorder') && read('ui/list.js').includes("case 'device-reorder'"))
})

test('進入細部頁（dev 指到那台）：頂部「‹ 返回」＋原本的廠商→帳號內容；列表消失', async () => {
  const html = await render({ dev: 'W' })
  assert.match(html, /class="[^"]*dv-back[^"]*"[^>]*>‹</)
  assert.match(html, /<h3 class="dv-name">工作機<\/h3>/)
  assert.ok(html.includes('dv-vendor') && html.includes('W@b.c'))
  assert.ok(!html.includes('class="dv-list"'))
  assert.ok(SettingsPanel.template.includes('@click="backToList"'))
  assert.ok(!html.includes('顯示回名單') && !html.includes('永久移除'), '沒隱藏的設備沒有這兩個動作')
  assert.ok(!(await render({ dev: 'H' })).includes('永久移除'), '本機沒有隱藏／移除動作')
  assert.ok((await render({ dev: 'zzz' })).includes('class="dv-list"'), '認不得的鍵退回列表')
  assert.ok((await render({ dev: 'X' })).includes('class="dv-list"'), '已移除的設備進不了細部頁')
})

test('被隱藏設備的細部頁：標「已隱藏」，頂部有「顯示回名單」與「永久移除」，廠商與帳號內容仍在', async () => {
  const html = await render({ dev: 'G', devView: 'info' })
  assert.match(html, /dv-tag off[^>]*>已隱藏/)
  assert.match(html, /class="dv-card-act"[\s\S]*>顯示回名單<[\s\S]*>永久移除</)
  assert.ok((await render({ dev: 'G' })).includes('G@b.c'), '帳號頁仍有廠商與帳號')
  assert.ok(SettingsPanel.template.includes("act('device-show', curDev.key)"))
  assert.ok(!html.includes('確定永久移除'), '還沒按永久移除前不顯示確認')
})

test('永久移除要二次確認：確認區寫明對話與帳號資料不會被刪，有「確定移除」「取消」；確定才送 device-remove', async () => {
  const html = await render({ dev: 'G', devView: 'info', askRemove: true })
  assert.ok(html.includes('確定永久移除「舊電腦」嗎？它的對話與帳號資料不會被刪除，只是不再顯示。'))
  assert.match(html, /<div[^>]*class="asn-confirm"[^>]*role="alert"/, '危險確認要讓讀屏念出來'); assert.match(html, /class="asn-confirm"/); assert.match(html, />確定移除</); assert.match(html, />取消</)
  assert.ok(!html.includes('>顯示回名單<'), '確認時收起其他動作')
  const src = read('ui/lib/settings-panel.mjs')
  assert.match(src, /act\('device-remove', k\)/)
  assert.ok(!/@click="act\('device-remove'/.test(SettingsPanel.template), '永久移除不能一鍵直達，必須經過確認')
  assert.match(SettingsPanel.template, /@click="askRemove = true"/)
  assert.ok(SETTING_OPS.includes('device-remove') && read('ui/list.js').includes("case 'device-remove'"))
})

test('電腦版「已移除的設備」一塊：永久移除的給「恢復」（送 device-restore）；舊的「已永久移除」「舊設備紀錄」不再出現', async () => {
  const html = await render({})
  assert.match(html, /<details class="dv-removed"[^>]*>\s*<summary>已移除的設備（1）<\/summary>/)
  assert.match(html, /data-removed="X"[\s\S]*?永久移除的機器[\s\S]*?>恢復<\/button>/)
  assert.ok(!html.includes('已永久移除（') && !html.includes('舊設備紀錄'))
  assert.ok(SETTING_OPS.includes('device-restore') && read('ui/list.js').includes("case 'device-restore'"))
  assert.match(SettingsPanel.template, /act\('device-restore', r\.key\)/)
  assert.ok(!(await render({}, { devices: [dev('H', '家用機', { self: true })], accounts: ACCT })).includes('dv-removed'), '沒有已移除的設備就不畫這一塊')
})

test('設備類型：第二行寫「手機 · 在線」；電腦也寫「電腦」，不再有獨立的類型標籤', async () => {
  const ph = await render({}, { devices: [dev('P', '我的手機', { kind: '手機', kindLabel: '手機' })], accounts: ACCT })
  assert.match(ph, /我的手機[\s\S]*手機 · 在線/)
  assert.ok(!ph.includes('dv-tag kind'))
})

test('電腦版設備列也標「雲端」（和手機同一個 deviceKindLabel）：列表第二行與細部頁都是「雲端」；不是雲端的電腦寫「電腦」', async () => {
  const cloud = dev('C', '雲端機', { kindLabel: '雲端', cloud: true })
  const list = await render({}, { devices: [cloud, dev('D', '桌機', { kindLabel: '電腦' })], accounts: ACCT })
  assert.match(list, /雲端機[\s\S]*雲端 · 在線/); assert.match(list, /桌機[\s\S]*電腦 · 在線/)
  const detail = await render({ dev: 'C' }, { devices: [cloud], accounts: ACCT })
  assert.match(detail, /class="dv-tag kind">雲端</)
  // 資料真的帶 kindLabel：設備樹用 deviceKindLabel 算（雲端節點判斷見 device-kind-label.test.mjs）
  assert.match(read('ui/lib/device-tree.mjs'), /kindLabel: deviceKindLabel\(/)
  assert.match(SettingsPanel.template, /\{\{ curDev\.kindLabel \|\| curDev\.kind \}\}/)
})

test('樞紐：永久移除／恢復寫入 deviceRemoved（本機不可）、活過來自動解除、三處列表都帶 removed', () => {
  const hub = read('ui/list.js')
  assert.match(hub, /devPrefs\.deviceRemoved = removeDevice\(devPrefs\.deviceRemoved, String\(value \?\? ''\), \{ selfNode: info\.node \}\)/)
  assert.match(hub, /pruneRemoved\(devPrefs\.deviceRemoved, friends\.value/)
  assert.match(hub, /pageTabs\([^\n]*removed: devPrefs\.deviceRemoved/)
  assert.match(hub, /removed: devPrefs\.deviceRemoved, selfNode: info\.node, asn:/)
  assert.match(hub, /devices: visibleRows\(deviceTree\.value\)/, '設定分類摘要不算被移除的')
  assert.match(hub, /visible: visibleRows\(deviceTree\.value\)\.map\(d => d\.key\)/, '上移下移跳過被移除的')
})

test('深色模式：新樣式只用主題變數，紅色的「永久移除」有深色版', () => {
  const css = read('ui/style.css')
  const rows = css.split('\n').filter(l => /^\.dv-(row|list|chev|removed|hid-act|confirm)/.test(l)).join('\n')
  assert.ok(rows.length > 400)
  assert.ok(/var\(--panel\)/.test(rows) && /var\(--muted\)/.test(rows) && /var\(--accent\)/.test(rows))
  assert.ok(!/#fff\b|#ffffff|background:\s*white/i.test(rows), '列表底色不寫死白色')
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{\.dv-danger\{color:#ff9a90\}\}/)
})

// ---------- 手機「選項」頁 ----------
test('手機列表：每列右邊直接一顆「詳情」（不展開、沒有上移／下移，#1860），左邊保留排序把手（不拖時不影響捲動）', () => {
  const html = read('ui/m.html'), css = read('ui/mobile.css')
  const pane = /<section class="m-pg m-fourth"[\s\S]*?<!-- \/內頁 -->/.exec(html)[0]
  assert.match(pane, /v-for="d in acctDevs"[\s\S]*?class="m-dv-row"/)
  // 資訊區只是文字，不是按鈕；詳情是每列右邊固定的一顆（#1860）
  assert.doesNotMatch(pane, /class="m-dv-go"|devRowTap|devSel|m-dv-rowbtns/, '不再點一列才展開按鈕')
  assert.doesNotMatch(pane, /DEVICE_TEXT\.moveUp|KNOWN_TEXT\.moveUp|acctMove\(d\.key/, '沒有上移／下移')
  assert.match(pane, /<asn-button fixed class="m-dv-detail" :aria-label="DEVICE_TEXT\.detailLabel\(d\.label\)" @click="openAcctInfo\(d\.key\)">\{\{ DEVICE_TEXT\.detail \}\}<\/asn-button>/)
  assert.doesNotMatch(pane, /class="m-dv-own"|KNOWN_TEXT\.ownNameLabel/, '列表最上面沒有「這支手機的名字」改名區塊')
  assert.match(pane, /class="m-dv-grip"[^>]*v-if="!d\.self"/, '本機沒有把手＝固定第一列不可拖')
  assert.match(pane, /@pointerdown="gripDown\(d\.key, \$event\)"[^>]*@pointermove="gripMove"[^>]*@pointerup="gripUp"[^>]*@pointercancel="gripUp"/)
  assert.match(pane, /@keydown="gripKey\(d\.key, \$event\)"/, '把手聚焦後上下鍵也能移動')
  assert.match(pane, /DEVICE_TEXT\.hiddenTag/); assert.match(pane, /\bhid: d\.hidden\b/)
  assert.match(/\.m-dv-row\{([^}]*)\}/.exec(css)[1], /min-height:\s*56px/)
  assert.match(/\.m-dv-grip\{([^}]*)\}/.exec(css)[1], /touch-action:\s*none/, '只有把手擋住瀏覽器捲動，其餘地方照常捲動')
  assert.match(/\.m-dv-grip\{([^}]*)\}/.exec(css)[1], /width:\s*4\dpx/)
  const gripW = /\.m-dv-grip\{[^}]*width:\s*(\d+)px/.exec(css)[1]
  assert.equal(/\.m-dv-grip-gap\{[^}]*width:\s*(\d+)px/.exec(css)[1], gripW, '「這支手機」左邊的空位和把手同寬，圓點才對齊（#930）')
  assert.ok(!/\.m-dv-list\{[^}]*overflow:\s*hidden/.test(css), '設備列表不能用 overflow:hidden 裁掉列的第三行（#930）')
  assert.match(/\.m-dv-row\.hid\{([^}]*)\}/.exec(css)[1], /opacity/)
  assert.match(read('ui/lib/mobile.mjs'), /SWIPE_BLOCK_SELECTOR = '[^']*\.m-dv-grip/, '拖把手時不能被分頁左右滑手勢搶走')
  for (const gone of ['重新整理', 'refreshAcct', 'm-dv-hidden', '已隱藏的設備（', 'm-dv-tabs']) assert.ok(!pane.includes(gone) && !css.includes(gone === 'm-dv-hidden' ? '.m-dv-hidden' : '@@'), `手機不該還有「${gone}」`)
})

test('手機細部頁：標題列返回鍵先回列表（頁內不再另放「‹ 返回」，#374）；從夥伴列表「選項」進來直接開那一台', () => {
  const html = read('ui/m.html'), js = read('ui/m.js')
  const pane = /<section class="m-pg m-fourth"[\s\S]*?<!-- \/內頁 -->/.exec(html)[0]
  assert.doesNotMatch(pane, /class="m-dv-back"/, '只留標題列那一個返回')
  assert.match(pane, /<button class="m-icon-btn" type="button" aria-label="返回" @click="back">/)
  assert.match(pane, /v-else-if="acctSw\.phase === 'pick'"/)
  assert.match(js, /const acctBackToList = \(\) => back\(\)/, '#461：細部是內頁的一層，「‹ 返回」、標題列返回、系統返回鍵都退一筆記錄')
  assert.match(js, /fourthNav\.pushLayer\(acctPage\(key\), \{ replace: stale \}\)/, '點一台進細部＝多一層')
  assert.match(js, /acctSw\.node = g\.node; acctSw\.page = 'detail'/)
  assert.match(js, /const acctCur = computed\(\(\) => \(acctSw\.page === 'detail' \?/, '細部頁的那台不在了就退回列表')
})

test('手機被隱藏設備：細部頁兩個動作；永久移除走獨立的確認畫面（rm）；確認字與電腦版相同；恢復', () => {
  const html = read('ui/m.html'), js = read('ui/m.js')
  const pane = /<section class="m-pg m-fourth"[\s\S]*?<!-- \/內頁 -->/.exec(html)[0]
  assert.match(pane, /v-if="acctCanShowBack"[\s\S]*?acctShowBack[\s\S]*?DEVICE_TEXT\.showBack[\s\S]*?:disabled="!acctCanRemove" @click="acctAskRemove[\s\S]*?DEVICE_TEXT\.remove/)
  assert.match(pane, /acctSw\.phase === 'rm'[\s\S]*?acctRemoveText[\s\S]*?acctRemoveNow[\s\S]*?DEVICE_TEXT\.removeYes[\s\S]*?DEVICE_TEXT\.cancel/)
  assert.ok(!/@click="acctRemoveNow"/.test(pane.split("phase === 'rm'")[0]), '確認畫面之前沒有直接移除的入口')
  assert.match(js, /acctAskRemove = \(\) => \{ if \(acctSw\.phase === 'pick' && acctCanRemove\.value\) acctSw\.phase = 'rm' \}/)
  assert.match(js, /if \(acctSw\.phase !== 'rm' \|\| !acctCanRemove\.value\) return/, '沒進過確認畫面就移除不了')
  assert.match(js, /removeDevice\(devPrefs\.deviceRemoved, acctCur\.value\.key, \{ selfNode: info\.node \}\)/)
  assert.match(js, /restoreDevice\(devPrefs\.deviceRemoved, key\)/)
  assert.match(js, /DEVICE_TEXT\.confirmRemove\(acctCur\.value\?\.identity\?\.title\)/)
  assert.match(pane, /v-if="removedBlock\.count"[\s\S]*?DEVICE_TEXT\.removedTitle\(removedBlock\.count\)[\s\S]*?acctRestore\(r\.key\)[\s\S]*?forgetKnown\(r\.key\)/)
})

test('手機自動解除與存檔：活過來就解除、舊存檔相容、被移除的設備不再有「選項」入口', () => {
  const js = read('ui/m.js')
  assert.match(js, /pruneRemoved\(devPrefs\.deviceRemoved, friends\.value, \{ selfNode: info\.node \}\)/)
  assert.match(js, /reactive\(\{ deviceOrder: \[\], deviceShown: \[\], deviceRemoved: \[\], deviceRev: 0, deviceSynced: false \}\)/)
  assert.match(js, /Object\.assign\(devPrefs, deviceFieldsFromSaved\(saved\)\)/)
  assert.match(js, /removed: devPrefs\.deviceRemoved, selfNode: info\.node, reports: acctSw\.reports/)
  assert.match(js, /filter\(g => !devPrefs\.deviceRemoved\.includes\(g\.node\)\)/)
  assert.match(js, /moveDevice\(acctOrderKeys\(\), key, dir, \{ selfNode: info\.node, visible: acctVisibleKeys\(\) \}\)/)
  assert.match(js, /reorderDevice\(acctOrderKeys\(\), acctDrag\.key, acctDrag\.over, acctDrag\.after, \{ selfNode: info\.node \}\)/)
})

test('安卓編譯：只動 ui 與 JS，沒有新增 Rust 呼叫給手機', () => {
  const js = read('ui/m.js')
  assert.ok(!/invoke\('(device|dev)_/.test(js))
  assert.deepEqual([...js.matchAll(/invoke\('([a-z_]+)'/g)].map(m => m[1]).filter(n => /remov|restor|device_order/.test(n)), [])
})

test('細部頁：離線但沒被自動隱藏的設備（還有夥伴或未讀）也有「永久移除」，沒有「顯示回名單」；在線的設備沒有', async () => {
  const off = await render({ dev: 'X', devView: 'info' }, { devices: [dev('X', '未命名設備', { online: false, onlineText: '離線', hidden: false })], accounts: ACCT })
  assert.ok(off.includes('>永久移除<') && !off.includes('>顯示回名單<'))
  const on = await render({ dev: 'X', devView: 'info' }, { devices: [dev('X', '在線機', { online: true, hidden: false })], accounts: ACCT })
  assert.match(on, /<button[^>]*class="asn-btn lv-secondary st-danger"[^>]*disabled[^>]*>永久移除</, '在線的不能移除：按鈕變灰')
  assert.ok(on.includes('設備在線時不能移除，離線後才能移除'), '變灰要說明原因')
})
