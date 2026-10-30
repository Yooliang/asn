// #374：兩條額度各自的重置時間。一天內寫「約 N 小時後重置」（不到 1 小時寫分鐘）；超過一天寫「週六 14:00 重置」；
// 已經過了寫「可能已恢復」；沒有新欄位（舊版電腦）退回舊的單一 reset_at、照舊顯示。電腦設定頁、設備卡、我的帳號、手機同一套。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { RESET_PASSED, planLabel, quotaBars, quotaOf, quotaView, resetWhen } from '../ui/lib/account-quota.mjs'
import { rosterAccountsOn, rosterQuota, rosterView } from '../ui/lib/account-roster.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = new Date(2026, 9, 28, 10, 0, 0).getTime()   // 本地時間 2026-10-28（週三）10:00
const H = 3600_000, MIN = 60_000, D = 24 * H
const iso = ms => new Date(ms).toISOString()
const at = iso(NOW - 10 * MIN)

test('重置時間的寫法：分鐘、小時、超過一天寫星期幾與時刻、已過寫可能已恢復、沒有就空', () => {
  assert.equal(resetWhen(iso(NOW + 20 * MIN), NOW), '約 20 分鐘後重置')
  assert.equal(resetWhen(iso(NOW + 30 * 1000), NOW), '約 1 分鐘後重置')
  assert.equal(resetWhen(iso(NOW + 59.9 * MIN), NOW), '約 59 分鐘後重置')
  assert.equal(resetWhen(iso(NOW + 3 * H + 10 * MIN), NOW), '約 3 小時後重置')
  assert.equal(resetWhen(iso(NOW + 23 * H), NOW), '約 23 小時後重置')
  assert.equal(resetWhen(iso(new Date(2026, 9, 31, 14, 0).getTime()), NOW), '週六 14:00 重置')
  assert.equal(resetWhen(iso(new Date(2026, 10, 2, 9, 5).getTime()), NOW), '週一 09:05 重置')
  assert.equal(resetWhen(iso(NOW - MIN), NOW), RESET_PASSED)
  assert.equal(RESET_PASSED, '可能已恢復')
  for (const v of [undefined, null, '', '壞掉']) assert.equal(resetWhen(v, NOW), '')
  for (const s of ['約 20 分鐘後重置', '週六 14:00 重置', RESET_PASSED]) assert.ok(Array.from(s).length <= 20)
})

test('本機額度條：有兩條各自的重置時間就各寫各的，不再另寫一句；已過的那條寫可能已恢復、不寫舊百分比', () => {
  const v = quotaBars({ five_hour_pct: 64, weekly_pct: 12, reset_at: iso(NOW + 3 * H), five_reset_at: iso(NOW + 3 * H), week_reset_at: iso(new Date(2026, 9, 31, 14, 0).getTime()), at }, { hookOn: true, now: NOW })
  assert.deepEqual(v.bars.map(b => [b.key, b.pct, b.reset, b.expired]), [['five', 64, '約 3 小時後重置', false], ['week', 12, '週六 14:00 重置', false]])
  assert.equal(v.reset, '', '各條自己寫了，整段不再另寫')
  const old = quotaBars({ five_hour_pct: 0, weekly_pct: 50, five_reset_at: iso(NOW - H), week_reset_at: iso(NOW + 2 * D), at: iso(NOW - 8 * H) }, { now: NOW })
  assert.deepEqual(old.bars.map(b => [b.key, b.reset, b.expired]), [['five', RESET_PASSED, true], ['week', '週五 10:00 重置', false]])
  assert.equal(old.stale, true)
})

test('本機額度條：舊版紀錄沒有新欄位，退回舊的單一重置時間（照舊寫是哪一條的）', () => {
  const v = quotaBars({ five_hour_pct: 64, weekly_pct: 12, reset_at: iso(NOW + 3 * H + 10 * MIN), at }, { hookOn: true, now: NOW })
  assert.deepEqual(v.bars.map(b => b.reset), ['', ''])
  assert.equal(v.reset, '5 小時額度約 3 小時後重置')
})

test('quotaOf 多帶兩條各自的重置時間與讀取時間，其他欄位照樣丟掉', () => {
  const q = quotaOf({ email: 'a@x.test', five_hour_pct: 1, weekly_pct: 2, reset_at: 'R', at: 'T', five_reset_at: 'R5', week_reset_at: 'RW', token: 'SECRET' })
  assert.deepEqual(Object.keys(q).sort(), ['at', 'five_hour_pct', 'five_reset_at', 'reset_at', 'week_reset_at', 'weekly_pct'])
})

test('別台設備卡（那台自己回報的）：有新欄位就帶兩條；沒有就照舊', () => {
  const v = quotaView({ five_hour_pct: 0, weekly_pct: 70, reset_at: iso(NOW + 90 * MIN), five_reset_at: iso(NOW + 90 * MIN), week_reset_at: iso(NOW + 5 * H), at }, NOW)
  assert.deepEqual(v.bars.map(b => [b.label, b.pct, b.reset]), [['5 小時', 0, '約 2 小時後重置'], ['每週', 70, '約 5 小時後重置']])
  assert.equal(v.resetLine, '')
  assert.equal(v.exhausted, true)
  const legacy = quotaView({ five_hour_pct: 0, weekly_pct: 70, reset_at: iso(NOW + 90 * MIN), at }, NOW)
  assert.deepEqual(legacy.bars.map(b => b.reset), ['', ''])
  assert.equal(legacy.resetLine, legacy.resetText, '舊版照舊寫一句')
  assert.match(legacy.resetLine, /重置$/)
  assert.deepEqual(quotaView({}, NOW).bars, [])
})

const entry = (windows, extra = {}) => ({ vendor: 'claude', account: 'a@x.test', plan: 'claude_max', windows, seen_at: at, seen_node: 'W', nodes: [{ node: 'W', current: true }], ...extra })
const w = (name, left_pct, resets_at, read_at = at) => ({ name, left_pct, resets_at, read_at, read_node: 'W' })

test('帳號列表：每條自己寫重置時間；已過的寫可能已恢復；舊資料標「資料較舊」', () => {
  const q = rosterQuota(entry([w('five_hour', 40, iso(NOW + 20 * MIN)), w('weekly', 72, iso(new Date(2026, 9, 31, 14, 0).getTime()))]), { now: NOW })
  assert.deepEqual(q.bars.map(b => [b.label, b.pct, b.reset, b.expired]), [['5 小時', 40, '約 20 分鐘後重置', false], ['每週', 72, '週六 14:00 重置', false]])
  assert.equal(q.oldText, '')
  const old = rosterQuota(entry([w('five_hour', 3, iso(NOW - H), iso(NOW - 9 * H)), w('weekly', 72, iso(NOW + 2 * D), iso(NOW - 9 * H))]), { now: NOW })
  assert.deepEqual(old.bars.map(b => [b.label, b.reset, b.expired]), [['5 小時', RESET_PASSED, true], ['每週', '週五 10:00 重置', false]])
  assert.equal(old.stale, true)
  assert.equal(old.oldText, '資料較舊')
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

test('接線：電腦設定頁與手機的帳號卡都畫兩條額度、各自的重置時間、「資料較舊」；不再整段斜體', () => {
  const panel = read('ui/lib/settings-panel.mjs'), m = read('ui/m.html')
  for (const src of [panel, m]) {
    assert.match(src, /b\.reset/)
    assert.match(src, /oldText/)
    assert.match(src, /role="progressbar"/)
  }
  const css = read('ui/style.css') + read('ui/mobile.css')
  assert.doesNotMatch(css, /quota\.stale\{[^}]*italic/)
})
