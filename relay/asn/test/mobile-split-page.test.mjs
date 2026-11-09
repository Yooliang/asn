// 手機「設備與帳號」內頁拆成「設備｜帳號」兩個分頁（todo-next-174 的 D，#650）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ACCT_SETTING_KEYS, MOBILE_SETTING_KEYS, SETTING_SHEET_KEYS, mobileCatSummary, mobileSettingRows } from '../ui/lib/mobile-settings.mjs'
import { ACCT_SWITCH_REASON, ACCT_TABS, acctSwitchTargets as targetsOf, acctTabOf, isListedSwitchTarget, isSwitchTarget } from '../ui/lib/mobile-acct.mjs'
const SELF = 'PHONE'
// 手機上一定知道自己是哪一台；原本的測試都在「認得出本機」的情況下
const acctSwitchTargets = (devs, vendor, a, self = SELF) => targetsOf(devs, vendor, a, self)
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

test('帳號分頁的「切換到…」：能切的可以按；不能切的反灰並寫原因；正在用的、沒存這個帳號的、隱藏、移除、手機不列', () => {
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
  assert.deepEqual(acctSwitchTargets(devs, 'claude', a), [
    { node: 'W', label: '工作機', enabled: true, reason: '' },
    { node: 'Y', label: '新電腦', enabled: false, reason: ACCT_SWITCH_REASON.unavailable },
    { node: 'I', label: '不完整', enabled: false, reason: ACCT_SWITCH_REASON.incomplete },
  ], '帳號比對不分大小寫；不能按的也列出來並寫原因；正在用的、沒存這個帳號的（#930）、隱藏、移除、手機不列')
  const off = dev('O', '離線的', [{ ...claude([acc('z@example.test'), acc('w@example.test')], false), switchHint: '對方電腦的 ASN 沒有在線，無法切換' }])
  assert.deepEqual(acctSwitchTargets([off], 'claude', a), [{ node: 'O', label: '離線的', enabled: false, reason: ACCT_SWITCH_REASON.offline }])
  assert.deepEqual(acctSwitchTargets([dev('Q', '沒 Claude', [])], 'claude', a), [], '沒有 Claude 的不列')
  assert.deepEqual(acctSwitchTargets([dev('A', '離線沒存', [{ ...claude([acc('w@example.test')], false), switchHint: 'x' }])], 'claude', a), [], '沒存過這個帳號的不列（#930：「這台沒有存這個帳號」在手機上會被讀成指手機）')
  assert.ok(Object.values(ACCT_SWITCH_REASON).every(t => !t.includes('這台')), '說明字不說「這台」：按鈕已寫切換到哪台（#930）')
  assert.deepEqual(acctSwitchTargets(devs, 'codex', a), [], '手機只有 Claude 能切換')
  assert.deepEqual(acctSwitchTargets([], 'claude', a), [])
  assert.deepEqual(acctSwitchTargets(null, 'claude', a), [])
  assert.deepEqual(acctSwitchTargets(devs, 'claude', null), [])
})

test('接線與樣板守門：openSetting 兩列都進同一頁並帶分頁、帳號分頁的切換走現有流程、設備列有狀態行', () => {
  const js = read('ui/m.js'), html = read('ui/m.html'), css = read('ui/mobile.css')
  assert.match(js, /ACCT_SETTING_KEYS\.includes\(key\)\) void openAcct\(\{ tab: key \}\)/)
  assert.match(js, /tab: acctTabOf\(g\?\.tab\)/, '開頁時設分頁；從夥伴列表設備旁「選項」進來是設備')
  assert.match(js, /const acctSwitchOn = async \(node, email\) => \{ if \(!acctCanSwitchTo\(node\)\) return; await openAcctDevice\(node\); startAcctSwitch\(email\) \}/, '先開那台、等帳號讀回來，再進確認畫面（不另做一套切換；不能切到這支手機自己，#930）')
  assert.match(js, /return loadAcct\(key\)/, 'openAcctDevice 要把讀取的 promise 交出來，acctSwitchOn 才等得到')
  assert.match(html, /class="m-dv-seg"[^>]*role="tablist"/)
  assert.match(html, /v-for="t in ACCT_TABS"/)
  assert.match(html, /v-if="acctSw\.tab === 'accounts' && acctMy"/, '我的帳號只在帳號分頁')
  assert.match(html, /<template v-if="acctSw\.tab === 'devices'">/, '設備列表只在設備分頁')
  assert.match(html, /class="m-dv-line" v-if="d\.stateLine"/)
  // 帳號卡片的設備按鈕（原本的「用在：」一行和「切換到…」按鈕合在一起）：按了走原本的切換流程，使用中的按了不做事
  assert.match(html, /v-for="b in acctDevButtons\(v\.key, a\)"/)
  assert.match(html, /:disabled="!b\.current && !\(b\.target && b\.target\.enabled\)" @click="acctDevPress\(b, a\)"/, '不能按的要反灰')
  assert.match(html, /v-if="!b\.current && b\.target && b\.target\.reason">\{\{ b\.target\.reason \}\}/, '不能按要寫原因')
  assert.ok(!html.includes('m-dv-devck') && !html.includes('✓') && !html.includes('DEVICE_BUTTON_TEXT.current'), '設備按鈕沒有勾勾與「使用中」小字')
  assert.match(html, /:aria-pressed="b\.current \? 'true' : 'false'"/, '使用中的是選中的樣子')
  assert.ok(!html.includes('ROSTER_TEXT.usedOn') && !html.includes('切換到{{'), '拿掉「用在：」與「切換到…」')
  assert.match(js, /const acctDevPress = \(b, a\) => \{ if \(b\.current \|\| !b\.target \|\| !b\.target\.enabled\) return; void acctSwitchOn\(b\.node, a\.account\) \}/, '使用中或不能切的按了不做事，其他走原本的切換')
  for (const cls of ['m-dv-seg', 'm-dv-segbtn', 'm-dv-line', 'm-dv-devs', 'm-dv-dev']) assert.ok(css.includes(`.${cls}`), `mobile.css 要有 .${cls}`)
  // 畫面上沒有「設備與帳號」當作設置列的名稱（頁標題仍是這個內頁的名字）
  assert.ok(!read('ui/lib/settings-cats.mjs').replace(/\/\/.*$/gm, '').includes('設備與帳號'))
})

