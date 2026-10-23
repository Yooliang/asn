// 已讀多端同步（docs/design/READ-SYNC.md）：對話鍵、純函式、AsnCore 的回寫／合併／離線補送／舊後台，以及接線守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnCore } from '../ui/lib/core.mjs'
import { batchOf, cleanMarks, lastIncomingAt, mergeMarks, readKey, readSyncSignedOut, readSyncUnsupported, unreadAfter } from '../ui/lib/read-sync.mjs'
import { memStore, sleep } from './helpers.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const PID = 'p_0123456789abcdef0123'

test('對話鍵：夥伴 ID 優先；否則 n:節點/名字；群組 g:代號；壞資料回 null；電腦與手機算出同一個值', () => {
  assert.equal(readKey({ node: 'H', agent: '小文', partnerId: PID }), PID)
  assert.equal(readKey({ node: 'H', agent: '小文' }), 'n:H/小文')
  assert.equal(readKey({ node: 'H', agent: '' }), 'n:H/', '總機（沒有名字）也有鍵')
  assert.equal(readKey({ room: 'room_1' }), 'g:room_1')
  assert.equal(readKey({ room: 'a b' }), null)
  assert.equal(readKey({ node: 'a/b', agent: 'x' }), null)
  assert.equal(readKey({ node: 'H', agent: 'a\nb' }), null)
  assert.equal(readKey({ node: 'H', agent: 'x', partnerId: 'p_bad' }), 'n:H/x', '夥伴 ID 格式不對就退回節點＋名字')
  assert.equal(readKey(null), null)
  // 與封存同一套寫法（後台 archive 鍵）
  assert.equal(readKey({ node: 'H', agent: '沒夥伴' }), 'n:H/沒夥伴')
  // 兩端都用 core.mjs 的同一個函式，不得各寫一份
  assert.match(read('ui', 'lib', 'core.mjs'), /import \{[^}]*readKey[^}]*\} from '\.\/read-sync\.mjs'/)
  assert.doesNotMatch(read('ui', 'm.js') + read('ui', 'list.js'), /readKey\s*=|function readKey/)
})

test('純函式：最後一則收到的信、已讀位置之後還有幾則、合併只往前、整理外部資料', () => {
  const log = [{ k: 'them', t: 10 }, { k: 'me', t: 20 }, { k: 'sys', nudge: true, t: 30 }, { k: 'sys', nudge: true, mine: true, t: 99 }, { k: 'sys', text: 'x', t: 98 }, { k: 'them', t: 25 }]
  assert.equal(lastIncomingAt(log), 30, '自己的信、自己的震動、一般系統行不算')
  assert.equal(lastIncomingAt([]), 0)
  assert.equal(lastIncomingAt(null), 0)
  assert.equal(unreadAfter(log, 0), 3)
  assert.equal(unreadAfter(log, 10), 2)
  assert.equal(unreadAfter(log, 30), 0)
  assert.deepEqual(mergeMarks({ a1x: 5, b2y: 9 }, { a1x: 7, b2y: 3, c3z: 1 }), { a1x: 7, b2y: 9, c3z: 1 })
  assert.deepEqual(cleanMarks({ ok1: 5.9, ab: 5, neg: -1, str: '5', big: 1e15, nan: NaN }), { ok1: 5 })
  assert.deepEqual(cleanMarks([1]), {})
  assert.deepEqual(cleanMarks(null), {})
  const dirty = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`n:H/${i}`, i + 1]))
  const b = batchOf(dirty)
  assert.equal(b.length, 100)
  assert.deepEqual(b[0], { key: 'n:H/129', at: 130 }, '較新的先送')
  assert.ok(readSyncUnsupported('read_sync HTTP 404 not_found') && !readSyncUnsupported('read_sync 連線失敗'))
  assert.ok(readSyncSignedOut('尚未登入，無法同步已讀') && !readSyncSignedOut('x'))
})

