// #1803 設備名稱只有一份：後台的 nodes.name。
// 讀：手機自己沒有夥伴列，名字也要讀得到（nodeNames）；電腦版、手機版讀名字只走 deviceNameOf 一個函式。
// 寫：全 repo 只有設備頁一個改名入口；本機視窗名由 Rust 跟著後台走；啟動時以後台為準對齊一次。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deviceNameOf, nodeNamesOf } from '../ui/lib/device-known.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { launchDeviceRows } from '../ui/lib/partner-launch-ui.mjs'
import { pageTabs } from '../ui/lib/dims.mjs'
import { alignDeviceName, alignNote, followSelfRename, renameCommandOf, renameDevice } from '../ui/lib/device-rename.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n')
const uiFiles = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'vendor' ? [] : uiFiles(path.join(dir, e.name))) : [path.join(dir, e.name)]))

// 小良哥的狀況：手機（本機 P）在名單裡在線、底下沒有夥伴；後台記的名字是「Oppo 手機」。另一台是有夥伴的辦公室電腦
const MEMBERS = [
  { id: 'P', name: 'Oppo 手機', kind: 'phone', asn: [{ window_name: 'Oppo 手機', version: '0.2.33', status: 'online' }], agents: [] },
  { id: 'Q', name: '辦公室', kind: 'claude', asn: [{ window_name: 'Q-ASN', version: '0.2.33', status: 'online' }], agents: [{ name: 'demo', status: 'idle', engine: 'claude' }] },
]
const friends = buildFriends(MEMBERS, { selfNode: 'P', selfName: 'Oppo 手機' })
const ASN = { P: MEMBERS[0].asn, Q: MEMBERS[1].asn }

test('#1803 讀名字：名單成員的名字不靠夥伴列（手機沒有夥伴也有名字）', () => {
  assert.deepEqual(nodeNamesOf(MEMBERS), { P: 'Oppo 手機', Q: '辦公室' })
  assert.deepEqual(nodeNamesOf([{ id: 'x', name: '  ' }, { id: 5, name: 'a' }, null, { id: 'y' }]), {})
  assert.equal(friends.some(f => f.node === 'P'), false, '手機節點底下沒有夥伴列（這就是舊程式讀不到名字的原因）')
  assert.equal(deviceNameOf('P', { nodeNames: nodeNamesOf(MEMBERS), friends }), 'Oppo 手機')
  // 後台名字像指紋就當沒有名字；沒有 nodeNames 時才借夥伴的 device，再不行用 fallback
  assert.equal(deviceNameOf('P', { nodeNames: { P: 'n1a2b3c4d-ASN' }, friends }), '')
  assert.equal(deviceNameOf('Q', { nodeNames: {}, friends }), '辦公室')
  assert.equal(deviceNameOf('Z', { fallback: '備用名' }), '備用名')
})

test('#1803 手機設備頁：本機那一列寫真名，同一台只有一列，沒有「未命名設備」', () => {
  const rows = acctDeviceTree({ friends, nodeNames: nodeNamesOf(MEMBERS), nodeOrder: ['P', 'Q'], selfNode: 'P', launchers: {}, machines: {} })
  assert.deepEqual(rows.map(r => r.key), ['P', 'Q'], '每台設備只列一次')
  assert.equal(rows[0].label, 'Oppo 手機')
  assert.equal(rows[0].self, true)
  assert.equal(rows[0].kind, '手機')
  assert.equal(rows.some(r => /未命名設備/.test(r.label)), false)
  // 沒給 nodeNames（舊程式的讀法）＝退回標籤「這支手機」：這條在舊程式上就是現在看到的症狀
  const old = acctDeviceTree({ friends, nodeOrder: ['P', 'Q'], selfNode: 'P', launchers: {}, machines: {} })
  assert.equal(old[0].label, '這支手機')
})

test('#1803 電腦設備頁：本機沒有夥伴時也寫真名；用的是和手機同一個讀法', () => {
  const rows = buildDeviceTree({ friends: friends.filter(f => f.node !== 'Q'), nodeNames: { P: '我的電腦', Q: '辦公室' }, nodeOrder: ['P'], selfNode: 'P' })
  assert.equal(rows[0].label, '我的電腦')
})

