// 關閉視窗／接班換手之後，本機名單不留殘影：本機現讀曾經看到、這次不見的視窗，立刻轉離線（不等後台下一輪名單）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { overlayLocal } from '../ui/lib/local-status.mjs'
import { memStore } from './helpers.mjs'

const fr = (id, node, status, extra = {}) => [id, { id, node, agent: id.split('/')[1], nick: id.split('/')[1], status, psm: 'asn', contextPct: null, ...extra }]

test('overlayLocal：本機曾經讀到、這次不見的視窗（名單還說在線）→ 立刻離線；沒讀到過的、別台的、非 claude 引擎的不動', () => {
  const m = new Map([
    fr('T/甲', 'T', 'online', { engine: 'claude', contextPct: 50 }),
    fr('T/乙', 'T', 'busy', { engine: 'claude' }),
    fr('T/回信', 'T', 'online', { engine: 'claude' }),
    fr('T/丙', 'T', 'online', { engine: 'gemini' }),
    fr('W/丁', 'W', 'online', { engine: 'claude' }),
  ])
  const seen = new Set(['甲', '乙', '丙', '丁'])
  const next = overlayLocal(m, 'T', [{ name: '乙', status: 'busy' }], new Map(), seen)
  assert.equal(next.get('T/甲').status, 'offline')
  assert.equal(next.get('T/甲').contextPct, null)
  assert.equal(next.get('T/乙').status, 'busy')
  assert.equal(next.get('T/回信').status, 'online', '本機從沒讀到過的不當成已關閉（收發室自動回信不在 sessions 裡）')
  assert.equal(next.get('T/丙').status, 'online', '其他引擎的條目不在 sessions 裡')
  assert.equal(next.get('W/丁').status, 'online', '別台的不動')
  const all = overlayLocal(m, 'T', [], new Map(), seen)
  assert.equal(all.get('T/乙').status, 'offline', '最後一個視窗也關了')
  assert.equal(overlayLocal(m, 'T', [], new Map(), new Set()), null, '從沒讀到過任何視窗＝照舊')
})

test('核心：關閉視窗後，本機一讀不到它就轉離線（不等後台）；讀失敗不算關閉；同名重開又回線上', async () => {
  const mem = [{ id: 'T', agents: [{ name: 'T-ASN', status: 'idle' }, { name: '甲', status: 'idle', engine: 'claude' }, { name: '乙', status: 'idle', engine: 'claude' }] }]
  let local = [{ name: '甲', status: 'idle' }, { name: '乙', status: 'idle' }]
  const transport = {
    list: async () => ({ members: mem }), inbox: async () => ({ messages: [] }), ack: async () => ({}),
    localWindows: async () => { if (local === 'fail') throw new Error('讀不到'); return local },
  }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: 'T-ASN', localMs: 0 })
  await core.start()
  const get = id => core.snapshot().friends.find(f => f.id === id)
  assert.equal(get('T/甲').status, 'online')
  local = 'fail'
  await core.refreshLocal()
  assert.equal(get('T/甲').status, 'online', '讀失敗不算關閉')
  local = [{ name: '乙', status: 'idle' }]
  await core.refreshLocal()
  assert.equal(get('T/甲').status, 'offline')
  assert.equal(get('T/乙').status, 'online')
  local = [{ name: '甲', status: 'idle' }, { name: '乙', status: 'idle' }]
  await core.refreshRoster()
  assert.equal(get('T/甲').status, 'online')
  await core.stop()
})
