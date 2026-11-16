// 登入失效標示（0.1.113）：帳號回報帶 login_failed／login_incomplete，手機帳號頁那台那個帳號要標出來。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { acctDeviceTree } from '../ui/lib/mobile-acct.mjs'
import { CURRENT_FAILED_ARIA, CURRENT_LABEL, INCOMPLETE_LABEL, LOGIN_FAILED_LABEL, loginFailed } from '../ui/lib/claude-accounts.mjs'

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

test('手機頁接線（#1592）：沒有獨立的紅色「登入失效」標籤，改成「使用中」那一格交替顯示', () => {
  const html = read('ui', 'm.html')
  // 獨立紅標籤只給「沒在使用」的失效帳號；使用中的走交替格
  assert.equal((html.match(/m-dv-failed/g) ?? []).length, 1)
  assert.match(html, /<span class="m-dv-failed" v-if="a\.loginFailed && !a\.current">\{\{ LOGIN_FAILED_LABEL \}\}<\/span>/)
  assert.match(read('ui', 'mobile.css'), /\.m-dv-failed\{[^}]*background:#b3261e[^}]*color:#fff/)
  // 同一格：使用中才有；登入失效時加 failed、兩個字節點都 aria-hidden，整格用 aria-label 讀出兩個狀態
  assert.match(html, /<span class="m-dv-cur" :class="\{ failed: a\.loginFailed \}" v-if="a\.current"/)
  assert.match(html, /:aria-label="a\.loginFailed \? CURRENT_FAILED_ARIA : null"/)
  assert.match(html, /<span class="m-dv-cur-a" :aria-hidden="a\.loginFailed \? 'true' : null">\{\{ CURRENT_LABEL \}\}<\/span>/)
  assert.match(html, /<span class="m-dv-cur-b" v-if="a\.loginFailed" aria-hidden="true">\{\{ LOGIN_FAILED_LABEL \}\}<\/span>/)
  assert.match(read('ui', 'm.js'), /CURRENT_LABEL, CURRENT_FAILED_ARIA/)
  // 文字都在 lib，不寫死在 html
  assert.equal(CURRENT_FAILED_ARIA, '使用中，登入失效')
  assert.equal(CURRENT_LABEL, '使用中')
})

test('手機頁樣式（#1592）：純 CSS 交替、兩字疊同一格不推版面、減少動態時固定顯示紅色「登入失效」', () => {
  const css = read('ui', 'mobile.css')
  assert.match(css, /\.m-dv-cur\.failed\{[^}]*display:inline-grid[^}]*animation:m-dv-cur-bg 2s/)
  assert.match(css, /\.m-dv-cur\.failed>span\{grid-area:1\/1\}/)
  assert.match(css, /@keyframes m-dv-cur-a\{/)
  assert.match(css, /@keyframes m-dv-cur-b\{/)
  const rm = css.match(/@media \(prefers-reduced-motion:reduce\)\{\.m-dv-cur\.failed[^\r\n]*/)?.[0] ?? ''
  assert.match(rm, /\.m-dv-cur\.failed\{animation:none;background:#b3261e\}/)
  assert.match(rm, /\.m-dv-cur\.failed>\.m-dv-cur-a\{animation:none;opacity:0\}/)
  assert.match(rm, /\.m-dv-cur\.failed>\.m-dv-cur-b\{animation:none;opacity:1\}/)
  // 沒失效的「使用中」也會渲染 .m-dv-cur-a：任何帶 animation 的 a／b 規則，選擇器都必須限定在 .failed 底下
  const rules = [...css.matchAll(/([^{}]*\.m-dv-cur-[ab][^{}]*)\{[^}]*animation[^}]*\}/g)].map(m => m[1].trim().replace(/^.*\{/, ''))
  assert.ok(rules.length >= 4)
  for (const sel of rules) assert.match(sel, /\.m-dv-cur\.failed>\.m-dv-cur-[ab]/, `${sel} 沒限定在 .failed 底下`)
})
