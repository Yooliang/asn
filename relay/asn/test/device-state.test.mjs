// 「設備」頁每一台、每一家 AI 的狀態（device-state.mjs；todo-next-174 的 B，#650）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CORE_VENDORS, REPORT_FRESH_MS, STATE, STATE_TEXT, installAction, isPhoneDevice, reportFreshness, vendorState } from '../ui/lib/device-state.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const acc = (email, over = {}) => ({ email, plan: 'pro', current: true, ...over })

test('回報新鮮度：沒收過、讀取失敗、超過 15 分鐘、新鮮——分得開', () => {
  assert.equal(reportFreshness(null, NOW), 'never')
  assert.equal(reportFreshness(undefined, NOW), 'never')
  assert.equal(reportFreshness({ error: '', reportedAt: '' }, NOW), 'never')
  assert.equal(reportFreshness({ error: '連不上', reportedAt: ago(1000) }, NOW), 'error')
  assert.equal(reportFreshness({ error: '', reportedAt: ago(REPORT_FRESH_MS + 1000) }, NOW), 'stale')
  assert.equal(reportFreshness({ error: '', reportedAt: ago(REPORT_FRESH_MS - 1000) }, NOW), 'fresh')
  assert.equal(reportFreshness({ error: '', reportedAt: ago(5 * 60 * 1000) }, NOW), 'fresh', '每 5 分鐘回報一次，5 分鐘前的當然新鮮')
  assert.equal(reportFreshness({ error: '', reportedAt: 'not a date' }, NOW), 'never')
})

test('別台：沒收到回報（從沒、失敗、過期）一律是「還沒收到這台的回報」，不能說成沒登入', () => {
  for (const [rep, reason] of [[null, 'never'], [{ error: 'x', reportedAt: ago(1000) }, 'error'], [{ error: '', reportedAt: ago(REPORT_FRESH_MS * 2), accounts: [] }, 'stale']]) {
    const s = vendorState({ rep, accounts: [], installed: true, now: NOW })
    assert.equal(s.state, STATE.NO_REPORT)
    assert.equal(s.text, '還沒收到這台的回報')
    assert.equal(s.reason, reason)
    assert.doesNotMatch(s.text, /沒有登入|未安裝/)
  }
  // 過期的回報就算帶著帳號也不當成「已登入」
  const stale = vendorState({ rep: { error: '', reportedAt: ago(REPORT_FRESH_MS * 2) }, accounts: [acc('a@x.test')], now: NOW })
  assert.equal(stale.state, STATE.NO_REPORT)
})

test('別台，回報是新的：已登入／登入失效／已安裝還沒登入／沒有登入', () => {
  const rep = { error: '', reportedAt: ago(60 * 1000) }
  assert.deepEqual(vendorState({ rep, accounts: [acc('a@x.test')], installed: true, now: NOW }), { state: STATE.LOGGED_IN, text: '已登入 a@x.test' })
  assert.equal(vendorState({ rep, accounts: [acc('a@x.test', { loginFailed: true })], now: NOW }).state, STATE.LOGIN_FAILED)
  assert.equal(vendorState({ rep, accounts: [acc('a@x.test', { loginFailed: true })], now: NOW }).text, '登入失效，要重新登入')
  assert.equal(vendorState({ rep, accounts: [], installed: true, now: NOW }).state, STATE.INSTALLED_LOGGED_OUT)
  assert.equal(vendorState({ rep, accounts: [], installed: false, now: NOW }).state, STATE.NOT_INSTALLED)
  // 不知道有沒有裝（那台沒開放啟動器）：只說沒有登入，不亂說未安裝
  const unknown = vendorState({ rep, accounts: [], installed: null, now: NOW })
  assert.equal(unknown.state, STATE.LOGGED_OUT)
  assert.notEqual(unknown.text, STATE_TEXT[STATE.NOT_INSTALLED])
  // 目前使用中的帳號登入失效才算失效（別的帳號失效不影響）
  const mixed = vendorState({ rep, accounts: [acc('ok@x.test'), acc('bad@x.test', { current: false, loginFailed: true })], now: NOW })
  assert.equal(mixed.state, STATE.LOGGED_IN)
})

