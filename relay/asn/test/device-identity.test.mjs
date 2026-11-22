// #1829 設備詳情頁要看得出是哪一台：建立時間、平台、最後在線、代號末 4 碼；名字空白時用辨認線索；下面有「改名」「移除」。
// 電腦版設定頁與手機設備頁共用 lib/device-identity.mjs（一份文字、一份整理資料的規則、一個元件）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
// 共用元件的插槽會在輸出裡留下片段標記（<!--[-->、<!--]-->），比對畫面文字前先拿掉
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { nodeFactsOf } from '../ui/lib/device-known.mjs'
import { canShowBackRow } from '../ui/lib/device-order.mjs'
import { deviceTabs } from '../ui/lib/tabs.mjs'
import { groupItems } from '../ui/lib/dims.mjs'
import { groupByDevice } from '../ui/lib/roster.mjs'
import { nodeLabelOf } from '../ui/lib/account-roster.mjs'
import { launchDevices } from '../ui/lib/mobile-launch.mjs'
import { deviceIdentity, nodeTail, unnamedClue, IDENTITY_TEXT } from '../ui/lib/device-identity.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-11-19T12:00:00+08:00')
// 後台名單（asn_relay_list）每個成員的樣子：名字空白（或不合格）、有 created_at／last_seen_at
const MEMBERS = [
  { id: 'node-self-A1B2', name: '家用機', kind: 'claude', machine: 'H', online: true, last_seen_at: new Date(NOW - 30_000).toISOString(), created_at: '2026-10-01T08:00:00Z' },
  { id: 'node-old-pc-X7K2', name: '', kind: 'claude', machine: 'W', online: false, last_seen_at: new Date(NOW - 3 * 3600_000).toISOString(), created_at: '2026-11-05T06:32:00Z' },
  { id: 'node-fp-name-Q9Z8', name: '3fa2c91b', kind: 'claude', machine: 'F', online: false, last_seen_at: null },
]
const friends = MEMBERS.map(m => ({ id: `${m.id}/a`, node: m.id, status: m.id === 'node-self-A1B2' ? 'idle' : 'offline', kind: 'claude', agent: 'a', unread: 1 }))
const tree = (extra = {}) => buildDeviceTree({ friends, nodeNames: { 'node-self-A1B2': '家用機' }, nodeFacts: nodeFactsOf(MEMBERS), selfNode: 'node-self-A1B2', nodeOrder: MEMBERS.map(m => m.id), machines: { 'node-old-pc-X7K2': { platform: 'windows' }, 'node-fp-name-Q9Z8': { platform: 'android' } }, now: NOW, ...extra })
const rowOf = (rows, k) => rows.find(r => r.key === k)

test('#1829 名單成員帶的建立時間、最後在線讀成毫秒；壞掉的當沒有', () => {
  const f = nodeFactsOf(MEMBERS)
  assert.equal(f['node-old-pc-X7K2'].createdMs, Date.parse('2026-11-05T06:32:00Z'))
  assert.equal(f['node-old-pc-X7K2'].seenMs, NOW - 3 * 3600_000)
  assert.equal(f['node-fp-name-Q9Z8'], undefined, '兩個都沒有就不放')
  assert.deepEqual(nodeFactsOf([{ id: 'x', created_at: 'not-a-date', last_seen_at: {} }]), {})
})

test('#1829 名字空白時，標題是「種類（代號末 4 碼）」，不是「未命名設備」', () => {
  const rows = tree()
  const r = rowOf(rows, 'node-old-pc-X7K2')
  assert.equal(r.named, false)
  assert.equal(r.identity.title, '電腦（X7K2）')
  assert.ok(!r.identity.title.includes('未命名'))
  assert.equal(rowOf(rows, 'node-fp-name-Q9Z8').identity.title, '手機（Q9Z8）', '名字像指紋＝不合格，同樣用線索')
  assert.equal(rowOf(rows, 'node-self-A1B2').identity.title, '家用機', '有名字就用名字')
  assert.equal(nodeTail('a-b_c'), 'ABC')
  assert.equal(unnamedClue({ node: 'zz12' }), '電腦（ZZ12）')
})

