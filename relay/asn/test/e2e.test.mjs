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
import { nudgeBody } from '../ui/lib/text.mjs'
import { assertShotNotBlank } from './shot-png.mjs'

test('asn.exe 端到端（假 relay）', { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-e2e-'))
  const r = await runShot(out)
  assert.equal(r.code, 0, r.log)
  const reqs = r.relay.reqs
  assert.ok(reqs.every(q => q.key === FAKE_KEY), '每個請求都帶 x-relay-key')
  assert.ok(reqs.some(q => q.action === 'list'))
  assert.ok(reqs.some(q => q.action === 'room_list' && q.method === 'GET' && !q.body), '群組頁籤只用唯讀 GET room_list')
  assert.ok(!reqs.some(q => q.action?.startsWith('room_') && q.method !== 'GET'), '群組沒有任何寫入')
  if (shotCaptureSupported) assert.ok(r.files.some(f => f.startsWith('tabs-groups')), '有群組頁籤截圖')
  assert.ok(reqs.some(q => q.action === 'inbox' && q.agent === 'H-ASN'), '用 inbox&agent=<視窗名> 收信')
  assert.ok(reqs.some(q => q.action === 'ack' && q.agent === 'H-ASN' && q.body.ids.includes(U(1))), '收到後 ack')
  assert.equal(r.relay.mails[0].acked, true)
  assert.ok(!reqs.some(q => q.action === 'inbox' && !q.agent), '不拉整個節點信箱（那是機器橋的）')
  assert.ok(r.relay.sent.every(s => s.from_agent === 'H-ASN'), '寄信一律用現用名')
  assert.deepEqual(r.relay.sent[0], { to_node: 'W', to_agent: 'W-政策', body: '收到！我晚點看一下 :)', reply_to: U(2), from_agent: 'H-ASN', expects_reply: true })
  assert.deepEqual(r.relay.sent[1], { to_node: 'W', to_agent: 'W-政策', body: nudgeBody('H-ASN'), from_agent: 'H-ASN', expects_reply: false })
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
  if (shotCaptureSupported) {
    for (const f of ['list.png', 'chat.png']) {
      assert.ok(r.files.includes(f), `缺 ${f}`)
      assertShotNotBlank(path.join(out, f))
    }
    for (const f of r.files.filter(x => x.startsWith('tabs-'))) {
      assertShotNotBlank(path.join(out, f), { minBytes: 8000 })
    }
    assert.ok(r.files.some(f => f.startsWith('toast-')), '有提示視窗截圖')
    for (const f of r.files.filter(x => x.startsWith('toast-'))) {
      assertShotNotBlank(path.join(out, f), { minBytes: 3000, minUnique: 8 })
    }
  }
  assert.ok(fs.existsSync(path.join(r.data, 'asn-chats.json')), '對話存檔寫在資料夾')
  assert.ok(!fs.readFileSync(path.join(r.data, 'asn-chats.json'), 'utf8').includes(FAKE_KEY), '存檔裡沒有金鑰')
})

// 設定聊天窗改值：兩種模式都走 asn:set 事件進樞紐（分離模式的設定視窗就是這樣下指令），改了即時生效並寫進存檔；
// 分離模式另外要有指引、設定兩扇獨立視窗的截圖
for (const mode of ['split', 'merged']) {
  test(`設定聊天窗改值會進樞紐並存檔（${mode}）`, { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }, async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-e2e-set-'))
    const me = { winMode: mode, shotNoChat: true, shotSetting: 'look', shotSettingSet: [{ op: 'dpMode', value: 'right' }, { op: 'sound', value: 'off' }, { op: 'tabDim', value: 'status' }, { op: 'bubble', value: 'auto' }] }
    const r = await runShot(out, defaultExe, { me })
    assert.equal(r.code, 0, r.log)
    const saved = JSON.parse(fs.readFileSync(path.join(r.data, 'asn-me.json'), 'utf8'))
    assert.equal(saved.dpMode, 'right')
    assert.equal(saved.sound, false)
    assert.equal(saved.tabDim, 'status')
    assert.equal(saved.bubble, 'auto')
    assert.equal(saved.winMode, mode)
    assert.ok(!JSON.stringify(saved).includes(FAKE_KEY), '存檔裡沒有金鑰')
    if (shotCaptureSupported) {
      assert.ok(r.files.includes('tabs-settings-doc.png') && r.files.includes('tabs-guide-doc.png'))
      if (mode === 'split') for (const f of ['panel-guide.png', 'panel-setting.png']) { assert.ok(r.files.includes(f), `缺 ${f}`); assertShotNotBlank(path.join(out, f), { minBytes: 8000 }) }
      else assert.ok(!r.files.some(f => f.startsWith('panel-')), '整合模式沒有獨立視窗，指引與設定在右邊分頁')
    }
  })
}
