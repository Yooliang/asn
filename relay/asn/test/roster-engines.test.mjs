// 名單守門：非 Claude 引擎的夥伴（Gemini、Codex、ACP…，個人訊息可能是空的）一定要出現在名單上，
// 三種分頁依（設備／廠商／狀態）算出來的人數也要對得上；廠商標誌有對照的用官方圖，沒有的用通用圖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { pageItems, pageTabs, groupItems } from '../ui/lib/dims.mjs'
import { groupHeading, engineLabel } from '../ui/lib/tabs.mjs'
import { VENDOR_ICON_KEYS, vendorIconSvg } from '../ui/lib/vendor-icons.mjs'
import { memStore } from './helpers.mjs'
import { buildFriends, hiddenPsm, procDisplayName } from '../ui/lib/roster.mjs'

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

test('名單：後台帶的 model 會留在好友上（pi 夥伴靠它顯示背後模型的廠商）；沒帶或空白就沒有這個鍵', async () => {
  const members = [{ id: 'w02', name: '工作機', kind: 'claude', agents: [
    { name: '派', status: 'idle', cwd_label: null, engine: 'pi', detail: null, model: ' anthropic/claude-sonnet-4 ' },
    { name: '派二', status: 'idle', cwd_label: null, engine: 'pi', detail: null, model: '   ' },
    { name: '派三', status: 'idle', cwd_label: null, engine: 'pi', detail: null },
  ] }]
  const core = new AsnCore({ transport: { list: async () => ({ members }) }, store: memStore(), selfNode: 'self', windowName: '自己-ASN' })
  await core.refreshRoster()
  const by = n => [...core.friends.values()].find(f => f.agent === n)
  assert.equal(by('派').model, 'anthropic/claude-sonnet-4')
  assert.equal('model' in by('派二'), false)
  assert.equal('model' in by('派三'), false)
})

test('本機程序條目：顯示名拿掉（前景）（背景），第二行不借用它寫前景／背景；名字本身（鍵）不變', () => {
  const members = [{ id: 'w02', name: '工作機', kind: 'claude', agents: [
    { name: 'grok #65324（前景）', status: 'running', cwd_label: '', engine: 'grok', kind: 'process', receivable: false },
    { name: 'codex #14（背景）', status: 'running', cwd_label: '', engine: 'codex', kind: 'process', receivable: false },
    { name: 'pi · MiniMax #12（前景）', status: 'running', cwd_label: '', engine: 'pi', kind: 'process', receivable: false },
    { name: 'Test-Gemini', status: 'idle', cwd_label: 'Gemini（背景工作者）', engine: 'gemini' },
    { name: '小職（背景）', status: 'idle', cwd_label: '', engine: 'claude' },
  ] }]
  const by = n => buildFriends(members, { selfNode: 'self' }).find(f => f.agent === n)
  const g = by('grok #65324（前景）')
  assert.deepEqual([g.nick, g.psm, g.agent], ['grok #65324', '', 'grok #65324（前景）'], '鍵不變（接手、操作都用 agent）')
  const c = by('codex #14（背景）')
  assert.deepEqual([c.nick, c.psm], ['codex #14', ''], '（背景）是命令列猜的，不是視窗隱藏，第二行不寫')
  assert.equal(by('pi · MiniMax #12（前景）').nick, 'pi · MiniMax #12')
  const t = by('Test-Gemini')
  assert.deepEqual([t.nick, t.psm], ['Test-Gemini', 'Gemini（背景工作者）'], '背景工作者照舊用第二行的標籤')
  const k = by('小職（背景）')
  assert.deepEqual([k.nick, k.psm], ['小職（背景）', ''], '不是程序條目的名字照舊，不動括號')
  assert.equal(procDisplayName('grok #1（前景）'), 'grok #1')
  assert.equal(procDisplayName('（前景）'), '')
})

test('CLI 視窗隱藏（hidden:true）第二行寫「背景運行」接在資料夾後面；顯示中、沒帶欄位、ACP 都不多寫', () => {
  const members = [{ id: 'w02', name: '工作機', kind: 'claude', agents: [
    { name: '甲', status: 'idle', cwd_label: 'proj', engine: 'claude', hidden: true },
    { name: '乙', status: 'idle', cwd_label: '', engine: 'claude', hidden: true },
    { name: '丙', status: 'idle', cwd_label: 'proj', engine: 'claude', hidden: false },
    { name: '丁', status: 'idle', cwd_label: 'proj', engine: 'claude' },
    { name: 'Test-Gemini', status: 'idle', cwd_label: 'Gemini（背景運行、內建通道）', engine: 'gemini' },
    { name: 'codex #14（背景）', status: 'running', cwd_label: '', engine: 'codex', kind: 'process', receivable: false, hidden: true },
  ] }]
  const by = n => buildFriends(members, { selfNode: 'self' }).find(f => f.agent === n)
  assert.equal(by('甲').psm, 'proj・背景運行')
  assert.equal(by('乙').psm, '背景運行')
  assert.equal(by('丙').psm, 'proj', '顯示中不寫字')
  assert.equal(by('丁').psm, 'proj', '沒有 hidden（舊橋、Windows Terminal 分頁、非 Windows）不寫字')
  assert.equal(by('Test-Gemini').psm, 'Gemini（背景運行、內建通道）', 'ACP 只有 label 的字，不重複')
  assert.equal(by('codex #14（背景）').psm, '背景運行', '程序條目隱藏時也一樣')
  assert.equal(hiddenPsm({ hidden: 'true', cwd_label: 'x' }), 'x', '只認布林 true')
})