test('#1829 辨認區四列：建立時間、平台、最後在線、代號；後台沒給建立時間就整列不放，最後在線沒有紀錄寫「沒有紀錄」', () => {
  const r = rowOf(tree(), 'node-old-pc-X7K2').identity
  const by = Object.fromEntries(r.rows.map(x => [x.key, x]))
  assert.deepEqual(r.rows.map(x => x.label), [IDENTITY_TEXT.created, IDENTITY_TEXT.platform, IDENTITY_TEXT.seen, IDENTITY_TEXT.code])
  assert.match(by.created.value, /^2026\/11\/05 \d\d:\d\d$/)
  assert.equal(by.platform.value, 'Windows')
  assert.match(by.seen.value, /^2026\/11\/19 \d\d:\d\d（3 小時前）$/)
  assert.equal(by.code.value, 'X7K2')
  const none = rowOf(tree(), 'node-fp-name-Q9Z8').identity
  assert.ok(!none.rows.some(x => x.key === 'created'), '沒有建立時間就整列不放')
  assert.equal(none.rows.find(x => x.key === 'seen').value, '沒有紀錄')
  assert.equal(rowOf(tree(), 'node-self-A1B2').identity.rows.find(x => x.key === 'seen').value, '現在在線', '本機一律在線')
})

test('#1829 辨認區在手機版的設備樹也一樣（同一個函式算的）', () => {
  const m = acctDeviceTree({ friends, nodeNames: {}, nodeFacts: nodeFactsOf(MEMBERS), selfNode: 'node-self-A1B2', nodeOrder: MEMBERS.map(x => x.id), launchers: { 'node-old-pc-X7K2': { platform: 'windows' } }, now: NOW })
  assert.deepEqual(rowOf(m, 'node-old-pc-X7K2').identity, rowOf(tree(), 'node-old-pc-X7K2').identity)
})

const render = async (devices, props) => {
  globalThis.Vue = Vue
  const st = { version: '0.2.35', devices, accounts: { list: [], current: null, msg: '', autoNote: '', busy: false, confirmDel: '' }, known: { ownFp: '', qr: null, busy: false, peers: [], error: '', renameError: '' } }
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, meAv: '', catKey: 'devices', ...props }) }))
}

test('#1829 電腦版詳情頁：名字空白也認得出是哪一台，下面有「改名」和「永久移除」', async () => {
  const html = (await render(tree(), { dev: 'node-old-pc-X7K2', devView: 'info' })).replace(/<!--.*?-->/g, '')
  assert.match(html, /<h3 class="dv-name">電腦（X7K2）<\/h3>/)
  for (const t of ['建立時間', '平台', '最後在線', '代號', 'X7K2', '2026/11/05']) assert.ok(html.includes(t), t)
  assert.ok(!html.includes('未命名設備') && !html.includes('還沒連線過'), '不能據以行動的句子收掉')
  const acts = html.slice(html.indexOf('要處理這台設備'))
  assert.match(acts, />改名</)
  const rm = acts.match(/<button[^>]*class="asn-btn lv-secondary st-danger"[^>]*>永久移除</)
  assert.ok(rm, '可以移除時有永久移除鈕')
  assert.doesNotMatch(rm[0], /disabled/, '可以移除時永久移除鈕不能是 disabled')
  assert.ok(html.indexOf('這台是哪一台') < html.indexOf('要處理這台設備'), '辨認區在上、動作區在下')
})

test('#1829 在線的設備不能移除：按鈕變灰並說明原因（本機沒有這顆）', async () => {
  const rows = tree()
  const online = rows.map(r => (r.key === 'node-old-pc-X7K2' ? { ...r, online: true } : r))
  const html = await render(online, { dev: 'node-old-pc-X7K2', devView: 'info' })
  assert.match(html, /<button[^>]*class="asn-btn lv-secondary st-danger"[^>]*disabled[^>]*>永久移除</)
  assert.ok(html.includes('設備在線時不能移除，離線後才能移除'))
  assert.ok(!(await render(rows, { dev: 'node-self-A1B2', devView: 'info' })).includes('永久移除'), '本機不能移除')
})

test('#1829 名字空白時，改名框預設是空的，不把「未命名設備」「這台電腦」塞進去', () => {
  assert.match(read('../ui/lib/settings-panel.mjs'), /renameText\.value = curDev\.value\?\.named \? curDev\.value\.label : ''/)
  assert.doesNotMatch(read('../ui/lib/settings-panel.mjs'), /renameText\.value = curDev\.value\?\.label \?\? ''/)
  assert.match(read('../ui/m.js'), /text: d\.named \? \(d\.label \?\? ''\) : ''/)
  assert.doesNotMatch(read('../ui/m.js'), /text: d\.label \?\? ''/)
})

