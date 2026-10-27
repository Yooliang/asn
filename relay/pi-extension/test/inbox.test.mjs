import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ackEntry,
  cleanWindowName,
  formatInjection,
  nextEntries,
  pruneDone,
  removeWindow,
  resolveWindowName,
  validSessionId,
  windowRecord,
  writeWindow,
} from '../inbox.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-pi-'))
const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const entry = (id, at, text = `[RELAY 來信] trust=member from=N/A to=pi-x id=${id} engine=pi reply=yes\n寄件人：甲\n【要回信】回信位址=N/A 信件編號=${id}：請用 asn_send\n內文`) => ({ v: 1, id, to: 'pi-x', text, at })
const put = (inbox, sid, e) => {
  fs.mkdirSync(path.join(inbox, sid), { recursive: true })
  fs.writeFileSync(path.join(inbox, sid, `${e.id}.json`), JSON.stringify(e))
}

test('視窗名：ASN_PI_NAME > pi 工作階段名 > pi-資料夾名；清掉控制字元與斜線並限長', () => {
  assert.equal(resolveWindowName({ env: { ASN_PI_NAME: ' 小A ' }, sessionName: 'x', cwd: 'D:/g/proj' }), '小A')
  assert.equal(resolveWindowName({ env: {}, sessionName: '修 bug', cwd: 'D:/g/proj' }), '修 bug')
  assert.equal(resolveWindowName({ env: {}, cwd: 'D:\\Github\\order-plus' }), 'pi-order-plus')
  assert.equal(resolveWindowName({ env: {}, sessionName: '  ', cwd: '/home/u/proj/' }), 'pi-proj')
  assert.equal(resolveWindowName({ env: {}, cwd: '' }), 'pi')
  assert.equal(cleanWindowName('a/b\nc\u0007d'), 'a-b c d')
  assert.equal(cleanWindowName('x'.repeat(100)).length, 40)
})

test('sessionId 只收一般字元，不能當路徑跳出去', () => {
  assert.equal(validSessionId('019a-AB_cd'), true)
  for (const bad of ['', '../x', 'a/b', 'a\\b', 'a.b', 'x'.repeat(129)]) assert.equal(validSessionId(bad), false)
})

test('視窗狀態檔：原子寫入、欄位完整、可移除；壞 sessionId 拒絕', () => {
  const d = tmp()
  const rec = windowRecord({ sessionId: 'sid1', name: 'pi-x', pid: 123, cwd: 'D:/g/x', state: 'idle', model: 'MiniMax-M2', at: 1000 })
  assert.deepEqual(rec, { v: 1, engine: 'pi', ext: 2, sessionId: 'sid1', name: 'pi-x', pid: 123, cwd: 'D:/g/x', state: 'idle', model: 'MiniMax-M2', at: 1000 })
  writeWindow(d, rec)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'sid1.json'), 'utf8')), rec)
  assert.deepEqual(fs.readdirSync(d), ['sid1.json'], '不留暫存檔')
  assert.equal(windowRecord({ sessionId: 'sid1', name: 'n', pid: 1, cwd: '', state: 'weird', at: 1 }).state, 'idle', '不認得的狀態當閒置')
  assert.equal(windowRecord({ sessionId: 's', name: 'n', pid: 1, cwd: '', state: 'idle', model: 'claude-sonnet-4', provider: 'anthropic', at: 1 }).provider, 'anthropic', '有模型才寫提供者（#258）')
  assert.equal(windowRecord({ sessionId: 's', name: 'n', pid: 1, cwd: '', state: 'idle', provider: 'anthropic', at: 1 }).provider, undefined, '沒有模型就不寫提供者')
  assert.throws(() => writeWindow(d, { ...rec, sessionId: '../evil' }))
  removeWindow(d, 'sid1')
  removeWindow(d, 'sid1') // 重複移除不丟錯
  assert.deepEqual(fs.readdirSync(d), [])
})