// 假帳號：兩台設備共用的後台（模擬資料庫 greatest 語意）
function fakeAccount() {
  const marks = {}
  const calls = []
  return {
    marks, calls, off: false, offline: false, signedOut: false,
    transportFor(mail) {
      const self = this
      return {
        list: async () => ({ members: [{ id: 'H', agents: [{ name: '小文', status: 'idle', partner_id: PID }] }] }),
        inbox: async () => ({ messages: mail.splice(0) }),
        ack: async () => ({}),
        readSync: async body => {
          if (self.signedOut) throw new Error('尚未登入，無法同步已讀')
          if (self.off) throw new Error('read_sync HTTP 404 not_found')
          if (self.offline) throw new Error('read_sync 連線失敗：timeout')
          calls.push(JSON.parse(JSON.stringify(body)))
          for (const m of body.marks) marks[m.key] = Math.max(marks[m.key] ?? 0, m.at)
          return { ok: true, marks: { ...marks } }
        },
      }
    },
  }
}
const mailAt = (id, t) => ({ id, to_agent: 'D-ASN', from_node: 'H', from_agent: '小文', body: `m${id}`, created_at: new Date(t).toISOString() })
function device(acct, mail, store = memStore()) {
  const core = new AsnCore({ transport: acct.transportFor(mail), store, selfNode: 'D', windowName: 'D-ASN', pollMs: 3_600_000, rosterMs: 3_600_000 })
  return core
}
const unreadOf = core => core.snapshot().friends.find(f => f.id === 'H/小文').unread

test('多端：A 讀了，B 下一次同步就消掉未讀；只讀一部分就只消一部分', async () => {
  const acct = fakeAccount()
  const A = device(acct, [mailAt('1', 1000), mailAt('2', 2000)])
  const B = device(acct, [mailAt('1', 1000), mailAt('2', 2000), mailAt('3', 3000)])
  await A.start(); await B.start()
  assert.equal(unreadOf(A), 2); assert.equal(unreadOf(B), 3)
  A.markRead('H/小文')
  await sleep(3300)
  assert.deepEqual(acct.marks, { [PID]: 2000 }, '後台記的是最後一則收到的信的時間，不是設備時鐘')
  await B.syncReads()
  assert.equal(unreadOf(B), 1, 'B 還有一則比已讀位置新的')
  B.markRead('H/小文')
  assert.equal(unreadOf(B), 0)
  await A.stop(); await B.stop()
})

test('多端：已讀位置只往前——舊設備晚送較舊的位置不會把後台倒退，也不會讓已清掉的未讀跑回來', async () => {
  const acct = fakeAccount()
  const A = device(acct, [mailAt('1', 1000), mailAt('2', 2000)])
  await A.start()
  A.markRead('H/小文')
  await A.syncReads()
  assert.equal(acct.marks[PID], 2000)
  await A.transport.readSync({ marks: [{ key: PID, at: 500 }] })
  assert.equal(acct.marks[PID], 2000)
  await A.syncReads()
  assert.equal(unreadOf(A), 0)
  await A.stop()
})

test('多端：別台已經讀過的信，這台之後才收到，不算未讀', async () => {
  const acct = fakeAccount()
  acct.marks[PID] = 5000
  const mail = []
  const B = device(acct, mail)
  await B.start()          // 啟動時先取回已讀位置
  mail.push(mailAt('1', 4000), mailAt('2', 5000), mailAt('3', 6000))
  await B.pull()
  assert.equal(unreadOf(B), 1, '只有比已讀位置新的 6000 算未讀')
  await B.stop()
})

test('節流：連讀多位只打一次；讀同一位不重送；沒有新進度不呼叫', async () => {
  const acct = fakeAccount()
  const A = device(acct, [mailAt('1', 1000)])
  await A.start()
  acct.calls.length = 0
  A.markRead('H/小文'); A.markRead('H/小文'); A.markRead('H/小文')
  await sleep(3300)
  assert.equal(acct.calls.length, 1, '三次標已讀只回寫一次')
  assert.deepEqual(acct.calls[0].marks, [{ key: PID, at: 1000 }])
  A.markRead('H/小文'); await sleep(3300)
  assert.equal(acct.calls.length, 1, '位置沒前進就不再送')
  await A.stop()
})

test('對話開著時收到信：當場記為已讀並回寫', async () => {
  const acct = fakeAccount()
  const mail = []
  const core = new AsnCore({ transport: acct.transportFor(mail), store: memStore(), selfNode: 'D', windowName: 'D-ASN', isChatVisible: async () => true, pollMs: 3_600_000, rosterMs: 3_600_000 })
  await core.start()
  mail.push(mailAt('1', 1000)); await core.pull()
  await sleep(3300)
  assert.equal(acct.marks[PID], 1000)
  assert.equal(unreadOf(core), 0)
  await core.stop()
})