test('#1829 手機與電腦共用同一份：元件、文字、資料都從 device-identity／同一條資料路徑來', () => {
  const m = read('../ui/m.html'), mjs = read('../ui/m.js'), list = read('../ui/list.js')
  assert.match(m, /<device-identity :identity="acctCur\.identity"/)
  assert.match(read('../ui/lib/settings-panel.mjs'), /<device-identity :identity="curDev\.identity"/)
  assert.match(mjs, /app\.component\('device-identity', DeviceIdentity\)/)
  for (const src of [mjs, list]) assert.match(src, /nodeFacts: nodeFacts\.value/, '兩邊都把名單的時間欄位餵給設備樹')
  for (const src of [mjs, list]) assert.match(src, /nodeFacts\.value = s\.nodeFacts \?\? \{\}/)
  assert.match(read('../ui/lib/core.mjs'), /this\.nodeFacts = nodeFactsOf\(members\)/)
  // 兄弟副本：「還沒連線過」這句整個畫面檔裡都不再出現
  for (const f of ['../ui/m.html', '../ui/m.js', '../ui/list.js', '../ui/lib/settings-panel.mjs', '../ui/lib/mobile-known-peers.mjs']) assert.ok(!read(f).includes('還沒連線過'), f)
  assert.match(m, /:disabled="!acctCanRemove" @click="acctAskRemove"/, '手機的移除在線時也變灰')
})

test('#1829 辨認資料在畫面上只用文字插值（不走 innerHTML）', () => {
  assert.doesNotMatch(read('../ui/lib/device-identity.mjs'), /innerHTML|v-html/)
  assert.equal(deviceIdentity({ node: 'abcd1234', named: false, platform: 'ios', phone: true, now: NOW }).title, '手機（1234）')
})

test('#1829 動作區沒有拿掉原有功能；「永久移除」兩邊同一種外框紅字', () => {
  const m = read('../ui/m.html')
  assert.match(m, /<button type="button" class="m-dv-refresh" v-if="acctCanShowBack" @click="acctShowBack">\{\{ DEVICE_TEXT\.showBack \}\}/)
  assert.match(m, /class="m-dv-refresh m-dv-danger" v-if="!acctCur\.self" :disabled="!acctCanRemove" @click="acctAskRemove">\{\{ DEVICE_TEXT\.remove \}\}/)
  assert.match(read('../ui/lib/settings-panel.mjs'), /<asn-button state="danger" v-if="!askRemove"/)
})

test('#1829 「顯示回名單」電腦和手機同一個條件（只看已隱藏）：同一組設備資料實際跑兩邊，結果相同', async () => {
  const hiddenOnline = tree().map(r => (r.key === 'node-old-pc-X7K2' ? { ...r, hidden: true, online: true } : r))
  const hiddenOffline = tree().map(r => (r.key === 'node-old-pc-X7K2' ? { ...r, hidden: true, online: false } : r))
  const shown = tree().map(r => (r.key === 'node-old-pc-X7K2' ? { ...r, hidden: false, online: false } : r))
  for (const [name, devs, want] of [['已隱藏但在線', hiddenOnline, true], ['已隱藏且離線', hiddenOffline, true], ['沒隱藏、離線', shown, false]]) {
    const desk = (await render(devs, { dev: 'node-old-pc-X7K2', devView: 'info' })).includes('>顯示回名單<')
    const phone = canShowBackRow(devs.find(r => r.key === 'node-old-pc-X7K2'))   // 手機版的 acctCanShowBack 就是呼叫它
    assert.equal(desk, want, `電腦：${name}`)
    assert.equal(phone, want, `手機：${name}`)
  }
  assert.match(read('../ui/m.js'), /const acctCanShowBack = computed\(\(\) => canShowBackRow\(acctCur\.value\)\)/)
  assert.match(read('../ui/lib/settings-panel.mjs'), /v-if="canShowBackRow\(curDev\) && !askRemove"/)
})

test('#1829 名字空白的線索全畫面同一個函式：設備列表、頁籤、群組分組、通知寄件者、詳情標題寫的一樣', () => {
  const node = 'node-old-pc-X7K2'
  const fr = [{ id: 'a', node, status: 'offline', kind: 'claude', agent: 'a', nick: 'a', unread: 1 }]
  const want = '電腦（X7K2）'
  assert.equal(rowOf(tree({ friends: fr, nodeOrder: [node] }), node).label, want)
  assert.equal(rowOf(tree({ friends: fr, nodeOrder: [node] }), node).identity.title, want)
  assert.equal(deviceTabs(fr, { selfNode: 'S', nodeOrder: [node] }).all.find(t => t.key === node).label, want)
  assert.equal(groupItems(fr, 'device', { selfNode: 'S' }).find(g => g.node === node).label, want)
  assert.equal(groupByDevice(fr, { selfNode: 'S' }).find(g => g.key === node).label, want)
  assert.equal(nodeLabelOf(fr, { selfNode: 'S' })(node), want)
  assert.equal(launchDevices(fr, { selfNode: 'S', nodeOrder: [node] }).find(d => d.key === node).label, want)
  // 後面的夥伴有名字就換成名字
  const named = [...fr, { id: 'b', node, status: 'idle', kind: 'claude', agent: 'b', nick: 'b', device: '舊筆電' }]
  assert.equal(groupItems(named, 'device', { selfNode: 'S' }).find(g => g.node === node).label, '舊筆電')
  assert.equal(deviceTabs(named, { selfNode: 'S', nodeOrder: [node] }).all.find(t => t.key === node).label, '舊筆電')
})

