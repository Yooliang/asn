// 端到端：真的把 asn.exe 開起來（--shot），連本機假 relay。驗證：收得到假信（inbox&agent＋ack）、寄得出信（body／to_node／to_agent／
// expects_reply／reply_to／from_agent）、震動信、心跳檔有寫且格式對、金鑰只出現在 x-relay-key 標頭、截圖檔有產生。
// 需要先 `npm run build`；找不到 exe 就略過。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultExe, runShot, shotCaptureSupported } from '../scripts/shot.mjs'
import { FAKE_KEY, U } from './fake-relay.mjs'

test('asn.exe 端到端（假 relay）', { skip: (!shotCaptureSupported && '端到端截圖僅 Windows') || (!fs.existsSync(defaultExe) && '先執行 npm run build'), timeout: 120_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-e2e-'))
  const r = await runShot(out)
  assert.equal(r.code, 0, r.log)
  const reqs = r.relay.reqs
  assert.ok(reqs.every(q => q.key === FAKE_KEY), '每個請求都帶 x-relay-key')
  assert.ok(reqs.some(q => q.action === 'list'))
  assert.ok(reqs.some(q => q.action === 'room_list' && q.method === 'GET' && !q.body), '群組頁籤只用唯讀 GET room_list')
  assert.ok(!reqs.some(q => q.action?.startsWith('room_') && q.method !== 'GET'), '群組沒有任何寫入')
  assert.ok(r.files.some(f => f.startsWith('tabs-groups')), '有群組頁籤截圖')
  assert.ok(reqs.some(q => q.action === 'inbox' && q.agent === 'H-ASN'), '用 inbox&agent=<視窗名> 收信')
  assert.ok(reqs.some(q => q.action === 'ack' && q.agent === 'H-ASN' && q.body.ids.includes(U(1))), '收到後 ack')
  assert.equal(r.relay.mails[0].acked, true)
  assert.ok(!reqs.some(q => q.action === 'inbox' && !q.agent), '不拉整個節點信箱（那是機器橋的）')
  assert.ok(r.relay.sent.every(s => s.from_agent === 'H-ASN'), '寄信一律用現用名')
  assert.deepEqual(r.relay.sent[0], { to_node: 'W', to_agent: 'W-政策', body: '收到！我晚點看一下 :)', reply_to: U(2), from_agent: 'H-ASN', expects_reply: true })
  assert.deepEqual(r.relay.sent[1], { to_node: 'W', to_agent: 'W-政策', body: '（H-ASN 傳送了一個震動）', from_agent: 'H-ASN', expects_reply: false })
  // 改名後的舊名（H-舊名，7 天內）照樣收信、對同一個名字 ack、寫自己的心跳；過期的（H-過期）不碰
  assert.ok(reqs.some(q => q.action === 'inbox' && q.agent === 'H-舊名'), '舊名也用 inbox&agent=<舊名> 收信')
  assert.ok(reqs.some(q => q.action === 'ack' && q.agent === 'H-舊名' && q.body.ids.includes(U(2))), '寄給舊名的信對舊名 ack')
  assert.ok(!reqs.some(q => q.agent === 'H-過期'), '過期的舊名不再收')
  assert.equal(r.relay.mails.find(m => m.id === U(2)).acked, true)
  assert.ok(r.oldHeartbeat && r.oldHeartbeat.name === 'H-舊名' && r.oldHeartbeat.pid === r.pid, '舊名各寫自己的心跳')
  assert.equal(r.expiredHeartbeat, false)
  assert.ok(r.heartbeat, '執行中有寫心跳檔')
  assert.deepEqual(Object.keys(r.heartbeat), ['pid', 'name', 't'])
  assert.equal(r.heartbeat.name, 'H-ASN')
  assert.equal(r.heartbeat.pid, r.pid)
  assert.ok(Math.abs(Date.now() - r.heartbeat.t) < 120_000)
  assert.equal(fs.existsSync(r.hbFile), false, '結束時清掉自己的心跳')
  for (const f of ['list.png', 'chat.png']) assert.ok(r.files.includes(f), `缺 ${f}`)
  assert.ok(r.files.some(f => f.startsWith('toast-')), '有提示視窗截圖')
  assert.ok(fs.existsSync(path.join(r.data, 'asn-chats.json')), '對話存檔寫在資料夾')
  assert.ok(!fs.readFileSync(path.join(r.data, 'asn-chats.json'), 'utf8').includes(FAKE_KEY), '存檔裡沒有金鑰')
})
