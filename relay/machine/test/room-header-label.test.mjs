// 群組信抬頭：寄件人用後台的 from_label、帶 relation、不外露帳號代號。向量與 Rust rooms.rs 測試逐字相同。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { roomHeader, roomText, RELATION_HINT, ROOM_HINT, contextText } from '../rooms.mjs'
import { RESPONSIVE_NOTE } from '../mail-format.mjs'

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
test('提示行逐字固定（Rust、Node、規格文件三邊相同）', () => {
  const HINT = '這是一則群組訊息。請先看下面的歷史紀錄，確定這件事跟你有關（被點名、或是在回你剛才說的事）才回覆；跟你無關就不要回。'
  assert.equal(ROOM_HINT, HINT)
  assert.ok(fs.readFileSync(path.join(here, '../../asn/src-tauri/src/bridge/rooms.rs'), 'utf8').includes(HINT))
  assert.ok(fs.readFileSync(path.join(here, '../../../docs/design/MAIL-HEADER.md'), 'utf8').includes(HINT))
})
test('與 Rust 內建橋的固定文字逐字一致、規格文件有寫', () => {
  const rs = fs.readFileSync(path.join(here, '../../asn/src-tauri/src/bridge/rooms.rs'), 'utf8')
  assert.ok(rs.includes(RELATION_HINT))
  const doc = fs.readFileSync(path.join(here, '../../../docs/design/MAIL-HEADER.md'), 'utf8')
  assert.ok(doc.includes(RELATION_HINT) && doc.includes('relation='))
})
// #494：與 Rust rooms.rs「群組信_保持能回應提醒_…」測試同一組向量
test('保持能回應提醒：Claude 視窗的群組信在提示行之後、內文之前多一行；沒給引擎或自動回信的轉接器不加', () => {
  const plain = { seq: 3, from: 'W~W-政策', trust: 'member', body: 'b' }
  assert.equal(roomText({ name: 'G' }, plain, 'claude'), `[群組 G] trust=member from=W/W-政策 #3\n${ROOM_HINT}\n${RESPONSIVE_NOTE}\nb`)
  const lines = roomText({ name: 'G' }, { ...plain, relation: 'other' }, 'claude').split('\n')
  assert.deepEqual(lines.slice(1), [ROOM_HINT + RELATION_HINT, RESPONSIVE_NOTE, 'b'])
  for (const eng of [undefined, '', 'acp', 'codex', 'gemini']) {
    assert.equal(roomText({ name: 'G' }, plain, eng), `[群組 G] trust=member from=W/W-政策 #3\n${ROOM_HINT}\nb`, String(eng))
  }
  // Rust 內建橋的群組抬頭用同一個常數（mail::RESPONSIVE_NOTE）、同一個判斷（sends_own_mail）
  const rs = fs.readFileSync(path.join(here, '../../asn/src-tauri/src/bridge/rooms.rs'), 'utf8')
  assert.ok(rs.includes('super::mail::sends_own_mail(engine_id)') && rs.includes('super::mail::RESPONSIVE_NOTE'))
})
