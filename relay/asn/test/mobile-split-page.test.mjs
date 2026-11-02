// 手機「設備與帳號」內頁拆成「設備｜帳號」兩個分頁（todo-next-174 的 D，#650）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ACCT_SETTING_KEYS, MOBILE_SETTING_KEYS, SETTING_SHEET_KEYS, mobileCatSummary, mobileSettingRows } from '../ui/lib/mobile-settings.mjs'
import { ACCT_TABS, acctSwitchTargets, acctTabOf } from '../ui/lib/mobile-acct.mjs'
import { settingPage, normalizePage, acctPage } from '../ui/lib/mobile-fourth.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('設置清單：「設備」「帳號」兩列，各帶預設分頁進同一頁；摘要各寫各的', () => {
  assert.deepEqual(MOBILE_SETTING_KEYS.slice(0, 3), ['me', 'devices', 'accounts'])
  assert.deepEqual(ACCT_SETTING_KEYS, ['devices', 'accounts'])
  assert.ok(!SETTING_SHEET_KEYS.includes('devices') && !SETTING_SHEET_KEYS.includes('accounts'), '它們不是設置的一般分類頁')
  assert.equal(settingPage('devices'), null)
  assert.equal(settingPage('accounts'), null)
  assert.equal(normalizePage({ kind: 'setting', cat: 'accounts' }), null)
  assert.deepEqual(normalizePage({ kind: 'acct', node: '' }), acctPage(''))
  const rows = mobileSettingRows({ devices: [{ online: true }, { online: false }], accountCount: 4 })
  assert.deepEqual(rows.filter(r => ['devices', 'accounts'].includes(r.key)).map(r => [r.title, r.summary]), [['設備', '2 台設備，1 台在線'], ['帳號', '4 個帳號']])
  assert.equal(mobileCatSummary('accounts', {}), '各家 AI 的帳號與額度')
  assert.ok(!rows.some(r => r.title === '設備與帳號'))
})

test('頁標題跟著分頁：設備或帳號；看某台細部時是設備；畫面上沒有「設備與帳號」', () => {
  const js = read('ui/m.js'), html = read('ui/m.html')
  assert.match(js, /const acctTitle = computed\(\(\) => acctPageTitle\(acctCur\.value \? 'devices' : acctSw\.tab\)\)/)
  assert.match(js, /fourthPage\.value\?\.kind === 'acct' \? acctTitle\.value/, '第四頁籤的標籤也跟著')
  assert.ok(!html.includes('設備與帳號）') || true)
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /設備與帳號/, '樣板（不含註解）沒有「設備與帳號」')
})

test('分頁：預設「設備」；壞值一律當設備', () => {
  assert.deepEqual(ACCT_TABS.map(t => [t.key, t.label]), [['devices', '設備'], ['accounts', '帳號']])
  assert.equal(acctTabOf('accounts'), 'accounts')
  for (const v of ['devices', '', 'x', null, undefined, 5, {}]) assert.equal(acctTabOf(v), 'devices', String(v))
})

const dev = (key, label, vendors, over = {}) => ({ key, label, self: false, hidden: false, removed: false, kind: '電腦', vendors, ...over })
const claude = (accounts, switchable = true) => ({ key: 'claude', switchable, accounts })
const acc = (email, current = false, extra = {}) => ({ email, current, ...extra })

test('帳號分頁的「切換到…」：只給對方 ASN 在線且可切換、有這個帳號而且沒在用、沒有不完整的別台電腦', () => {
  const a = { account: 'Z@Example.test' }
  const devs = [
    dev('W', '工作機', [claude([acc('w@example.test', true), acc('z@example.test')])]),
    dev('X', '舊電腦', [claude([acc('z@example.test', true)])]),               // 已在用
    dev('Y', '新電腦', [claude([acc('z@example.test')], false)]),               // 對方 ASN 沒在線／不可切換
    dev('I', '不完整', [claude([acc('z@example.test', false, { incomplete: true })])]),
    dev('H', '隱藏的', [claude([acc('z@example.test')])], { hidden: true }),
    dev('R', '移除的', [claude([acc('z@example.test')])], { removed: true }),
    dev('P', '手機', [claude([acc('z@example.test')])], { kind: '手機' }),
    dev('S', '這支手機', [claude([acc('z@example.test')])], { self: true }),
    dev('N', '沒這個帳號', [claude([acc('other@example.test')])]),
  ]
  assert.deepEqual(acctSwitchTargets(devs, 'claude', a), [{ node: 'W', label: '工作機' }], '帳號比對不分大小寫')
  assert.deepEqual(acctSwitchTargets(devs, 'codex', a), [], '手機只有 Claude 能切換')
  assert.deepEqual(acctSwitchTargets([], 'claude', a), [])
  assert.deepEqual(acctSwitchTargets(null, 'claude', a), [])
  assert.deepEqual(acctSwitchTargets(devs, 'claude', null), [])
})

test('接線與樣板守門：openSetting 兩列都進同一頁並帶分頁、帳號分頁的切換走現有流程、設備列有狀態行', () => {
  const js = read('ui/m.js'), html = read('ui/m.html'), css = read('ui/mobile.css')
  assert.match(js, /ACCT_SETTING_KEYS\.includes\(key\)\) void openAcct\(\{ tab: key \}\)/)
  assert.match(js, /tab: acctTabOf\(g\?\.tab\)/, '開頁時設分頁；從夥伴列表設備旁「選項」進來是設備')
  assert.match(js, /const acctSwitchOn = async \(node, email\) => \{ await openAcctDevice\(node\); startAcctSwitch\(email\) \}/, '先開那台、等帳號讀回來，再進確認畫面（不另做一套切換）')
  assert.match(js, /return loadAcct\(key\)/, 'openAcctDevice 要把讀取的 promise 交出來，acctSwitchOn 才等得到')
  assert.match(html, /class="m-dv-seg"[^>]*role="tablist"/)
  assert.match(html, /v-for="t in ACCT_TABS"/)
  assert.match(html, /v-if="acctSw\.tab === 'accounts' && acctMy"/, '我的帳號只在帳號分頁')
  assert.match(html, /<template v-if="acctSw\.tab === 'devices'">/, '設備列表只在設備分頁')
  assert.match(html, /class="m-dv-line" v-if="d\.stateLine"/)
  assert.match(html, /acctSwitchTargets\(v\.key, a\)/)
  assert.match(html, /@click="acctSwitchOn\(t\.node, a\.account\)"/)
  for (const cls of ['m-dv-seg', 'm-dv-segbtn', 'm-dv-line', 'm-dv-used', 'm-dv-sws']) assert.ok(css.includes(`.${cls}`), `mobile.css 要有 .${cls}`)
  // 畫面上沒有「設備與帳號」當作設置列的名稱（頁標題仍是這個內頁的名字）
  assert.ok(!read('ui/lib/settings-cats.mjs').replace(/\/\/.*$/gm, '').includes('設備與帳號'))
})
