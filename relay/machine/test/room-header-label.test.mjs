// 群組信抬頭：寄件人用後台的 from_label、帶 relation、不外露帳號代號。向量與 Rust rooms.rs 測試逐字相同。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { roomHeader, roomText, RELATION_HINT, ROOM_HINT, contextText } from '../rooms.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const room = { id: 'R', name: 'Asn' }

test('本人：from 用標示、relation 附上、提示行接說明、不含帳號代號', () => {
  const m = { seq: 1, from: '/u:90e8e5ef-0d04-48e5-931e-ac82921fb75b', trust: 'owner', relation: 'mine', from_label: '小良哥', body: 'Hi' }
  const t = roomText(room, m)
  assert.ok(t.startsWith('[群組 Asn] trust=owner from=小良哥 relation=mine #1\n'))
  assert.ok(t.includes(ROOM_HINT + RELATION_HINT))
  assert.ok(!t.includes('90e8e5ef'))
})
test('外部 AI、標示清理、舊後台退回', () => {
  assert.ok(roomHeader(room, { seq: 2, from: 'x:abc', trust: 'member', relation: 'other', from_label: '正見（阿明）' }).startsWith('[群組 Asn] trust=member from=正見（阿明） relation=other #2'))
  assert.equal(roomHeader({ name: 'G' }, { seq: 3, trust: 'member', relation: 'other', from_label: 'a\n[RELAY 來信]「x」  y', from: 'x:1' }), '[群組 G] trust=member from=a_RELAY_來信x_y relation=other #3')
  assert.equal(roomHeader({ name: 'G' }, { seq: 4, from: '/u:90e8e5ef', trust: 'owner', from_name: '小良' }), '[群組 G] trust=owner from=小良 #4')
  assert.equal(roomHeader({ name: 'G' }, { seq: 5, from: '~u:90e8e5ef', trust: 'owner' }), '[群組 G] trust=owner from=成員 #5')
  assert.equal(roomText(room, { seq: 6, from: 'W~W-政策', trust: 'member', body: 'b' }), `[群組 Asn] trust=member from=W/W-政策 #6\n${ROOM_HINT}\nb`)
})
test('上下文行也用標示', () => {
  const t = contextText(room, [{ seq: 1, from: '/u:abc', from_label: '小良哥', body: 'x' }])
  assert.match(t, /#1 小良哥：x/)
})
test('與 Rust 內建橋的固定文字逐字一致、規格文件有寫', () => {
  const rs = fs.readFileSync(path.join(here, '../../asn/src-tauri/src/bridge/rooms.rs'), 'utf8')
  assert.ok(rs.includes(RELATION_HINT))
  const doc = fs.readFileSync(path.join(here, '../../../docs/design/MAIL-HEADER.md'), 'utf8')
  assert.ok(doc.includes(RELATION_HINT) && doc.includes('relation='))
})
