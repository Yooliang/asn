// #2161 B1：門鈴帶種類——私信不重抓群組清單、名單門鈴節流（尾端補一次）、沒帶種類照舊全抓
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRoomBellGate, ROSTER_BELL_GAP_MS } from '../ui/lib/bell-rooms.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

// 假時鐘＋假計時器；refresh 和真的接線一樣，一開始就呼叫 noteRefresh
function rig() {
  let t = 1_000_000, seq = 0
  const timers = new Map()
  const out = { refreshed: [], keys: [] }
  const gate = createRoomBellGate({
    refresh: () => { out.refreshed.push(t); gate.noteRefresh() },
    counter: { hit: k => out.keys.push(k) },
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++seq, { at: t + ms, fn }); return seq },
    clearTimer: id => { timers.delete(id) },
  })
  const advance = ms => {
    const end = t + ms
    for (;;) {
      const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); t = due[1].at; due[1].fn()
    }
    t = end
  }
  return { gate, out, timers, advance, jump: ms => { t += ms }, at: () => t }
}

test('沒帶種類＝照舊全抓：剛抓完再響也馬上抓，每一聲都抓', () => {
  const r = rig()
  r.gate.noteRefresh()
  for (const p of [undefined, null, {}, { kind: null }, { kind: '' }, { kind: 7 }]) r.gate.ring(p)
  assert.equal(r.out.refreshed.length, 6)
  assert.equal(r.timers.size, 0)
  assert.deepEqual([...new Set(r.out.keys)], ['bell:none'])
})

test('不認得的種類也照舊全抓', () => {
  const r = rig()
  r.gate.noteRefresh()
  r.gate.ring({ kind: 'room' }); r.gate.ring({ kind: 'something_new' })
  assert.equal(r.out.refreshed.length, 2)
  assert.deepEqual(r.out.keys, ['bell:room', 'bell:something_new'])
})

test('mail：不重抓、也不排補抓', () => {
  const r = rig()
  r.gate.ring({ kind: 'mail' })
  r.advance(120_000)
  assert.equal(r.out.refreshed.length, 0)
  assert.equal(r.timers.size, 0)
  assert.deepEqual(r.out.keys, ['bell:mail'])
})

test('roster：超過 30 秒沒抓過就馬上抓', () => {
  const r = rig()
  r.gate.ring({ kind: 'roster' })
  assert.equal(r.out.refreshed.length, 1, '從沒抓過')
  r.jump(ROSTER_BELL_GAP_MS)
  r.gate.ring({ kind: 'roster' })
  assert.equal(r.out.refreshed.length, 2, '剛好滿 30 秒')
  assert.equal(r.timers.size, 0)
})

test('roster：30 秒內響多次併成一次，期滿一定補抓', () => {
  const r = rig()
  r.gate.noteRefresh()
  const start = r.at()
  r.advance(5_000); r.gate.ring({ kind: 'roster' })
  r.advance(5_000); r.gate.ring({ kind: 'roster' })
  r.advance(5_000); r.gate.ring({ kind: 'roster' })
  assert.equal(r.out.refreshed.length, 0)
  assert.equal(r.timers.size, 1, '只排一個補抓')
  r.advance(ROSTER_BELL_GAP_MS)
  assert.deepEqual(r.out.refreshed, [start + ROSTER_BELL_GAP_MS], '期滿補抓一次，時間從上次重抓起算')
  assert.equal(r.timers.size, 0)
})

test('roster：補抓之後再響，從補抓那次重新起算', () => {
  const r = rig()
  r.gate.noteRefresh()
  const start = r.at()
  r.advance(10_000); r.gate.ring({ kind: 'roster' })
  r.advance(25_000)                       // 第 30 秒補抓過了，現在第 35 秒
  r.gate.ring({ kind: 'roster' })
  r.advance(60_000)
  assert.deepEqual(r.out.refreshed, [start + 30_000, start + 60_000])
})

test('roster 還在等的時候別的原因重抓了：取消補抓（不抓兩次）', () => {
  const r = rig()
  r.gate.noteRefresh()
  r.advance(5_000); r.gate.ring({ kind: 'roster' })
  r.advance(5_000); r.gate.ring({})       // 群組門鈴：馬上抓，涵蓋名單變化
  assert.equal(r.timers.size, 0)
  r.advance(60_000)
  assert.equal(r.out.refreshed.length, 1)
})

test('roster 還在等的時候來了 mail：補抓照舊', () => {
  const r = rig()
  r.gate.noteRefresh()
  r.advance(5_000); r.gate.ring({ kind: 'roster' }); r.gate.ring({ kind: 'mail' })
  r.advance(60_000)
  assert.equal(r.out.refreshed.length, 1)
})

test('roster：時鐘往回跳，最多等 30 秒', () => {
  const r = rig()
  r.gate.noteRefresh()
  r.jump(-3_600_000)
  r.gate.ring({ kind: 'roster' })
  r.advance(ROSTER_BELL_GAP_MS)
  assert.equal(r.out.refreshed.length, 1)
})

test('接線：list.js、m.js 的門鈴把內容交給 roomBells，不再直接重抓', () => {
  const list = read('../ui/list.js'), m = read('../ui/m.js')
  for (const [name, src] of [['list.js', list], ['m.js', m]]) {
    const top = src.split('\n').find(l => /^\s*core\.on\('relay-bell'/.test(l))
    assert.ok(top, `${name} 頂層門鈴不見了`)
    assert.ok(/core\.on\('relay-bell', p => \{[^\n]*roomBells\.ring\(p\)/.test(top), `${name} 要把門鈴內容交給 roomBells.ring`)
    assert.ok(!/refreshRooms\('bell'\)|roomsHook\.refresh/.test(top.split('//')[0]), `${name} 門鈴不能繞過分流直接重抓`)
  }
  assert.ok(list.includes("createRoomBellGate({ refresh: () => void refreshRooms('bell'), counter: roomPollCounter })"))
  assert.ok(m.includes('createRoomBellGate({ refresh: () => void roomsHook.refresh?.() })'))
})

test('接線：每次重抓群組清單都先告訴 roomBells', () => {
  for (const f of ['../ui/list.js', '../ui/m.js']) {
    const lines = read(f).split('\n')
    const i = lines.findIndex(l => /^\s*async function refreshRooms\(/.test(l))
    assert.ok(i >= 0, f)
    const body = lines.slice(i, i + 5)
    const noted = body.findIndex(l => /^\s*roomBells\.noteRefresh\(\)/.test(l))
    const fetched = body.findIndex(l => /await hub\.refresh\(\)/.test(l))
    assert.ok(noted > 0 && fetched > noted, `${f}：refreshRooms 要先 noteRefresh 再抓`)
  }
})

test('接線：後台只有寄信和名單兩處帶種類；群組那條路不帶', () => {
  const index = read('../../../supabase/functions/relay/index.ts')
  assert.ok(index.includes('for (const t of rosterBellTopics(data)) await ring(t, { kind: "roster" });'))
  assert.ok(index.includes('for (const t of bellTopicsOf(sent)) await ring(t, { kind: "mail" });'))
  const code = index.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join(' ')   // 註解裡提到種類不算
  assert.equal(code.split('kind: "roster"').length, 2, '名單種類只有一處')
  assert.equal(code.split('kind: "mail"').length, 2, '寄信種類只有一處')
  for (const f of ['rooms.ts', 'groups.ts']) {
    const src = read(`../../../supabase/functions/_shared/${f}`)
    assert.ok(!/kind: "(mail|roster)"/.test(src), `${f} 的門鈴不帶 mail／roster，用戶端才會照舊重抓群組`)
  }
})
