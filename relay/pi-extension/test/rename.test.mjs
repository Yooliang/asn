// 0.2 A4：pi 改名。登記名「最後一次改的為準」、控制檔的 set_name 請求、登記檔帶擴充版本
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ASN_NAME_ENTRY, EXT_VERSION, asnNameFrom, resolveWindowName, validRename, windowRecord } from '../inbox.mjs'
import { nextRequests, writeResult } from '../control.mjs'

const info = name => ({ type: 'session_info', name })
const asn = name => ({ type: 'custom', customType: ASN_NAME_ENTRY, data: { name } })
const msg = { type: 'message' }
const env = { ASN_PI_NAME: '開窗給的名' }
const nameOf = entries => {
  const sessionName = [...entries].reverse().find(e => e.type === 'session_info')?.name
  return resolveWindowName({ env, sessionName, cwd: 'C:/x/專案', asn: asnNameFrom(entries) })
}

test('只有 ASN 改名：用 ASN 給的名字，蓋過開窗時的環境變數', () => {
  // ASN 改名的順序：先 setSessionName（session_info），再記「ASN 改過名」
  assert.equal(nameOf([msg, info('小葛'), asn('小葛'), msg]), '小葛')
  assert.deepEqual(asnNameFrom([info('小葛'), asn('小葛')]), { name: '小葛', sessionWins: false })
})

test('ASN 改名後使用者在 pi 裡 /name：session_info 比較新，用 session 名', () => {
  assert.equal(nameOf([info('小葛'), asn('小葛'), msg, info('自己取的')]), '自己取的')
  // 之後 ASN 又改一次：又以 ASN 的為準
  assert.equal(nameOf([info('小葛'), asn('小葛'), info('自己取的'), info('小葛二'), asn('小葛二')]), '小葛二')
})

test('都沒改過：照舊（環境變數 → session 名 → 資料夾名）；只有使用者 /name 也照舊', () => {
  assert.equal(nameOf([msg]), '開窗給的名')
  assert.equal(nameOf([info('自己取的')]), '開窗給的名', '沒有 ASN 改名紀錄：環境變數仍優先（原本的行為）')
  assert.equal(resolveWindowName({ env: {}, sessionName: '', cwd: 'C:/x/專案', asn: asnNameFrom([]) }), 'pi-專案')
  assert.equal(asnNameFrom([asn('-壞名'), asn('')]), null, '紀錄裡不合法的名字不算')
})

test('重開 pi、接回同一段對話：從對話檔的紀錄找回 ASN 改的名字（環境變數還是舊的也一樣）', () => {
  const file = [msg, info('小葛'), asn('小葛'), msg, msg]
  assert.equal(nameOf(file), '小葛')
  assert.equal(resolveWindowName({ env: { ASN_PI_NAME: '舊名' }, sessionName: '小葛', cwd: '', asn: asnNameFrom(file) }), '小葛')
})

test('改名的名字格式：與電腦端同一套', () => {
  for (const ok of ['小葛', 'pi-2', 'A']) assert.ok(validRename(ok), ok)
  for (const bad of ['', '-x', 'a b', 'a/b', 'x'.repeat(41), 'a;b']) assert.ok(!validRename(bad), bad)
})

test('控制檔：set_name 請求讀得到、壞名字略過；結果帶 name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ctl-'))
  const sid = 'sess-1'
  fs.mkdirSync(path.join(dir, sid))
  fs.writeFileSync(path.join(dir, sid, 'r1.json'), JSON.stringify({ v: 1, id: 'r1', op: 'set_name', name: '小葛', at: 1 }))
  fs.writeFileSync(path.join(dir, sid, 'r2.json'), JSON.stringify({ v: 1, id: 'r2', op: 'set_name', name: '-壞', at: 2 }))
  assert.deepEqual(nextRequests(dir, sid, new Set()), [{ id: 'r1', op: 'set_name', name: '小葛', at: 1 }])
  writeResult(dir, sid, 'r1', { ok: true, name: '小葛' }, 5)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, sid, 'r1.result.json'), 'utf8')), { v: 1, id: 'r1', ok: true, at: 5, name: '小葛' })
})

test('登記檔帶擴充版本 ext（電腦端靠它知道收不收得下改名）', () => {
  assert.equal(EXT_VERSION, 2)
  assert.equal(windowRecord({ sessionId: 's', name: 'n', pid: 1, cwd: '', state: 'idle', at: 1 }).ext, 2)
})
