// 登入失效標示（0.1.113）：帳號回報帶 login_failed／login_incomplete，手機帳號頁那台那個帳號要標出來。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { INCOMPLETE_LABEL, LOGIN_FAILED_LABEL, loginFailed } from '../ui/lib/claude-accounts.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-31T12:00:00Z')
const friends = [{ node: 'S', device: '手機', engine: 'asn', kind: 'phone' }, { node: 'W', device: '工作機', engine: 'claude', kind: 'pc', status: 'online' }]
const accountsOf = list => {
  const reports = { W: { loading: false, asnOnline: true, reportedAt: new Date(NOW).toISOString(), msg: '', list } }
  return acctDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, now: NOW }).find(d => d.key === 'W').vendors.find(v => v.key === 'claude').accounts
}

test('標籤是純繁體中文：登入失效、登入不完整', () => {
  assert.equal(LOGIN_FAILED_LABEL, '登入失效')
  assert.equal(INCOMPLETE_LABEL, '登入不完整')
})

test('回報帶 login_failed:true 的帳號標登入失效；false、沒帶、非布林都不標', () => {
  const rows = accountsOf([
    { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, login_failed: true },
    { vendor: 'claude', email: 'b@x.test', plan: 'max', current: false, login_failed: false },
    { vendor: 'claude', email: 'c@x.test', plan: 'max', current: false },
    { vendor: 'claude', email: 'd@x.test', plan: 'max', current: false, login_failed: 'true' },
  ])
  assert.deepEqual(rows.map(r => r.loginFailed === true), [true, false, false, false])
  assert.equal(loginFailed({ login_failed: true }), true)
  assert.equal(loginFailed(undefined), false)
})

test('login_incomplete 照舊標登入不完整（和登入失效各自獨立）', () => {
  const rows = accountsOf([
    { vendor: 'claude', email: 'a@x.test', plan: 'max', current: true, login_failed: true },
    { vendor: 'claude', email: 'b@x.test', plan: 'max', current: false, login_incomplete: true },
  ])
  assert.equal(rows[1].incomplete, true)
  assert.equal(rows[1].loginFailed, undefined)
  assert.equal(rows[0].incomplete, false)
})

test('只有 Claude 帳號會標登入失效（其他廠牌帶了也不理）', () => {
  const reports = { W: { loading: false, asnOnline: true, reportedAt: new Date(NOW).toISOString(), msg: '', list: [{ vendor: 'grok', email: 'g@x.test', current: true, login_failed: true }] } }
  const d = acctDeviceTree({ friends, nodeOrder: ['S', 'W'], selfNode: 'S', reports, now: NOW }).find(x => x.key === 'W')
  assert.equal(d.vendors.find(v => v.key === 'grok').accounts[0].loginFailed, undefined)
})

test('手機頁接線：登入失效的標籤對著 loginFailed，不受「使用中」影響（使用中的帳號才是壞的那個）；樣式為紅色', () => {
  const html = read('ui', 'm.html')
  assert.match(html, /<span class="m-dv-failed" v-if="a\.loginFailed">\{\{ LOGIN_FAILED_LABEL \}\}<\/span>/)
  assert.match(read('ui', 'm.js'), /LOGIN_FAILED_LABEL,/)
  assert.match(read('ui', 'mobile.css'), /\.m-dv-failed\{[^}]*#b3261e/)
})