test('#1803 雲端節點（#1707）：夥伴沒帶 device 時，名字取自名單成員的名字，不寫「未命名設備」', () => {
  const cloud = [{ id: 'c1', node: 'A', agent: '麗麗', nick: '麗麗', status: 'idle', engine: 'aegis' }]   // 存檔還原的夥伴列沒有 device
  const rows = buildDeviceTree({ friends: cloud, nodeNames: { A: '牧陽 Aegis' }, nodeOrder: ['A'], selfNode: 'P' })
  assert.equal(rows.find(r => r.key === 'A').label, '牧陽 Aegis')
  const none = buildDeviceTree({ friends: cloud, nodeOrder: ['A'], selfNode: 'P' })
  assert.equal(none.find(r => r.key === 'A').label, '未命名設備', '沒有 nodeNames 時舊行為不變')
})

test('#1803 其餘讀名字的地方也吃 nodeNames：啟動器清單、頁籤', () => {
  const rows = launchDeviceRows(cloudless(), { selfNode: 'P', nodeNames: { P: 'Oppo 手機', Q: '辦公室' }, nodeOrder: ['P', 'Q'] })
  assert.deepEqual(rows.map(r => r.label), ['Oppo 手機', '辦公室'])
  const tabs = pageTabs(friends, 'device', { selfNode: 'P', selfName: '', nodeNames: nodeNamesOf(MEMBERS), nodeOrder: ['P', 'Q'] })
  assert.deepEqual(tabs.all.map(t => t.label), ['Oppo 手機', '辦公室'])
})
function cloudless() { return friends.map(f => ({ ...f, device: '' })) }

test('#1803 守門：電腦版與手機版讀設備名字都走 deviceNameOf，不准各寫一份借夥伴列的寫法', () => {
  for (const f of ['ui/lib/device-tree.mjs', 'ui/lib/partner-launch-ui.mjs', 'ui/lib/dims.mjs', 'ui/lib/tabs.mjs', 'ui/lib/mobile-launch.mjs', 'ui/lib/account-roster.mjs', 'ui/list.js', 'ui/m.js']) {
    assert.match(read(f), /\bdeviceNameOf\b/, `${f} 要用 deviceNameOf 讀設備名`)
  }
  // 這幾個地方不得再自己從夥伴列借名字（f.device || …／find(... f.device)?.device）
  for (const f of ['ui/lib/device-tree.mjs', 'ui/lib/dims.mjs', 'ui/lib/tabs.mjs', 'ui/lib/mobile-launch.mjs', 'ui/lib/account-roster.mjs', 'ui/list.js', 'ui/m.js']) {
    const s = read(f)
    assert.doesNotMatch(s, /find\(f => f\.node === [^)]*&& f\.device\)\?\.device/, `${f} 不能自己借夥伴列的名字`)
    assert.doesNotMatch(s, /f\.device \|\| (UNNAMED_DEVICE|'未命名設備')/, `${f} 不能自己借夥伴列的名字`)
  }
  assert.match(read('ui/lib/core.mjs'), /nodeNames = nodeNamesOf\(members\)/)
  assert.match(read('ui/lib/core.mjs'), /nodeNames: \{ \.\.\.this\.nodeNames \}/, '快照要帶 nodeNames，畫面才讀得到')
  for (const f of ['ui/list.js', 'ui/m.js']) assert.match(read(f), /nodeNames\.value = s\.nodeNames/, `${f} 同步時要收 nodeNames`)
})

test('#1803 守門：全 repo 只有設備頁一個改名入口（ui 沒有 set_window_name、個人頁沒有可編輯的設備名欄位）', () => {
  const files = [...uiFiles('ui'), ...fs.readdirSync(path.join(root, 'scripts')).map(f => path.join('scripts', f))].filter(f => /\.(m?js|html)$/.test(f))
  for (const f of files) assert.doesNotMatch(read(f), /set_window_name/, `${f} 不能再叫 set_window_name`)
  const html = read('ui/m.html'), js = read('ui/m.js')
  assert.doesNotMatch(html, /v-model="me\.nick"/, '手機個人頁不能再有設備名稱輸入欄')
  assert.doesNotMatch(js, /commitNick/, '手機個人頁的改名函式要拿掉')
  assert.match(html, /到設備頁改名/, '個人頁改成一行連結帶去設備頁')
  assert.ok([...html.matchAll(/v-model="dn\.text"/g)].length >= 1 && !/v-model="(me\.nick|nickDraft)"/.test(html), '手機設備名輸入欄只有設備頁的改名表單（共用 dn 這一份狀態）')
  // 叫改名命令的地方只有 device-rename.mjs 一個檔案
  for (const f of files) {
    if (f.endsWith('device-rename.mjs')) continue
    const s = read(f)
    if (f.startsWith('ui')) assert.doesNotMatch(s.replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, ''), /invoke\('(device_rename|android_known_rename)'/, `${f} 要透過 renameDevice 改名`)
  }
})

