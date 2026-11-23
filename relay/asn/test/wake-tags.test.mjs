// 群組訊息下方的叫醒順序標籤（#231）：後台存的 wake_info → 標籤；桌面與手機共用 ChatPane，樣式淺色小字、深色模式可讀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { roomLog, wakeTags } from '../ui/lib/mobile-rooms.mjs'

const E = (label, rank, hold = false) => ({ key: 'x:' + label, label, rank, hold })
const M = (seq, over = {}) => ({ seq, from: 'P', from_name: '擁有者', from_kind: 'human', relation: 'mine', body: '嗨', at: '2026-10-24T10:00:00Z', mentions: [], ...over })

test('標籤：依順序列出被叫醒的夥伴，被略過的排最後並標 off', () => {
  const tags = wakeTags([E('VM管理', 2), E('家用正見', 1), E('監看', 0, true)])
  assert.deepEqual(tags, [{ label: '家用正見', off: false }, { label: 'VM管理', off: false }, { label: '監看', off: true }])
})

test('標籤：0～1 位被叫醒且沒人被略過不顯示；有人被略過就顯示', () => {
  assert.deepEqual(wakeTags(null), [])
  assert.deepEqual(wakeTags(undefined), [])
  assert.deepEqual(wakeTags([]), [])
  assert.deepEqual(wakeTags([E('甲', 1)]), [])
  assert.equal(wakeTags([E('甲', 1), E('乙', 2)]).length, 2)
  assert.deepEqual(wakeTags([E('甲', 1), E('乙', 0, true)]), [{ label: '甲', off: false }, { label: '乙', off: true }])
  assert.equal(wakeTags([E('乙', 0, true)]).length, 1)
})

test('標籤：壞資料不炸；標示不出現 x: 代號', () => {
  assert.deepEqual(wakeTags('壞的'), [])
  assert.deepEqual(wakeTags([null, 3, E('甲', 1), E('乙', 2)]).map(t => t.label), ['甲', '乙'])
  const t = wakeTags([{ label: '', rank: 1, hold: false }, { label: 'x:abc', rank: 2, hold: false }])
  assert.ok(t.every(x => !/^x:/.test(x.label)), JSON.stringify(t))
})

test('對話記錄：人發的與 AI 發的訊息都帶 wake；舊後台沒有欄位就是空陣列', () => {
  const info = [E('家用正見', 1), E('VM管理', 2)]
  const log = roomLog([M(1, { wake_info: info }), M(2, { from: 'W~甲', from_name: '甲', from_kind: 'ai', relation: 'other', wake_info: info }), M(3)], ['P'], [])
  assert.deepEqual(log.map(e => e.wake.map(t => t.label)), [['家用正見', 'VM管理'], ['家用正見', 'VM管理'], []])
})

