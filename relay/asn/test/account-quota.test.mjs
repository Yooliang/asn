// 各 Claude 帳號剩餘額度（#228）：顯示邏輯、設備樹帶入、電腦／手機頁面接線的守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { quotaView, quotaOf, STALE_MS, QUOTA_NOTE } from '../ui/lib/account-quota.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree, ACCT_TEXT } from '../ui/lib/mobile-acct.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-24T12:00:00Z')
const iso = ms => new Date(ms).toISOString()
const MIN = 60_000

test('剛記錄的額度：5 小時剩幾%、每週剩幾%，並標「N 分鐘前」', () => {
  const v = quotaView({ five_hour_pct: 62, weekly_pct: 80, at: iso(NOW - 5 * MIN) }, NOW)
  assert.equal(v.known, true)
  assert.equal(v.text, '5 小時剩 62%、每週剩 80%')
  assert.equal(v.meta, '5 分鐘前')
  assert.equal(v.stale, false)
  assert.equal(v.exhausted, false)
})

test('只有其中一個視窗有數字就只寫那一個，不編另一個', () => {
  assert.equal(quotaView({ five_hour_pct: 10, at: iso(NOW) }, NOW).text, '5 小時剩 10%')
  assert.equal(quotaView({ weekly_pct: 0, at: iso(NOW), reset_at: iso(NOW + 3600_000) }, NOW).text.startsWith('每週剩 0%'), true)
})

test('沒有任何額度紀錄：寫「額度未知」，不顯示任何數字', () => {
  for (const a of [{}, null, undefined, { five_hour_pct: null }, { five_hour_pct: 'x', weekly_pct: NaN, at: iso(NOW) }, { five_hour_pct: 50 /* 沒有記錄時間 */ }]) {
    const v = quotaView(a, NOW)
    assert.equal(v.known, false, JSON.stringify(a))
    assert.equal(v.text, '額度未知')
    assert.doesNotMatch(v.text, /\d/)
  }
})

test('超過 6 小時：標灰並寫「資料較舊」，仍保留當時的數字與時間', () => {
  const v = quotaView({ five_hour_pct: 62, weekly_pct: 80, at: iso(NOW - STALE_MS - MIN) }, NOW)
  assert.equal(STALE_MS, 6 * 3600_000)
  assert.equal(v.stale, true)
  assert.match(v.meta, /6 小時前/)
  assert.match(v.meta, /資料較舊/)
  assert.equal(quotaView({ five_hour_pct: 62, at: iso(NOW - STALE_MS + MIN) }, NOW).stale, false, '剛好未滿 6 小時不算舊')
})

test('額度用完：標明何時重置；重置時間已過就說可能已恢復，不再宣稱用完', () => {
  const out = quotaView({ five_hour_pct: 0, weekly_pct: 70, reset_at: iso(NOW + 90 * MIN), at: iso(NOW - MIN) }, NOW)
  assert.equal(out.exhausted, true)
  assert.match(out.text, /5 小時剩 0%/)
  assert.match(out.resetText, /^\d{2}:\d{2} 重置$|^\d+\/\d+ \d{2}:\d{2} 重置$/)
  const past = quotaView({ five_hour_pct: 0, reset_at: iso(NOW - MIN), at: iso(NOW - 30 * MIN) }, NOW)
  assert.equal(past.exhausted, false)
  assert.match(past.resetText, /重置時間已過/)
  assert.equal(quotaView({ five_hour_pct: 0, at: iso(NOW) }, NOW).resetText, '重置時間未知')
})

test('百分比超出範圍的亂數字不採用（0～100 的數字才算）', () => {
  assert.equal(quotaView({ five_hour_pct: 150, weekly_pct: -5, at: iso(NOW) }, NOW).known, false)
})

test('quotaOf 只取四個額度欄位，其他欄位（含權杖類）一律丟掉', () => {
  const q = quotaOf({ email: 'a@x.test', five_hour_pct: 1, weekly_pct: 2, reset_at: 'R', at: 'T', accessToken: 'SECRET', token: 'SECRET' })
  assert.deepEqual(Object.keys(q).sort(), ['at', 'five_hour_pct', 'reset_at', 'weekly_pct'])
  assert.ok(!JSON.stringify(q).includes('SECRET'))
})

