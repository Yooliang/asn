// 名單守門：非 Claude 引擎的夥伴（Gemini、Codex、ACP…，個人訊息可能是空的）一定要出現在名單上，
// 三種分頁依（設備／廠商／狀態）算出來的人數也要對得上；廠商標誌有對照的用官方圖，沒有的用通用圖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { pageItems, pageTabs, groupItems } from '../ui/lib/dims.mjs'
import { groupHeading, engineLabel } from '../ui/lib/tabs.mjs'
import { VENDOR_ICON_KEYS, vendorIconSvg } from '../ui/lib/vendor-icons.mjs'
import { memStore } from './helpers.mjs'

const claude = n => ({ name: n, status: 'idle', cwd_label: 'proj', engine: 'claude', detail: null })
const MEMBERS = [
  { id: 'self', name: '本機', kind: 'claude', agents: [] },
  {
    id: 'w02', name: '假工作機', kind: 'claude',
    agents: [
      ...['小職', '財務', '模型', 'claude-07', 'claude-14', 'claude-65', 'claude-8b', 'claude-a0', 'PCS'].map(claude),
      { name: 'Gemini', status: 'idle', cwd_label: null, engine: 'gemini', detail: null },
      { name: 'Codex-1', status: 'busy', cwd_label: '', engine: 'codex', detail: null },
      { name: '代理甲', status: 'idle', cwd_label: null, engine: 'acp', detail: null },
      { name: '舊橋', status: 'idle', cwd_label: null, engine: null, detail: null },
    ],
  },
]

async function makeCore() {
  const transport = { list: async () => ({ members: MEMBERS }) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'self', windowName: '自己-ASN' })
  await core.refreshRoster()
  return [...core.friends.values()]
}

test('名單：非 Claude 引擎、個人訊息為空的夥伴都在好友裡（共 13 位）', async () => {
  const fr = await makeCore()
  const names = fr.filter(f => f.node === 'w02').map(f => f.nick)
  for (const n of ['Gemini', 'Codex-1', '代理甲', '舊橋']) assert.ok(names.includes(n), `${n} 不見了`)
  assert.equal(names.length, 13)
  assert.equal(fr.find(f => f.nick === 'Gemini').engine, 'gemini')
  assert.equal(fr.find(f => f.nick === 'Gemini').status, 'online')
})

test('設備頁：該設備的組標題人數含所有引擎（x/y 對得上）', async () => {
  const fr = await makeCore()
  const tabs = pageTabs(fr, 'device', { selfNode: 'self', selfName: '自己-ASN', nodeOrder: ['self', 'w02'] })
  const t = tabs.all.find(x => x.key === 'w02')
  assert.equal(t.total, 13)
  assert.equal(t.online, 13)
  const g = groupItems(pageItems(fr, 'device', 'w02'), 'device', { selfNode: 'self' })
  assert.equal(groupHeading(g[0]), '假工作機 (13/13)')
  assert.ok(g[0].items.some(f => f.nick === 'Gemini'))
})

test('廠商頁：每個引擎各有一頁、加總等於全部；Gemini 頁有 Gemini', async () => {
  const fr = await makeCore()
  const tabs = pageTabs(fr, 'engine', { selfNode: 'self', max: 20 })
  assert.equal(tabs.all.reduce((n, t) => n + t.total, 0), fr.length)
  const gem = tabs.all.find(t => t.key === 'gemini')
  assert.equal(gem.label, 'Gemini')
  assert.deepEqual(pageItems(fr, 'engine', 'gemini').map(f => f.nick), ['Gemini'])
  assert.equal(pageItems(fr, 'engine', 'claude').length, 10)   // 9 位 claude ＋ 沒回報引擎的舊橋（用節點類型 claude）
  assert.ok(tabs.all.find(t => t.key === 'acp'))
})

test('狀態頁：加總等於全部好友', async () => {
  const fr = await makeCore()
  const tabs = pageTabs(fr, 'status', { selfNode: 'self' })
  assert.equal(tabs.all.reduce((n, t) => n + t.total, 0), fr.length)
})

test('廠商標誌：gemini／codex／acp 有各自的圖，不認得的用通用圖；引擎頁籤名稱可讀', () => {
  for (const k of ['claude', 'gemini', 'codex', 'grok', 'deepseek', 'acp']) assert.ok(VENDOR_ICON_KEYS.includes(k), k)
  assert.notEqual(vendorIconSvg('gemini'), vendorIconSvg('other'))
  assert.notEqual(vendorIconSvg('acp'), vendorIconSvg('other'))
  assert.equal(vendorIconSvg('沒聽過'), vendorIconSvg('other'))
  assert.equal(engineLabel('acp'), 'ACP')
  assert.equal(engineLabel('asn'), 'ASN')
})