test('畫面：ChatPane 在訊息下方畫標籤（桌面與手機共用）；樣式是淺色小字且深色模式有覆寫', () => {
  const pane = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.match(pane, /class="wake-tags" v-if="m\.wake && m\.wake\.length"/)
  assert.match(pane, /class="wake-tag" :class="\{ off: w\.off, offline: w\.offline \}"/)
  assert.ok(pane.indexOf('class="wake-tags"') > pane.indexOf('class="m-body"'), '標籤在內文下方')
  const css = fs.readFileSync(new URL('../ui/group.css', import.meta.url), 'utf8')
  assert.match(css, /\.wake-tags\{[^}]*font-size:11px/)
  assert.match(css, /\.wake-tag\{[^}]*background:rgba\(107,123,140/, '每個名字都有淡底色，被略過的也有')
  assert.match(css, /\.wake-tag\.off\{color:#a9b4c0;background:rgba\(169,180,192,\.12\)\}/)
  assert.doesNotMatch(css, /prefers-color-scheme/, 'ASN 只有亮色外觀，不跟著系統深色走（#2189）')
  for (const h of ['chat.html', 'm.html']) assert.match(fs.readFileSync(new URL('../ui/' + h, import.meta.url), 'utf8'), /group\.css/, h + ' 要載入 group.css')
})

test('離線（#1656）：被略過、而且成員鍵在離線名單裡的那位多標 offline；在線的略過者（分數低）不標；沒給名單照舊', () => {
  const info = [{ key: 'W~甲', label: '甲', rank: 1, hold: false }, { key: 'N~乙', label: '乙', rank: 0, hold: true }, { key: 'Q~丙', label: '丙', rank: 0, hold: true }]
  assert.deepEqual(wakeTags(info, new Set(['N~乙'])), [{ label: '甲', off: false }, { label: '乙', off: true, offline: true }, { label: '丙', off: true }])
  assert.deepEqual(wakeTags(info), [{ label: '甲', off: false }, { label: '乙', off: true }, { label: '丙', off: true }], '舊呼叫（不給名單）不變')
  assert.deepEqual(wakeTags([{ key: 'N~乙', label: '乙', rank: 1, hold: false }, { key: 'W~甲', label: '甲', rank: 2, hold: false }], new Set(['N~乙'])).map(t => t.offline), [undefined, undefined], '沒被略過的不標離線')
  assert.deepEqual(wakeTags([{ label: '乙', rank: 0, hold: true }, { key: 'W~甲', label: '甲', rank: 1, hold: false }], new Set(['N~乙'])).map(t => t.offline), [undefined, undefined], '沒有 key 的舊資料不標')
})

test('離線（#1656）：applyWakes 把離線名單帶進標籤；畫面灰色加「離線」並有說明；room-hub 兩處都傳目前的離線名單', async () => {
  const { applyWakes } = await import('../ui/lib/mobile-rooms.mjs')
  const log = [{ k: 'me', seq: 7, t: 1, wk: false }]
  const out = applyWakes(log, [{ seq: 7, wake_info: [{ key: 'W~甲', label: '甲', rank: 1, hold: false }, { key: 'N~乙', label: '乙', rank: 0, hold: true }] }], new Set(['N~乙']))
  assert.deepEqual(out[0].wake, [{ label: '甲', off: false }, { label: '乙', off: true, offline: true }])
  const pane = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.match(pane, /:title="w\.offline \? '目前離線，上線後會看到' : w\.off \? '不通知' : ''">\{\{ w\.label \}\}<small class="wake-off" v-if="w\.offline">（離線）<\/small>/)
  const hub = fs.readFileSync(new URL('../ui/lib/room-hub.mjs', import.meta.url), 'utf8')
  assert.equal((hub.match(/offlineKeysOf\(/g) ?? []).length, 2, '兩處套用')
  assert.match(hub, /const offlineKeysOf = room => new Set\(offlineNames\(room\?\.members\)\.map\(n => n\.key\)\)/)
})

test('離線（#1656）：訊息自帶 wake_info 時，roomLog 也依成員當下的離線狀態標 offline（往上載舊訊息、重開群組都走這一條）', () => {
  const members = [{ key: 'W~甲', name: '甲', kind: 'window', online: true }, { key: 'N~乙', name: '乙', kind: 'window', online: false }]
  const wake_info = [{ key: 'W~甲', label: '甲', rank: 1, hold: false }, { key: 'N~乙', label: '乙', rank: 0, hold: true }]
  const log = roomLog([M(3, { wake_info })], ['P'], members)
  assert.deepEqual(log[0].wake, [{ label: '甲', off: false }, { label: '乙', off: true, offline: true }])
  const on = roomLog([M(3, { wake_info })], ['P'], members.map(m => ({ ...m, online: true })))
  assert.deepEqual(on[0].wake, [{ label: '甲', off: false }, { label: '乙', off: true }], '都在線就不標')
  assert.deepEqual(roomLog([M(3, { wake_info })], ['P'], undefined)[0].wake.map(t => t.offline), [undefined, undefined], '讀不到成員不炸、不標')
})