test('離線：本機先記，連上後補送；存檔後重開也不遺失待送', async () => {
  const acct = fakeAccount()
  const store = memStore()
  const A = device(acct, [mailAt('1', 1000)], store)
  await A.start()
  acct.offline = true
  A.markRead('H/小文')
  await sleep(3300)
  assert.deepEqual(acct.marks, {}, '離線時沒送出')
  await A.flush()
  assert.deepEqual(store.data.readDirty, { [PID]: 1000 }, '待送寫進本機存檔')
  await A.stop()
  acct.offline = false
  const A2 = device(acct, [], store)
  await A2.start()   // 啟動時補送
  assert.equal(acct.marks[PID], 1000)
  await A2.flush()
  assert.equal(store.data.readDirty, undefined, '送出後存檔不再帶待送')
  await A2.stop()
})

test('相容：舊後台（404）靜默退回本機行為且這次不再問；沒登入完全靜默；沒有 readSync 的舊 transport 照常', async () => {
  const acct = fakeAccount(); acct.off = true
  const logs = []
  const A = new AsnCore({ transport: acct.transportFor([mailAt('1', 1000)]), store: memStore(), selfNode: 'D', windowName: 'D-ASN', log: m => logs.push(m), pollMs: 3_600_000, rosterMs: 3_600_000 })
  await A.start()
  A.markRead('H/小文')
  assert.equal(unreadOf(A), 0, '本機照樣清')
  await A.syncReads()
  assert.equal(A.readOff, true)
  assert.deepEqual(logs.filter(l => /read_sync/.test(l)), [], '404 不吵')
  acct.off = false
  await A.syncReads(); assert.deepEqual(acct.calls, [], '這次執行不再問')
  await A.stop()
  const acct2 = fakeAccount(); acct2.signedOut = true
  const logs2 = []
  const B = new AsnCore({ transport: acct2.transportFor([mailAt('1', 1000)]), store: memStore(), selfNode: 'D', windowName: 'D-ASN', log: m => logs2.push(m), pollMs: 3_600_000, rosterMs: 3_600_000 })
  await B.start(); B.markRead('H/小文'); await sleep(3300)
  assert.equal(B.readOff, false, '沒登入不算不支援，登入後會再試')
  assert.deepEqual(logs2.filter(l => /read_sync/.test(l)), [])
  await B.stop()
  const old = acct.transportFor([mailAt('1', 1000)]); delete old.readSync
  const C = new AsnCore({ transport: old, store: memStore(), selfNode: 'D', windowName: 'D-ASN', pollMs: 3_600_000, rosterMs: 3_600_000 })
  await C.start(); C.markRead('H/小文'); assert.equal(unreadOf(C), 0); await C.stop()
})

test('守門：兩端 transport、Rust 指令（電腦與手機清單都有）、本人簽章、後台只對 read_sync 讀簽章', () => {
  assert.match(read('ui', 'lib', 'tauri.mjs'), /readSync: body => invoke\('relay_read_sync', \{ body \}\)/)
  assert.match(read('ui', 'm.js'), /readSync: body => invoke\('relay_read_sync', \{ body \}\)/)
  const lib = read('src-tauri', 'src', 'lib.rs')
  assert.match(lib, /#\[tauri::command\]\nasync fn relay_read_sync\([^)]*\) -> Result<Value, String> \{\n    let r = relay_of\(&app\)\?;\n    let token = account::signing_token\(&auth\)\.await;\n    r\.read_sync_signed\(&body, token\.as_deref\(\)\)\.await/)
  const d = /#\[cfg\(desktop\)\]\n\s*let builder = builder\s*\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  const mob = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  assert.match(d[1], /\brelay_read_sync\b/); assert.match(mob[1], /\brelay_read_sync\b/)
  assert.match(read('src-tauri', 'src', 'relay.rs'), /pub async fn read_sync_signed[\s\S]*?ok_or\("尚未登入，無法同步已讀"\)\?;[\s\S]*?api_signed\("read_sync"/)
  const idx = read('..', '..', 'supabase', 'functions', 'relay', 'index.ts')
  assert.match(idx, /action === "read_sync"\) \{[\s\S]*?signedUserId\(accountDeps\.verifyJwt, req\.headers\.get\(SIGN_HEADER\)\)[\s\S]*?requestReadSync\(/)
})