test('#1803 守門（Rust 原始碼）：沒有 set_window_name 命令；兩個改名命令都讓本機視窗名跟上；啟動對齊命令兩邊都登記', () => {
  const lib = read('src-tauri/src/lib.rs'), android = read('src-tauri/src/android.rs'), names = read('src-tauri/src/names.rs')
  assert.doesNotMatch(lib, /fn set_window_name\b/)
  assert.doesNotMatch(lib, /\bset_window_name,/)
  assert.match(lib, /Ok\(follow_self_rename\(&app, r\.as_ref\(\), &node, v\)\)/, '電腦的 device_rename 要讓本機視窗名跟上')
  assert.match(android, /crate::follow_self_rename\(&app, r\.as_ref\(\), &node, v\)/, '手機的 android_known_rename 要讓本機視窗名跟上')
  assert.equal(lib.split('device_name_align,').length - 1, 2, '電腦與手機兩份命令清單都要登記 device_name_align')
  assert.match(names, /pub fn follow_device_rename/)
  assert.match(names, /pub fn align_with_backend/)
})

test('#1803 改名命令：手機走 android_known_rename、電腦走 device_rename；失敗丟中文 Error', async () => {
  assert.equal(renameCommandOf(true), 'android_known_rename')
  assert.equal(renameCommandOf(false), 'device_rename')
  const calls = []
  const ok = async (cmd, args) => { calls.push([cmd, args]); return { ok: true, name: args.name, changed: true } }
  await renameDevice(ok, { node: 'P', name: '  Oppo 手機 ', phone: true })
  assert.deepEqual(calls[0], ['android_known_rename', { node: 'P', name: 'Oppo 手機' }])
  await assert.rejects(renameDevice(async () => { throw '名字不合規則' }, { node: 'P', name: 'x' }), /名字不合規則/)
  await assert.rejects(renameDevice(async () => { throw new Error('') }, { node: 'P', name: 'x' }), /改名沒有成功/)
})

test('#1803 改的是這台自己：Rust 說本機視窗名換了，畫面就地更新（info、核心、我的暱稱）；別台不動', () => {
  const info = { window_name: 'P-ASN', old_names: [] }, me = { nick: 'P-ASN' }, seen = []
  const core = { setWindowName: n => seen.push(n) }
  assert.equal(followSelfRename({ info, core, me }, { ok: true, name: '別台', changed: true }), false)
  assert.equal(info.window_name, 'P-ASN')
  assert.equal(followSelfRename({ info, core, me }, { ok: true, name: 'Oppo 手機', self_renamed: true, window_name: 'Oppo 手機' }), true)
  assert.deepEqual([info.window_name, me.nick, seen], ['Oppo 手機', 'Oppo 手機', ['Oppo 手機']])
  assert.deepEqual(info.old_names, ['P-ASN'], '舊名要留著，改名前寄來的回信還收得到')
})

test('#1803 後台名字蓋過本機（kept）時不准靜默：啟動對齊換掉本機名字會明說，其餘不打擾', async () => {
  const mk = () => ({ info: { window_name: 'P-ASN', old_names: [] }, me: { nick: 'P-ASN' }, core: { setWindowName() {} } })
  const notes = []
  const c1 = mk()
  const r1 = await alignDeviceName(async () => ({ state: 'adopted', name: 'Oppo 手機' }), c1, t => notes.push(t))
  assert.equal(r1.state, 'adopted')
  assert.equal(c1.info.window_name, 'Oppo 手機')
  assert.deepEqual(notes, ['這台的名字已統一為設備頁設定的「Oppo 手機」，要改請到設備頁。'])
  assert.equal(alignNote('X'), '這台的名字已統一為設備頁設定的「X」，要改請到設備頁。')
  for (const state of ['ok', 'pushed', 'later']) {
    const c = mk()
    await alignDeviceName(async () => ({ state }), c, t => notes.push(t))
    assert.equal(c.info.window_name, 'P-ASN')
  }
  assert.equal(notes.length, 1)
  // 命令失敗（舊版 Rust 沒這個命令、沒網路）：不丟錯、不動畫面
  const c2 = mk()
  assert.equal(await alignDeviceName(async () => { throw 'no' }, c2, t => notes.push(t)), null)
  assert.equal(c2.info.window_name, 'P-ASN')
})
