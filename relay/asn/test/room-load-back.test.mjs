// 點群組訊息編號、那一則還沒載入（#1530）：樞紐往前補載到那一則。接得上已載入的、不標已讀、太舊不讀、找不到照實說。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'
import { createGroupApi } from '../ui/lib/groups.mjs'
import { ROOM_BACK_MAX, ROOM_KEEP, mergeRoomLog, roomPseudoFriend } from '../ui/lib/mobile-rooms.mjs'

const me = { key: '~u:u1', label: '我', member_kind: 'human', mine: true }
const LAST = 3931

// 後台：群組有 visibleFrom..LAST 這幾則；since 之後依序回最多 limit 則（跟 asn_relay_group_read 帶 since 時一樣是由舊到新）
function setup({ visibleFrom = 1, fail = false } = {}) {
  const calls = []
  const msg = seq => ({ seq, body: `第 ${seq} 則`, from: 'W~甲', from_kind: 'ai', at: '2026-11-15T00:00:00Z' })
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'relay_rooms') return { rooms: [{ id: 'g', name: 'Asn', last_seq: LAST, mine: [{ member: '~u:u1', unread: 0 }], members: [me] }] }
    if (cmd === 'relay_room_read') {
      if (fail && args.since < LAST - 60) throw new Error('HTTP 500')
      const from = Math.max(args.since + 1, visibleFrom), out = []
      for (let s = from; s <= LAST && out.length < args.limit; s++) out.push(msg(s))
      return { messages: out, last_seq: LAST }
    }
    return {}
  }
  const hub = createRoomHub({ invoke, groupApi: createGroupApi(invoke), selfNode: 'T', windowName: 'w', visible: () => true })
  const reads = () => calls.filter(([c]) => c === 'relay_room_read').map(([, a]) => a)
  return { hub, reads }
}
const seqs = hub => hub.st.logs.g.map(e => e.seq)
const contiguous = a => a.every((s, i) => i === 0 || s === a[i - 1] + 1)

test('還沒載入的那一則：從它往後讀到接上已載入最舊的，記錄連續、不標已讀', async () => {
  const { hub, reads } = setup()
  await hub.open('g')
  assert.equal(seqs(hub)[0], LAST - 49, '第一次只載最近 50 則')
  const n = reads().length
  const r = await hub.loadBack('g', 3500)
  assert.deepEqual(r, { found: true })
  const s = seqs(hub)
  assert.equal(s[0], 3500); assert.equal(s.at(-1), LAST); assert.ok(contiguous(s), '中間沒有缺口')
  const back = reads().slice(n)
  assert.ok(back.length >= 2 && back.every(a => a.limit <= 200 && a.mark === false), '每次最多 200 則、都不標已讀')
  assert.equal(back[0].since, 3499)
  // 之後的新訊息合併不會把補載的剪掉
  assert.equal(mergeRoomLog(hub.st.logs.g, []).length, s.length)
})

test('已經載入的不再讀；比群組最新的還新、或比已載入最舊的舊太多都不讀', async () => {
  const { hub, reads } = setup()
  await hub.open('g')
  const n = reads().length
  assert.deepEqual(await hub.loadBack('g', LAST - 3), { found: true })
  assert.deepEqual(await hub.loadBack('g', LAST + 5), { found: false })
  assert.deepEqual(await hub.loadBack('g', LAST - 50 - ROOM_BACK_MAX - 1), { found: false, tooOld: true })
  assert.deepEqual(await hub.loadBack('g', 0), { found: false })
  assert.deepEqual(await hub.loadBack('g', 1.5), { found: false })
  assert.deepEqual(await hub.loadBack('nope', 3900), { found: false })
  assert.equal(reads().length, n, '這些情況都沒有去讀')
})

test('加入前的訊息看不到（後台不回）：說載不到，不會一直讀', async () => {
  const { hub, reads } = setup({ visibleFrom: 3800 })
  await hub.open('g')
  const n = reads().length
  assert.deepEqual(await hub.loadBack('g', 3500), { found: false, tooOld: true })
  assert.ok(reads().length - n <= 2)
  assert.equal(seqs(hub)[0], 3800, '看得到的那段照樣補進來')
})

test('讀到一半失敗：回 error，已讀到的留著', async () => {
  const { hub } = setup({ fail: true })
  await hub.open('g')
  const r = await hub.loadBack('g', 3700)
  assert.equal(r.found, false); assert.equal(r.error, true)
})

test('補載過後畫面最多留 ROOM_KEEP＋ROOM_BACK_MAX 則；沒補載過照舊只留 ROOM_KEEP 則', () => {
  const e = s => ({ seq: s })
  const many = Array.from({ length: ROOM_KEEP + 20 }, (_, i) => e(i + 1))
  assert.equal(mergeRoomLog([], many).length, ROOM_KEEP)
  const big = Array.from({ length: ROOM_KEEP + 500 }, (_, i) => e(i + 1))
  assert.equal(mergeRoomLog(big, [e(10_000)]).length, ROOM_KEEP + 500)
  const huge = Array.from({ length: ROOM_KEEP + ROOM_BACK_MAX + 50 }, (_, i) => e(i + 1))
  assert.equal(mergeRoomLog(huge, []).length, ROOM_KEEP + ROOM_BACK_MAX)
})

test('群組的假夥伴帶最新序號（判斷 #N 用）；三個頁面都把 toSeq 接到樞紐', () => {
  assert.equal(roomPseudoFriend({ chatId: 'room:g', name: 'Asn', count: 3, lastSeq: LAST }).lastSeq, LAST)
  assert.equal(roomPseudoFriend({ chatId: 'room:g', name: 'Asn', count: 3 }).lastSeq, 0)
  const rd = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
  assert.match(rd('list.js'), /hub\.loadBack\(roomIdOf\(id\), seq\)/)
  assert.match(rd('list.js'), /c\.op === 'older'\) \{ const r = await loadOlder\(c\.id, Number\.isInteger\(c\.toSeq\)/)
  assert.match(rd('chat.js'), /op: 'older', id: fid, \.\.\.\(Number\.isInteger\(opts\?\.toSeq\)/)
  assert.match(rd('m.js'), /isRoomChat\(id\) && Number\.isInteger\(opts\?\.toSeq\) \? hub\.loadBack\(roomIdOf\(id\), opts\.toSeq\)/)
})
