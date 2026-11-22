// #374：兩條額度各自的重置時間。一天內寫「約 N 小時後重置」（不到 1 小時寫分鐘）；超過一天寫「週六 14:00 重置」；
// 已經過了的那條不列；沒有新欄位（舊版電腦）退回舊的單一 reset_at、照舊顯示。電腦設定頁、設備卡、我的帳號、手機同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planLabel, resetWhen } from '../ui/lib/account-quota.mjs'
import { rosterAccountsOn, rosterQuota, rosterView } from '../ui/lib/account-roster.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = new Date(2026, 9, 28, 10, 0, 0).getTime()   // 本地時間 2026-10-28（週三）10:00
const H = 3600_000, MIN = 60_000, D = 24 * H
const iso = ms => new Date(ms).toISOString()
const at = iso(NOW - 10 * MIN)

test('重置時間的寫法：分鐘、小時、超過一天寫星期幾與時刻；已過、沒有就空（不下結論）', () => {
  assert.equal(resetWhen(iso(NOW + 20 * MIN), NOW), '約 20 分鐘後重置')
  assert.equal(resetWhen(iso(NOW + 30 * 1000), NOW), '約 1 分鐘後重置')
  assert.equal(resetWhen(iso(NOW + 59.9 * MIN), NOW), '約 59 分鐘後重置')
  assert.equal(resetWhen(iso(NOW + 3 * H + 10 * MIN), NOW), '約 3 小時後重置')
  assert.equal(resetWhen(iso(NOW + 23 * H), NOW), '約 23 小時後重置')
  assert.equal(resetWhen(iso(new Date(2026, 9, 31, 14, 0).getTime()), NOW), '週六 14:00 重置')
  assert.equal(resetWhen(iso(new Date(2026, 10, 2, 9, 5).getTime()), NOW), '週一 09:05 重置')
  assert.equal(resetWhen(iso(NOW - MIN), NOW), '', '已過：不寫結論')
  for (const v of [undefined, null, '', '壞掉']) assert.equal(resetWhen(v, NOW), '')
  for (const s of ['約 20 分鐘後重置', '週六 14:00 重置']) assert.ok(Array.from(s).length <= 20)
})

const entry = (windows, extra = {}) => ({ vendor: 'claude', account: 'a@x.test', plan: 'claude_max', windows, seen_at: at, seen_node: 'W', nodes: [{ node: 'W', current: true }], ...extra })
const w = (name, left_pct, resets_at, read_at = at) => ({ name, left_pct, resets_at, read_at, read_node: 'W' })

test('帳號列表：每條自己寫重置時間；已過的那條不列；舊資料標 stale（畫面改淡色，#2111）', () => {
  const q = rosterQuota(entry([w('five_hour', 40, iso(NOW + 20 * MIN)), w('weekly', 72, iso(new Date(2026, 9, 31, 14, 0).getTime()))]), { now: NOW })
  assert.deepEqual(q.bars.map(b => [b.label, b.pct, b.reset, b.expired]), [['5 小時', 40, '約 20 分鐘後重置', false], ['每週', 72, '週六 14:00 重置', false]])
  const old = rosterQuota(entry([w('five_hour', 3, iso(NOW - H), iso(NOW - 9 * H)), w('weekly', 72, iso(NOW + 2 * D), iso(NOW - 9 * H))]), { now: NOW })
  assert.deepEqual(old.bars.map(b => [b.label, b.reset, b.expired]), [['每週', '週五 10:00 重置', false]])
  assert.equal(old.stale, true)
  assert.deepEqual(rosterQuota(entry([]), { now: NOW }).bars, [])
})

test('方案標籤：claude_max 這類改成 Max、Pro；本來就好讀的照舊', () => {
  assert.equal(planLabel('claude_max'), 'Max')
  assert.equal(planLabel('max'), 'Max')
  assert.equal(planLabel('claude_pro'), 'Pro')
  assert.equal(planLabel('pro'), 'Pro')
  assert.equal(planLabel('claude_max_20x'), 'Max 20x')
  assert.equal(planLabel('plus'), 'Plus')
  assert.equal(planLabel('Google AI Pro'), 'Google AI Pro')
  assert.equal(planLabel(''), '')
  assert.equal(planLabel(undefined), '')
  assert.equal(rosterView({ accounts: [entry([])] }, { now: NOW }).vendors[0].accounts[0].plan, 'Max')
})

const gem = (account, nodes, extra = {}) => ({ vendor: 'gemini', account, plan: 'Google AI Pro', windows: [w('five_hour', 50, null)], seen_at: at, seen_node: 'W', nodes, ...extra })

test('Gemini：後台有 nodes 時只列在使用中那台、標使用中；沒有 nodes（舊後台）照舊認讀過的那台', () => {
  const roster = { accounts: [gem('g1@x.test', [{ node: 'W', current: true }, { node: 'Q', current: false }]), gem('g2@x.test', [{ node: 'Q', current: true }, { node: 'W', current: false }])] }
  assert.deepEqual(rosterAccountsOn(roster, 'gemini', 'W', { now: NOW }).map(a => [a.email, a.current]), [['g1@x.test', true]])
  assert.deepEqual(rosterAccountsOn(roster, 'gemini', 'Q', { now: NOW }).map(a => [a.email, a.current]), [['g2@x.test', true]])
  assert.deepEqual(rosterView(roster, { now: NOW }).vendors[0].accounts.map(a => a.current), [true, true])
  const old = { accounts: [gem('g1@x.test', []), gem('g2@x.test', [], { seen_node: 'Q', windows: [{ ...w('five_hour', 50, null), read_node: 'Q' }] })] }
  assert.deepEqual(rosterAccountsOn(old, 'gemini', 'W', { now: NOW }).map(a => [a.email, a.current]), [['g1@x.test', false]])
  // 時間後面不加「讀的」（#558）
  assert.doesNotMatch(rosterQuota(gem('g1@x.test', []), { now: NOW }).meta, /讀的/)
})

test('接線：電腦設定頁與手機的帳號卡都畫兩條額度、各自的重置時間；不再整段斜體', () => {
  const panel = read('ui/lib/settings-panel.mjs'), m = read('ui/m.html')
  for (const src of [panel, m]) {
    assert.match(src, /b\.reset/)
    assert.doesNotMatch(src, /oldText/)
    assert.match(src, /role="progressbar"/)
  }
  const css = read('ui/style.css') + read('ui/mobile.css')
  assert.doesNotMatch(css, /quota\.stale\{[^}]*italic/)
})
