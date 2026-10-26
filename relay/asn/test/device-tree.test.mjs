// 設定「設備」分類的純邏輯：設備 → 廠商 → 帳號。不顯示節點代號與夥伴 ID，沒回報的寫「未回報」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildDeviceTree, deviceSummary, NOT_REPORTED } from '../ui/lib/device-tree.mjs'

const SELF = 'aaaaaaaa-0000-4000-8000-000000000001'
const W = 'bbbbbbbb-0000-4000-8000-000000000002'
const P = 'cccccccc-0000-4000-8000-000000000003'
const fr = (node, device, agent, engine, status = 'online', kind = null) => ({ node, device, agent, engine, status, kind, partnerId: 'dddddddd-0000-4000-8000-0000000000aa' })
const NOW = Date.parse('2026-10-23T12:00:00Z')

const friends = [fr(SELF, '家用機', 'a1', 'claude'), fr(W, '工作機', 'w1', 'claude'), fr(W, '工作機', 'w2', 'gemini', 'offline'), fr(P, '小良的手機', 'p1', 'asn', 'offline', 'phone')]
const base = () => ({
  friends, nodeOrder: [SELF, W, P], selfNode: SELF, now: NOW,
  asn: { [W]: [{ status: 'online', version: '1.0.0' }] },
  launchers: { [W]: { profiles: [{ id: 'claude' }, { id: 'codex' }] } },
  reports: { [W]: { error: '', asnOnline: true, reportedAt: '2026-10-23T11:57:00Z', accounts: [{ vendor: 'claude', email: 'w@x.test', plan: 'pro', current: true }, { vendor: 'claude', email: 'z@x.test', plan: '', current: false }] } },
  self: { claude: [{ email: 'me@x.test', plan: 'max', current: true }], codex: { loggedIn: true, text: 'me@openai.test · plus' } },
})
const byLabel = (t, l) => t.find(d => d.label === l)

test('三層：設備用名稱，底下是廠商，每個廠商一個帳號', () => {
  const t = buildDeviceTree(base())
  assert.deepEqual(t.map(d => d.label), ['家用機', '工作機', '小良的手機'])
  const self = byLabel(t, '家用機')
  assert.equal(self.self, true)
  assert.deepEqual(self.vendors.map(v => [v.label, v.account]), [['Claude', 'me@x.test · max'], ['OpenAI（Codex）', 'me@openai.test · plus']])
  const w = byLabel(t, '工作機')
  assert.deepEqual(w.vendors.map(v => v.label), ['Claude', 'Gemini', 'OpenAI（Codex）'])
  assert.equal(w.vendors[0].account, 'w@x.test · pro')
  assert.match(w.vendors[0].extra, /另有 1 個帳號：z@x\.test/)
  assert.equal(w.reportedText, '帳號最後回報：3 分鐘前')
})

test('沒回報的顯示「未回報」；手機沒有廠商就寫沒有回報', () => {
  const w = byLabel(buildDeviceTree(base()), '工作機')
  assert.equal(w.vendors.find(v => v.key === 'gemini').account, NOT_REPORTED)
  assert.equal(w.vendors.find(v => v.key === 'codex').account, NOT_REPORTED)
  const ph = byLabel(buildDeviceTree(base()), '小良的手機')
  assert.equal(ph.kind, '手機')
  assert.deepEqual(ph.vendors, [])
  assert.equal(ph.empty, '這台設備還沒有回報任何廠商')
})

test('在線狀態：本機與有 ASN 或有在線視窗的算在線', () => {
  const t = buildDeviceTree(base())
  assert.deepEqual(t.map(d => d.onlineText), ['在線', '在線', '離線'])
  assert.equal(deviceSummary(t), '3 台設備，2 台在線')
  assert.equal(deviceSummary([]), '還沒有設備')
})

test('只有 Claude 能切換：對方 ASN 在線且至少兩個帳號；本機與其他廠商不能', () => {
  const t = buildDeviceTree(base())
  const w = byLabel(t, '工作機')
  assert.equal(w.vendors.find(v => v.key === 'claude').switchable, true)
  assert.ok(byLabel(t, '家用機').vendors.every(v => !v.switchable))
  assert.ok(w.vendors.filter(v => v.key !== 'claude').every(v => !v.switchable))
  const off = base(); off.reports[W].asnOnline = false
  const v = byLabel(buildDeviceTree(off), '工作機').vendors[0]
  assert.equal(v.switchable, false)
  assert.match(v.switchHint, /沒有在線/)
})

test('帳號回報讀取失敗：不丟錯，顯示未回報', () => {
  const b = base(); b.reports[W] = { error: '連不上', asnOnline: false, reportedAt: '', accounts: [] }
  const w = byLabel(buildDeviceTree(b), '工作機')
  assert.equal(w.vendors.find(v => v.key === 'claude').account, NOT_REPORTED)
  assert.equal(w.reportedText, '帳號回報讀取失敗')
  assert.doesNotThrow(() => buildDeviceTree({}))
})

test('回報裡有別的廠商帳號就直接長出來（後台日後補 Codex／Gemini 回報不必改畫面）', () => {
  const b = base(); b.reports[W].accounts.push({ vendor: 'codex', email: 'c@openai.test', plan: 'plus', current: true })
  const w = byLabel(buildDeviceTree(b), '工作機')
  assert.equal(w.vendors.find(v => v.key === 'codex').account, 'c@openai.test · plus')
})

test('本機沒登入：寫「目前沒有登入」；畫面資料不含節點代號與夥伴 ID', () => {
  const b = base(); b.self = { claude: [], codex: { loggedIn: false, text: '' } }
  b.friends = [...friends]
  const t = buildDeviceTree(b)
  assert.equal(byLabel(t, '家用機').vendors.find(v => v.key === 'claude').account, '目前沒有登入')
  const shown = JSON.stringify(t.map(d => ({ ...d, key: undefined })))
  for (const id of [SELF, W, P, 'dddddddd-0000-4000-8000-0000000000aa']) assert.ok(!shown.includes(id))
})

test('沒有名稱的設備寫「未命名設備」，不退回節點代號', () => {
  const t = buildDeviceTree({ ...base(), friends: [fr(W, '', 'w1', 'claude')], nodeOrder: [W] })
  assert.equal(byLabel(t, '未命名設備')?.self, false)
  assert.ok(!JSON.stringify(t.map(d => d.label)).includes(W))
})

test('守門：設備分頁的畫面接線——設定表單用 st.devices，樞紐接得住兩個新指令，並沿用專屬對話框', () => {
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  const hub = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.ok(panel.includes("cat === 'devices'") && panel.includes("act('device-switch', { node: curDev.key, email: a.email, vendor: v.key })"))
  assert.ok(hub.includes("case 'device-switch'") && hub.includes('openDeviceAcct('))
  assert.ok(hub.includes('deviceAcct.node = node'), '沿用右鍵切換的專屬對話框')
  const block = panel.slice(panel.indexOf("cat === 'devices'"), panel.indexOf("catKey === 'look'"))
  assert.ok(!/\.key\s*}}|d\.node|partnerId/.test(block), '畫面不顯示節點代號與夥伴 ID')
})
