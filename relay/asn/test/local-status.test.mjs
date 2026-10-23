// 名單即時：本機視窗直接讀本機狀態、門鈴／回前景合併重拉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { coalesced, overlayLocal } from '../ui/lib/local-status.mjs'
import { isTabBusy } from '../ui/lib/ctabs.mjs'
import { memStore } from './helpers.mjs'

const fr = (id, node, status, extra = {}) => [id, { id, node, agent: id.split('/')[1], nick: id.split('/')[1], status, psm: 'asn', contextPct: null, ...extra }]

test('overlayLocal：只動自己節點、在線、本機找得到的；沒變回 null', () => {
  const m = new Map([fr('T/甲', 'T', 'busy'), fr('T/乙', 'T', 'offline'), fr('W/丙', 'W', 'busy'), fr('T/丁', 'T', 'online')])
  const cwd = new Map([['T/甲', 'asn']])
  const next = overlayLocal(m, 'T', [
    { name: '甲', status: 'idle', detail: null, context_pct: 42.4 },
    { name: '乙', status: 'idle' },
    { name: '丙', status: 'idle' },
  ], cwd)
  assert.equal(next.get('T/甲').status, 'online', '忙碌→閒置立刻生效')
  assert.equal(next.get('T/甲').contextPct, 42)
  assert.equal(next.get('T/乙').status, 'offline', '離線的不復活')
  assert.equal(next.get('W/丙').status, 'busy', '別台的不動')
  assert.equal(next.get('T/丁').status, 'online', '本機沒有的維持名單')
  assert.equal(m.get('T/甲').status, 'busy', '不改原 Map')
  assert.equal(overlayLocal(next, 'T', [{ name: '甲', status: 'idle', context_pct: 42 }], cwd), null)
  assert.equal(overlayLocal(m, 'T', [], cwd), null)
  assert.equal(overlayLocal(m, 'T', null, cwd), null)
})

test('overlayLocal：說明重組成「資料夾・說明」，說明消失就只剩資料夾；忙碌類狀態對應分頁忙碌', () => {
  const m = new Map([fr('T/甲', 'T', 'online', { psm: 'asn' })])
  const cwd = new Map([['T/甲', 'asn']])
  const a = overlayLocal(m, 'T', [{ name: '甲', status: 'busy', detail: '背景工作中' }], cwd)
  assert.equal(a.get('T/甲').psm, 'asn・背景工作中')
  assert.equal(isTabBusy(a.get('T/甲')), true)
  const b = overlayLocal(a, 'T', [{ name: '甲', status: 'idle', detail: null }], cwd)
  assert.equal(b.get('T/甲').psm, 'asn')
  assert.equal(isTabBusy(b.get('T/甲')), false)
})

test('coalesced：第一次立刻跑，間隔內多次合併成一次尾巴，執行中又敲會補跑', async () => {
  let t = 1000
  const timers = []
  let runs = 0
  const trig = coalesced(async () => { runs++ }, 1000, { now: () => t, setT: (fn, ms) => { timers.push([fn, ms]); return timers.length } })
  trig()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(runs, 1)
  t = 1300; trig(); trig(); trig()
  assert.equal(timers.length, 1, '只排一個尾巴')
  assert.equal(timers[0][1], 700)
  t = 2000
  await timers[0][0]()
  assert.equal(runs, 2)
  t = 5000; trig()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(runs, 3)
})

const members = [{ id: 'T', agents: [{ name: 'T-ASN', status: 'idle' }, { name: '甲', status: 'busy', cwd_label: 'asn' }] }, { id: 'W', agents: [{ name: '乙', status: 'busy' }] }]
const stub = (extra = {}) => ({ list: async () => ({ members }), inbox: async () => ({ messages: [] }), ack: async () => ({}), ...extra })

test('核心：後台說忙碌、本機現讀是閒置 → 分頁不忙碌；別台的仍照後台；本機讀失敗維持名單', async () => {
  let local = [{ name: '甲', status: 'idle', detail: null }]
  const core = new AsnCore({ transport: stub({ localWindows: async () => local }), store: memStore(), selfNode: 'T', windowName: 'T-ASN', localMs: 0 })
  await core.start()
  const get = id => core.snapshot().friends.find(f => f.id === id)
  assert.equal(get('T/甲').status, 'online')
  assert.equal(isTabBusy(get('T/甲')), false)
  assert.equal(get('W/乙').status, 'busy')
  local = [{ name: '甲', status: 'busy', detail: '背景工作中' }]
  await core.refreshLocal()
  assert.equal(get('T/甲').status, 'busy')
  assert.equal(get('T/甲').psm, 'asn・背景工作中')
  local = null
  await core.refreshLocal()
  assert.equal(get('T/甲').status, 'busy', '讀不到不亂改')
  await core.stop()
})

test('核心：沒有 localWindows（手機）照舊只看名單', async () => {
  const core = new AsnCore({ transport: stub(), store: memStore(), selfNode: 'T', windowName: 'T-ASN' })
  await core.start()
  assert.equal(core.snapshot().friends.find(f => f.id === 'T/甲').status, 'busy')
  await core.stop()
})