test('本機：不看回報；有帳號就是已登入；沒帳號看偵測', () => {
  assert.equal(vendorState({ isSelf: true, rep: null, accounts: [acc('me@x.test')], now: NOW }).state, STATE.LOGGED_IN)
  assert.equal(vendorState({ isSelf: true, rep: null, accounts: [], installed: true, now: NOW }).state, STATE.INSTALLED_LOGGED_OUT)
  assert.equal(vendorState({ isSelf: true, rep: null, accounts: [], installed: false, now: NOW }).state, STATE.NOT_INSTALLED)
})

test('手機：後台回報的平台優先；舊版手機（平台空）退回名單的種類', () => {
  assert.equal(isPhoneDevice({ platform: 'android' }), true)
  assert.equal(isPhoneDevice({ platform: 'ios' }), true)
  assert.equal(isPhoneDevice({ platform: 'windows', kinds: ['phone'] }), false, '平台說是電腦就是電腦')
  assert.equal(isPhoneDevice({ platform: '', kinds: ['claude', 'phone'] }), true)
  assert.equal(isPhoneDevice({ platform: '', kinds: ['claude'] }), false)
  assert.equal(isPhoneDevice({}), false)
})

test('安裝並登入的按鈕：只有 Claude、手機不給、已登入不給、別台要在線且回報是新的', () => {
  const ok = { vendor: 'claude', online: true, asnOnline: true }
  for (const state of [STATE.NOT_INSTALLED, STATE.INSTALLED_LOGGED_OUT, STATE.LOGGED_OUT, STATE.UNKNOWN_INSTALL]) {
    assert.deepEqual(installAction({ ...ok, isSelf: true, state }), { kind: 'local' }, state)
    assert.deepEqual(installAction({ ...ok, state }), { kind: 'remote' }, state)
  }
  assert.equal(installAction({ ...ok, state: STATE.LOGGED_IN }), null, '已登入的不給（換帳號走切換帳號）')
  assert.equal(installAction({ ...ok, state: STATE.LOGIN_FAILED }), null)
  assert.equal(installAction({ ...ok, state: STATE.NO_REPORT }), null, '沒收到回報就不知道它現在是什麼狀態')
  assert.equal(installAction({ ...ok, vendor: 'codex', state: STATE.NOT_INSTALLED }), null, '0.2.2 只有 Claude')
  assert.equal(installAction({ ...ok, phone: true, state: STATE.NOT_INSTALLED }), null, '手機不能被安裝')
  assert.equal(installAction({ ...ok, online: false, state: STATE.NOT_INSTALLED }), null, '離線的給不了')
  assert.equal(installAction({ ...ok, asnOnline: false, state: STATE.NOT_INSTALLED }), null, '對方 ASN 沒在線給不了')
  assert.deepEqual(installAction({ vendor: 'claude', isSelf: true, online: false, state: STATE.NOT_INSTALLED }), { kind: 'local' }, '本機不看在線')
})

// ---- 接進設備樹 ----
const SELF = 'aaaaaaaa-0000-4000-8000-000000000001'
const W = 'bbbbbbbb-0000-4000-8000-000000000002'
const P = 'cccccccc-0000-4000-8000-000000000003'
const N = 'dddddddd-0000-4000-8000-000000000004'
const fr = (node, device, agent, engine, status = 'online', kind = null) => ({ node, device, agent, engine, status, kind, partnerId: 'eeeeeeee-0000-4000-8000-0000000000aa' })
const friends = [fr(SELF, '家用機', 'a1', 'claude'), fr(W, '工作機', 'w1', 'claude'), fr(P, '小良的手機', 'p1', 'asn', 'offline', 'phone'), fr(N, '新電腦', 'n1', 'asn')]
const tree = (over = {}) => buildDeviceTree({
  friends, nodeOrder: [SELF, W, P, N], selfNode: SELF, now: NOW,
  asn: { [W]: [{ status: 'online' }], [N]: [{ status: 'online' }] },
  launchers: { [SELF]: { profiles: [{ id: 'claude' }] }, [W]: { profiles: [{ id: 'claude' }, { id: 'codex' }] }, [P]: { platform: 'android' } },
  reports: {
    [W]: { error: '', asnOnline: true, reportedAt: ago(60 * 1000), accounts: [{ vendor: 'claude', email: 'w@x.test', plan: 'pro', current: true }] },
    [N]: { error: '', asnOnline: true, reportedAt: ago(60 * 1000), accounts: [] },
  },
  self: { claude: [], codex: { loggedIn: false, text: '' } }, ...over,
})
const dev = (t, label) => t.find(d => d.label === label)
const vend = (d, k) => d.vendors.find(v => v.key === k) ?? d.missing.find(v => v.key === k)

