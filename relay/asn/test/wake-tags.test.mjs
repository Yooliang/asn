// 群組訊息下方的叫醒順序標籤（#231）：後台存的 wake_info → 標籤；桌面與手機共用 ChatPane，樣式淺色小字、深色模式可讀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { roomLog, wakeTags } from '../ui/lib/mobile-rooms.mjs'

const E = (label, rank, hold = false) => ({ key: 'x:' + label, label, rank, hold })
const M = (seq, over = {}) => ({ seq, from: 'P', from_name: '小良', from_kind: 'human', relation: 'mine', body: '嗨', at: '2026-10-24T10:00:00Z', mentions: [], ...over })

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
  assert.match(pane, /class="wake-tag" :class="\{ off: w\.off \}"/)
  assert.ok(pane.indexOf('class="wake-tags"') > pane.indexOf('class="m-body"'), '標籤在內文下方')
  const css = fs.readFileSync(new URL('../ui/group.css', import.meta.url), 'utf8')
  assert.match(css, /\.wake-tags\{[^}]*font-size:11px/)
  assert.match(css, /\.wake-tag\.off\{color:#a9b4c0\}/)
  assert.match(css, /prefers-color-scheme:dark\)\{\s*\.wake-tags\{color:#9fb0c3\}\.wake-tag\.off\{color:#6d7e91\}/)
  for (const h of ['chat.html', 'm.html']) assert.match(fs.readFileSync(new URL('../ui/' + h, import.meta.url), 'utf8'), /group\.css/, h + ' 要載入 group.css')
})