test('#1829 畫面檔裡不再有自己寫死的「未命名設備」（只剩三處，各有理由）', () => {
  const hits = []
  for (const dir of ['../ui', '../ui/lib']) for (const f of fs.readdirSync(new URL(`${dir}/`, import.meta.url))) {
    if (!/\.(m?js|html)$/.test(f)) continue
    const src = read(`${dir}/${f}`)
    if (/UNNAMED_DEVICE|'未命名設備'/.test(src.replace(/\/\/.*$/gm, ''))) hits.push(f)
  }
  // 白名單每一項的理由：
  //   account-roster.mjs：shortDevice('') 沒有節點代號可用時的最後備援（只有空字串才會走到）
  //   device-known.mjs：LEGACY_UNNAMED，舊版畫面上的「沒名字」字樣；讀回來被當成名字存著的，一律當沒名字（通知、認得的電腦共用）
  //   text.mjs：UNNAMED_DEVICE 常數本身的定義
  assert.deepEqual(hits.sort(), ['account-roster.mjs', 'device-known.mjs', 'text.mjs'])
})

test('#1829 設備細部頁整頁只有一行頁首：「設定：設備」那一行（外層標題）進細部頁時收掉，列表頁照舊', async () => {
  const withTitle = async props => { globalThis.Vue = Vue; return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { title: '設定：設備', st: { version: '0.2.35', devices: tree(), accounts: { list: [], current: null, msg: '', autoNote: '', busy: false, confirmDel: '' }, known: { ownFp: '', qr: null, busy: false, peers: [], error: '', renameError: '' } }, meAv: '', catKey: 'devices', ...props }) })) }
  assert.match(await withTitle({}), /<h2 class="panel-h">設定：設備<\/h2>/)
  const detail = await withTitle({ dev: 'node-old-pc-X7K2', devView: 'info' })
  assert.ok(!detail.includes('panel-h') && !detail.includes('設定：設備'))
  assert.match(detail, /<div class="dv-dev-h"><button[^>]*dv-back/)
  assert.ok(!read('../ui/list.html').includes('<h2 class="panel-h">') && !read('../ui/panel.html').includes('<h2 class="panel-h">'), '兩個外層都不再自己疊一層標題')
})

test('#1829 電腦版細部頁的返回鈕只放「‹」（和手機一樣），讀屏與鍵盤用 aria-label="返回"', async () => {
  const html = await render(tree(), { dev: 'node-old-pc-X7K2', devView: 'info' })
  const back = html.match(/<button[^>]*dv-back[^>]*>‹<\/button>/)?.[0] ?? ''
  assert.ok(back.includes('aria-label="返回"') && back.includes('title="返回"'), '返回鈕只放「‹」，讀屏用 aria-label')
  assert.ok(!html.includes('‹ 返回') && !html.includes('>返回<'), '畫面上不再寫「返回」兩個字')
})

test('#1829 平台拿不到時整列不放（不寫「不明」），有平台才有這一列', () => {
  const none = deviceIdentity({ node: 'abcd1234', named: true, label: 'x', now: NOW })
  assert.ok(!none.rows.some(r => r.key === 'platform'))
  assert.ok(!JSON.stringify(none).includes('不明'))
  assert.equal(deviceIdentity({ node: 'abcd1234', named: true, label: 'x', platform: 'macos', now: NOW }).rows.find(r => r.key === 'platform').value, 'macOS')
})

test('#1829 時間的邊界：後台給毫秒數字也收；未來的時間不接「（多久以前）」；壞值當沒有', () => {
  assert.equal(nodeFactsOf([{ id: 'n', last_seen_at: NOW - 60_000 }]).n.seenMs, NOW - 60_000)
  assert.deepEqual(nodeFactsOf([{ id: 'n', last_seen_at: -5, created_at: 0 }]), {})
  const future = deviceIdentity({ node: 'abcd1234', named: true, label: 'x', seenMs: NOW + 3600_000, now: NOW }).rows.find(r => r.key === 'seen').value
  assert.match(future, /^\d{4}\/\d\d\/\d\d \d\d:\d\d$/)
  assert.ok(!future.includes('前'))
})
