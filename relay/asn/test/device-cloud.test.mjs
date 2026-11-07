// 雲端夥伴的判斷（#930，0.2.15 PR①）：規則集中在 device-state.mjs 的 isCloudNode，電腦版與手機版的設備樹都用它。
// 規則：沒有電腦版 ASN、只有橋或雲端代理的節點才算雲端夥伴；資料不夠就回 null，不猜。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCloudNode } from '../ui/lib/device-state.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'

const REPORTED = { error: '', reportedAt: '2026-11-07T10:00:00Z', asnOnline: false, accounts: [] }
const NEVER = { error: '', reportedAt: '', asnOnline: false, accounts: [] }

test('Grok 雲端：名單只有雲端代理、沒有電腦版 ASN → 雲端（不必等帳號回報）', () => {
  assert.equal(isCloudNode({ engines: ['cloud'] }), true)
  assert.equal(isCloudNode({ engines: ['cloud', 'cloud'], rep: NEVER }), true)
})

test('牧陽 Aegis 轉接橋：只有橋的視窗、從沒有電腦版 ASN 的帳號回報 → 雲端', () => {
  assert.equal(isCloudNode({ engines: ['aegis'], rep: NEVER }), true)
})

test('日本VM：橋＋代理（Linux 平台）、沒有電腦版 ASN 回報 → 雲端；平台是 linux 不影響', () => {
  assert.equal(isCloudNode({ engines: ['claude', 'pi'], rep: NEVER }), true)
})

test('實體電腦：有電腦版 ASN 的帳號回報（即使現在離線）或現在有 ASN 在線 → 不是雲端', () => {
  assert.equal(isCloudNode({ engines: ['claude'], rep: REPORTED }), false, '曾經回報過')
  assert.equal(isCloudNode({ engines: ['claude'], asnOnline: true }), false, '現在在線，還沒讀帳號回報')
  assert.equal(isCloudNode({ engines: ['cloud'], asnOnline: true }), false, '電腦版 ASN 上掛了雲端代理的視窗，仍是電腦')
  assert.equal(isCloudNode({ engines: [], rep: REPORTED }), false, '沒有夥伴也一樣')
})

test('手機與本機 → 不是雲端', () => {
  assert.equal(isCloudNode({ phone: true, engines: ['cloud'], rep: NEVER }), false)
  assert.equal(isCloudNode({ self: true, rep: NEVER }), false)
})

test('資料不夠就回 null（不猜）：還沒讀帳號回報、讀取失敗、只有名單沒有回報', () => {
  assert.equal(isCloudNode({ engines: ['claude'] }), null, '手機還沒讀這台的帳號回報、ASN 也不在線')
  assert.equal(isCloudNode({ engines: ['claude'], rep: { error: '讀不到', reportedAt: '' } }), null, '讀取失敗')
  assert.equal(isCloudNode({ engines: [] }), null, '只有名單節點、什麼都沒有')
  assert.equal(isCloudNode({ engines: ['cloud', 'claude'] }), null, '混了別的引擎，不能只靠引擎判斷')
})

test('舊版沒帶平台：平台空也照規則判斷（平台本來就不參與）', () => {
  assert.equal(isCloudNode({ engines: ['claude'], rep: NEVER }), true)
  assert.equal(isCloudNode({ engines: ['claude'], rep: REPORTED }), false)
})

// 一份假資料：本機電腦、實體電腦（有回報）、Grok 雲端、Aegis 橋、日本VM、另一支手機、還沒讀到回報的電腦
const friends = [
  { id: 'a', node: 'self1', agent: '小甲', engine: 'claude', device: '工作機' },
  { id: 'b', node: 'pc2', agent: '小乙', engine: 'claude', device: '家用' },
  { id: 'c', node: 'grok1', agent: 'Grok', engine: 'cloud', device: 'Grok 雲端' },
  { id: 'd', node: 'aeg1', agent: '小牧', engine: 'aegis', device: '牧陽 Aegis' },
  { id: 'e', node: 'jp1', agent: 'MiniMax1', engine: 'pi', device: '日本VM' },
  { id: 'f', node: 'ph1', agent: '手機', kind: 'phone', device: '手機' },
  { id: 'g', node: 'pc3', agent: '小丙', engine: 'codex', device: '筆電' },
]
const machines = { pc2: { platform: 'windows' }, jp1: { platform: 'linux' }, ph1: { platform: 'android' } }
const expected = { self1: false, pc2: false, grok1: true, aeg1: true, jp1: true, ph1: false, pc3: null }

test('電腦版設備樹每台多帶 cloud，分組照規則', () => {
  const tree = buildDeviceTree({ friends, selfNode: 'self1', machines, reports: { pc2: REPORTED, aeg1: NEVER, jp1: NEVER } })
  assert.deepEqual(Object.fromEntries(tree.map(d => [d.key, d.cloud])), expected)
})

test('電腦版與手機版拿同一份資料，雲端分組一樣（手機用自己的帳號回報形狀）', () => {
  const desk = buildDeviceTree({ friends, selfNode: 'self1', machines, reports: { pc2: REPORTED, aeg1: NEVER, jp1: NEVER } })
  const mobileRep = r => ({ loading: false, asnOnline: false, reportedAt: r.reportedAt, msg: r.error, list: [] })
  const phone = acctDeviceTree({ friends, selfNode: 'self1', machines, reports: { pc2: mobileRep(REPORTED), aeg1: mobileRep(NEVER), jp1: mobileRep(NEVER), pc3: { loading: true } } })
  const pick = t => Object.fromEntries(t.map(d => [d.key, d.cloud]))
  assert.deepEqual(pick(phone), pick(desk))
})

test('只加 cloud 欄位，不改既有的種類（手機／電腦）與其他欄位', () => {
  const tree = buildDeviceTree({ friends, selfNode: 'self1', machines, reports: { pc2: REPORTED, aeg1: NEVER, jp1: NEVER } })
  const by = Object.fromEntries(tree.map(d => [d.key, d]))
  assert.equal(by.grok1.kind, '電腦', '分組與顯示在之後的 PR 才改')
  assert.equal(by.ph1.kind, '手機')
})