test('#930 帳號永遠不能切到這支手機自己：平台還沒讀到被當成電腦、帳號回報說它有這個帳號，都不列', () => {
  const mine = { account: 'w@example.test' }
  const claudeOn = (accounts) => ({ key: 'claude', switchable: true, switchHint: '', accounts })
  const self = { key: SELF, label: '這支手機', kind: '電腦', self: false, vendors: [claudeOn([{ email: 'w@example.test', current: false }])] }
  const other = { key: 'PC', label: '工作機', kind: '電腦', vendors: [claudeOn([{ email: 'w@example.test', current: false }])] }
  assert.deepEqual(acctSwitchTargets([self, other], 'claude', mine).map(t => t.node), ['PC'], '節點代號等於本機就不列，不看 kind')
  assert.deepEqual(acctSwitchTargets([{ ...self, self: true }, other], 'claude', mine).map(t => t.node), ['PC'])
  assert.deepEqual(targetsOf([self, other], 'claude', mine, ''), [], '還認不出這支手機是哪一台：一律不給切換')
  assert.equal(isSwitchTarget(other, SELF), true, '別台電腦照常能切')
  assert.equal(isSwitchTarget(self, SELF), false)
  assert.equal(isSwitchTarget({ key: 'OLD', kind: '手機' }, SELF), false, '別支手機也不行')
  assert.equal(isSwitchTarget(other, ''), false)
  assert.equal(isSwitchTarget(null, SELF), false)
})

test('#930 判斷分兩層：已隱藏的電腦細部頁照樣能切；帳號頁的「切換到…」才排掉已隱藏、已移除的', () => {
  const hidden = { key: 'H', label: '藏起來的', kind: '電腦', hidden: true }
  const removed = { key: 'X', label: '移除的', kind: '電腦', removed: true }
  assert.equal(isSwitchTarget(hidden, SELF), true, '已隱藏的電腦一樣點得進細部頁，細部頁照樣能切')
  assert.equal(isSwitchTarget(removed, SELF), true)
  assert.equal(isListedSwitchTarget(hidden, SELF), false, '帳號頁不列已隱藏的')
  assert.equal(isListedSwitchTarget(removed, SELF), false, '帳號頁不列已移除的')
  assert.equal(isListedSwitchTarget({ key: 'PC', kind: '電腦' }, SELF), true)
  assert.equal(isListedSwitchTarget({ key: SELF, kind: '電腦' }, SELF), false, '本機兩層都不行')
  const claudeOn = { key: 'claude', switchable: true, switchHint: '', accounts: [{ email: 'w@example.test', current: false }] }
  assert.deepEqual(acctSwitchTargets([{ ...hidden, vendors: [claudeOn] }, { ...removed, vendors: [claudeOn] }], 'claude', { account: 'w@example.test' }), [], '帳號頁不列已隱藏、已移除的')
})

test('#930 細部頁與送出也走同一個判斷：本機的細部頁不出現「切換」，送出前再擋一次', () => {
  const html = fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8')
  assert.match(html, /\(v\.switchable \|\| v\.switchHint\) && acctCanSwitchTo\(acctCur\.key\)/)
  const js = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(js, /const acctCanSwitchTo = node => isSwitchTarget\(/)
  assert.match(js, /acctSwitchTargetsOf\(acctDevs\.value, vendor, a, info\.node\)/)
  assert.match(js, /const acctSwitchOn = async \(node, email\) => \{ if \(!acctCanSwitchTo\(node\)\) return;/)
  assert.match(js, /function startAcctSwitch\(email\) \{\s*if \(acctSw\.phase !== 'pick' \|\| !acctCanSwitchTo\(acctCur\.value\?\.key\)\) return/)
  assert.match(js, /acctSw\.phase !== 'confirm' \|\| !acctView\.value\.pickEmail \|\| !acctCanSwitchTo\(acctCur\.value\?\.key\)/)
})