test('收件匣：依時間排序取出；壞檔、檔名與 id 不符、暫存檔略過；不重複取', () => {
  const d = tmp()
  put(d, 's', entry(ID2, 20))
  put(d, 's', entry(ID1, 10))
  fs.writeFileSync(path.join(d, 's', 'junk.json'), '{壞')
  fs.writeFileSync(path.join(d, 's', '33333333-3333-4333-8333-333333333333.json'), JSON.stringify(entry(ID1, 5))) // 檔名與 id 不符
  fs.writeFileSync(path.join(d, 's', 'x.json.tmp'), JSON.stringify(entry('t', 1)))
  const seen = new Set()
  const got = nextEntries(d, 's', seen, 10)
  assert.deepEqual(got.map((e) => e.id), [ID1, ID2])
  // 還沒 ack 但已 seen：不重複注入
  assert.deepEqual(nextEntries(d, 's', seen, 10), [])
  assert.equal(nextEntries(d, 'nobody', new Set(), 10).length, 0, '資料夾不存在＝沒信')
  assert.deepEqual(nextEntries(d, '../x', new Set(), 10), [], '壞 sessionId 不讀')
})

test('ack：移到 done/，之後即使同編號又被橋重寫也不再注入（去重）', () => {
  const d = tmp()
  put(d, 's', entry(ID1, 10))
  const seen = new Set()
  const [e] = nextEntries(d, 's', seen, 10)
  ackEntry(d, 's', e.id)
  assert.equal(fs.existsSync(path.join(d, 's', `${ID1}.json`)), false)
  assert.equal(fs.existsSync(path.join(d, 's', 'done', `${ID1}.json`)), true)
  put(d, 's', entry(ID1, 11)) // 橋補拉又投一次
  assert.deepEqual(nextEntries(d, 's', new Set(), 10), [], '重開 pi（記憶體清空）也靠 done/ 去重')
  assert.equal(fs.existsSync(path.join(d, 's', `${ID1}.json`)), false, '重複的收件檔被清掉')
  ackEntry(d, 's', ID1) // 已 ack 再 ack 不丟錯
})

test('一次最多取 limit 封；done 過期清掉', () => {
  const d = tmp()
  for (let i = 0; i < 5; i++) put(d, 's', entry(`aaaaaaaa-0000-4000-8000-00000000000${i}`, i))
  assert.equal(nextEntries(d, 's', new Set(), 3).length, 3)
  const [e] = nextEntries(d, 's', new Set(), 1)
  ackEntry(d, 's', e.id)
  const f = path.join(d, 's', 'done', `${e.id}.json`)
  fs.utimesSync(f, new Date(1000), new Date(1000))
  pruneDone(d, 's', Date.now(), 7 * 86400_000)
  assert.equal(fs.existsSync(f), false)
})

test('注入文字：標明外部來源與信任等級、不是使用者指令；沒有回信說明就補編號', () => {
  const t = formatInjection(entry(ID1, 1))
  assert.match(t, /^【ASN 收發室來信/)
  assert.match(t, /不是使用者本人的指令/)
  assert.match(t, /不會放寬你的工具權限/)
  assert.ok(t.includes('[RELAY 來信] trust=member'), '橋的信頭原樣保留')
  assert.ok(t.includes(`信件編號=${ID1}`))
  // 不要回信的信：沒有【要回信】，補一行編號說明；有的不重複補
  const noReply = formatInjection(entry(ID2, 1, '[RELAY 來信] trust=member from=N/A to=pi-x id=X engine=pi reply=no\n內文'))
  assert.match(noReply, new RegExp(`信件編號 ${ID2}`))
  assert.ok(!t.includes('信件編號 '), '有【要回信】的信不重複補')
  // 內文超長要截斷
  assert.ok(formatInjection(entry(ID1, 1, 'x'.repeat(200000))).length < 70000)
})