test('設備樹：本機沒登入的 Claude 有「安裝並登入」；Codex 偵測沒有就是未安裝', () => {
  const self = dev(tree(), '家用機')
  const c = vend(self, 'claude')
  assert.equal(c.state, STATE.INSTALLED_LOGGED_OUT)
  assert.equal(c.stateText, '已安裝，還沒登入')
  assert.deepEqual(c.action, { kind: 'local' })
  const codex = vend(self, 'codex')
  assert.equal(codex.state, STATE.NOT_INSTALLED)
  assert.equal(codex.action, undefined, '0.2.2 只有 Claude 有按鈕')
})

test('設備樹：別台已登入；啟動器有回報的 Codex 是已安裝還沒登入；沒用到的 Grok 是未安裝', () => {
  const w = dev(tree(), '工作機')
  assert.deepEqual([vend(w, 'claude').state, vend(w, 'claude').stateText, vend(w, 'claude').action], [STATE.LOGGED_IN, '已登入 w@x.test', undefined])
  assert.equal(vend(w, 'codex').state, STATE.INSTALLED_LOGGED_OUT)
  assert.equal(vend(w, 'grok').state, STATE.NOT_INSTALLED)
})

test('設備樹：全新的電腦（回報是新的、沒有任何 AI）——Claude 可以從這裡裝；沒開放啟動器就不知道有沒有裝', () => {
  const n = dev(tree(), '新電腦')
  const c = vend(n, 'claude')
  assert.equal(c.state, STATE.UNKNOWN_INSTALL)
  assert.equal(c.stateText, '不確定是否安裝')
  assert.deepEqual(c.action, { kind: 'remote' })
  // 同一台改成「啟動器有回報但沒有 Claude」→ 確定未安裝
  const known = dev(tree({ launchers: { [N]: { profiles: [{ id: 'codex' }] } } }), '新電腦')
  assert.equal(vend(known, 'claude').state, STATE.NOT_INSTALLED)
})

test('設備樹：別台回報過期——所有 AI 都是「還沒收到這台的回報」，沒有安裝按鈕', () => {
  const t = tree({ reports: { [W]: { error: '', asnOnline: true, reportedAt: ago(REPORT_FRESH_MS * 3), accounts: [{ vendor: 'claude', email: 'w@x.test', plan: 'pro', current: true }] } } })
  const w = dev(t, '工作機')
  for (const v of [...w.vendors, ...w.missing]) {
    assert.equal(v.state, STATE.NO_REPORT, v.key)
    assert.equal(v.action, undefined, v.key)
  }
  assert.equal(vend(w, 'claude').stateReason, 'stale')
})

test('設備樹：手機用平台判斷，不列主要 AI、沒有安裝按鈕', () => {
  const p = dev(tree(), '小良的手機')
  assert.equal(p.phone, true)
  assert.equal(p.platform, 'android')
  assert.equal(p.kind, '手機')
  assert.deepEqual(p.missing, [])
  assert.ok(p.vendors.every(v => !v.action))
  // 舊版手機：平台是空的，靠名單的種類
  const old = dev(tree({ launchers: { [SELF]: { profiles: [] } } }), '小良的手機')
  assert.equal(old.phone, true)
  // 平台說是電腦：就算名單種類寫 phone 也當電腦
  const pc = dev(tree({ launchers: { [P]: { platform: 'windows' } } }), '小良的手機')
  assert.equal(pc.phone, false)
  assert.equal(pc.kind, '電腦')
})

test('設備樹：原有欄位（帳號、額度、切換）不變——狀態只是多加的欄位', () => {
  const w = dev(tree(), '工作機')
  const v = w.vendors.find(x => x.key === 'claude')
  assert.equal(v.account, 'w@x.test · pro')
  assert.equal(v.reported, true)
  assert.ok(Array.isArray(v.accounts) && 'switchable' in v)
  assert.deepEqual(CORE_VENDORS, ['claude', 'codex', 'grok'])
})

test('守門：device-state 是純邏輯，不碰 DOM、不呼叫後端', () => {
  const src = fs.readFileSync(new URL('../ui/lib/device-state.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /document\.|window\.|invoke\(|fetch\(|localStorage/)
})
