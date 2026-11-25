// #2038 PR-4：邀請連結、正在聽的歌、終端被誰看 從事件中心訂閱（觸發事件 → 看到結果）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEventHub } from '../ui/lib/event-hub.mjs'
import { watchInvite, watchNowPlaying, watchBeingViewed } from '../ui/lib/notice-events.mjs'
import { HUB_MIGRATED } from '../ui/lib/rust-events.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function fakeTauri() {
  const regs = []
  const listen = (evt, fn) => { const r = { evt, fn, offs: 0 }; regs.push(r); return Promise.resolve(() => { r.offs++ }) }
  const fire = (evt, payload) => { for (const r of regs) if (r.evt === evt && r.offs === 0) r.fn(payload) }
  const live = evt => regs.filter(r => r.evt === evt && r.offs === 0).length
  return { listen, fire, live }
}
const setup = () => { const t = fakeTauri(); return { t, hub: createEventHub({ listen: t.listen }) } }

test('邀請連結：收到事件 → 帶著邀請碼呼叫加入；退訂後不再觸發', async () => {
  const { t, hub } = setup()
  const got = []
  const off = watchInvite(hub, c => got.push(c))
  await hub.ready()
  assert.equal(t.live('asn:invite'), 1)
  t.fire('asn:invite', 'abc123')
  assert.deepEqual(got, ['abc123'])
  off()
  assert.equal(t.live('asn:invite'), 0)
  t.fire('asn:invite', 'zzz')
  assert.deepEqual(got, ['abc123'])
})

test('正在聽的歌：開關開著顯示歌名、關著清空、沒內容是空字串', async () => {
  const { t, hub } = setup()
  let on = true, text = ''
  watchNowPlaying(hub, { isOn: () => on, setText: s => { text = s } })
  await hub.ready()
  t.fire('asn:now-playing', '晴天 - 周杰倫')
  assert.equal(text, '晴天 - 周杰倫')
  t.fire('asn:now-playing', null)
  assert.equal(text, '')
  on = false
  t.fire('asn:now-playing', '別的歌')
  assert.equal(text, '', '開關關著不顯示')
})

test('被看畫面提示：收到陣列 → 名單更新；不是陣列 → 當成沒人看', async () => {
  const { t, hub } = setup()
  let list = null
  watchBeingViewed(hub, l => { list = l })
  await hub.ready()
  const who = [{ view_id: 'v1', node: 'n1' }]
  t.fire('term-being-viewed', who)
  assert.equal(list, who)
  t.fire('term-being-viewed', 'oops')
  assert.deepEqual(list, [])
  t.fire('term-being-viewed', who)
  t.fire('term-being-viewed', undefined)
  assert.deepEqual(list, [])
})

test('接線：list.js／m.js 用 core.hub 訂閱這三種，不再直接 listen；沒另外建 hub；沒新增 term-req-update／window-spool 接收者', () => {
  const lj = read('ui/list.js'), mj = read('ui/m.js'), tj = read('ui/lib/tauri.mjs')
  assert.match(lj, /watchInvite\(core\.hub, onInviteCode\)/)
  assert.match(lj, /watchBeingViewed\(core\.hub,/)
  assert.match(lj, /watchNowPlaying\(core\.hub,/)
  assert.match(mj, /watchInvite\(core\.hub, onInviteCode\)/)
  for (const e of ['asn:invite', 'asn:now-playing', 'term-being-viewed']) {
    assert.ok(!lj.includes(`listen('${e}'`) && !mj.includes(`listen('${e}'`), `${e} 不該再直接 listen`)
    assert.ok(HUB_MIGRATED.includes(e), `${e} 要登記在 HUB_MIGRATED`)
  }
  assert.equal((tj.match(/createWindowHub\(/g) ?? []).length, 2, 'tauri.mjs 的 createWindowHub 不增加（定義一次＋attach-cache-cleared 一次）')
  for (const e of ['term-req-update', 'window-spool']) {
    for (const [n, s] of [['list.js', lj], ['m.js', mj]]) assert.ok(!s.includes(`'${e}'`), `${n} 不該接 ${e}（#2332 處理中）`)
  }
})