test('設備樹：別台電腦回報帶額度就帶進帳號列；沒帶的帳號顯示額度未知', () => {
  const friends = [{ node: 'S', device: '本機', engine: 'claude', kind: 'pc' }, { node: 'W', device: '工作機', engine: 'claude', kind: 'pc', status: 'online' }]
  const reports = { W: { error: '', asnOnline: true, reportedAt: iso(NOW), accounts: [
    { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 62, weekly_pct: 80, at: iso(NOW - 2 * MIN) },
    { vendor: 'claude', email: 'b@x.test', plan: 'pro', current: false },
  ] } }
  const w = buildDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, now: NOW }).find(d => d.key === 'W')
  const rows = w.vendors.find(v => v.key === 'claude').accounts
  assert.equal(rows[0].quota.text, '5 小時剩 62%、每週剩 80%')
  assert.equal(rows[1].quota.known, false)
  assert.equal(rows[1].quota.text, '額度未知')
})

test('設備樹：這台電腦的帳號用本機額度紀錄（self.claude 內帶欄位）', () => {
  const friends = [{ node: 'S', device: '本機', engine: 'claude', kind: 'pc' }]
  const self = { claude: [{ email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 40, weekly_pct: 55, at: iso(NOW - MIN) }] }
  const s = buildDeviceTree({ friends, nodeOrder: ['S'], selfNode: 'S', self, now: NOW })[0]
  assert.equal(s.vendors.find(v => v.key === 'claude').accounts[0].quota.text, '5 小時剩 40%、每週剩 55%')
})

test('Codex 帳號不顯示額度（我們沒有它的額度來源，不編）', () => {
  const friends = [{ node: 'S', device: '本機', engine: 'claude', kind: 'pc' }, { node: 'W', device: '工作機', engine: 'gpt', kind: 'pc', status: 'online' }]
  const reports = { W: { error: '', asnOnline: true, reportedAt: iso(NOW), accounts: [{ vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true, five_hour_pct: 99, at: iso(NOW) }] } }
  const w = buildDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, now: NOW }).find(d => d.key === 'W')
  assert.equal(w.vendors.find(v => v.key === 'codex').accounts[0].quota, undefined)
})

test('手機：設備樹照樣帶額度，並且提示改成老實的說明（不再說「看不到額度」）', () => {
  const friends = [{ node: 'S', device: '手機', engine: 'asn', kind: 'phone' }, { node: 'W', device: '工作機', engine: 'claude', kind: 'pc', status: 'online' }]
  const reports = { W: { loading: false, asnOnline: true, reportedAt: iso(NOW), msg: '', list: [{ vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, five_hour_pct: 20, weekly_pct: 30, at: iso(NOW - 3 * MIN) }] } }
  const w = acctDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, now: NOW }).find(d => d.key === 'W')
  assert.equal(w.vendors.find(v => v.key === 'claude').accounts[0].quota.text, '5 小時剩 20%、每週剩 30%')
  assert.doesNotMatch(ACCT_TEXT.quotaNote, /看不到/)
  assert.match(ACCT_TEXT.quotaNote, /額度/)
  assert.equal(ACCT_TEXT.quotaNote, QUOTA_NOTE)
})

test('頁面接線：手機與電腦的帳號列都畫出額度，且有深色模式可讀的樣式', () => {
  const m = read('ui/m.html'), panel = read('ui/lib/settings-panel.mjs')
  assert.match(m, /a\.quota/, '手機頁面要畫 a.quota')
  assert.match(panel, /a\.quota/, '電腦頁面要畫 a.quota')
  assert.match(panel, /quotaOf|quotaView/, '電腦這台的帳號列要有額度')
  const css = read('ui/style.css') + read('ui/mobile.css')
  assert.match(css, /\.dv-quota/); assert.match(css, /\.m-dv-quota/)
  assert.match(css, /\.dv-quota\.stale|\.m-dv-quota\.stale/)
  assert.doesNotMatch(read('ui/lib/account-quota.mjs'), /[A-Za-z]{4,} 剩|remaining/, '給人看的字純中文')
})

test('本機的額度紀錄要被讀進電腦版狀態（claude_quota_all），並合進這台的帳號列', () => {
  const acc = read('ui/lib/claude-accounts.mjs')
  assert.match(acc, /claude_quota_all/)
  assert.match(acc, /\.\.\.quotaOf\(q\[a\.email\]\)/)
})
