// 手機「選項」整頁改成電腦版同款的「設備與帳號」（10-24）：橫向設備頁籤 → 廠商卡片 → 帳號列。
// 資料用電腦版同一份整理函式（device-tree），手機只補它拿不到的差異；切換流程（確認 → 送出 → 進度）沿用 mobile-acct.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ACCT_PAGE_TITLE, acctClaudeRemote, acctDeviceTree, acctNeedsLoad, acctPickDevice, acctReportOf, acctSheetView } from '../ui/lib/mobile-acct.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctNav, tabLabel } from '../ui/lib/mobile.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const S = 'aaaaaaaa-0000-4000-8000-000000000001', W = 'bbbbbbbb-0000-4000-8000-000000000002', P = 'cccccccc-0000-4000-8000-000000000003', E = 'dddddddd-0000-4000-8000-000000000004'
const fr = (node, device, engine, o = {}) => ({ node, device, engine, kind: 'pc', status: 'online', id: `${node}/${engine}`, ...o })
const friends = [fr(S, '手機本機', 'asn', { kind: 'phone' }), fr(W, '工作機', 'claude'), fr(W, '工作機', 'gemini'), fr(P, '平板', 'claude', { kind: 'phone' }), fr(E, '舊電腦', 'claude', { status: 'offline' })]
const rep = (accounts, o = {}) => ({ loading: false, asnOnline: true, reportedAt: new Date().toISOString(), msg: '', list: accounts, ...o })
const REPORTS = { [W]: rep([{ vendor: 'claude', email: 'w1@x.test', plan: 'pro', current: true }, { vendor: 'claude', email: 'w2@x.test', plan: 'max', current: false }, { vendor: 'codex', email: 'c@x.test', plan: 'plus', current: true }]) }

test('整頁資料：用電腦版同一份整理函式（device-tree），廠商與帳號與直接呼叫一致', () => {
  const mine = acctDeviceTree({ friends, nodeOrder: [S, W, P, E], selfNode: S, reports: REPORTS })
  const desk = buildDeviceTree({ friends, nodeOrder: [S, W, P, E], selfNode: S, reports: Object.fromEntries(Object.entries(REPORTS).map(([k, r]) => [k, acctReportOf(r)])) })
  assert.deepEqual(mine.map(d => d.key), desk.map(d => d.key))
  const w = mine.find(d => d.key === W), dw = desk.find(d => d.key === W)
  assert.deepEqual(w.vendors.map(v => [v.key, v.accounts]), dw.vendors.map(v => [v.key, v.accounts]))
  assert.deepEqual(w.vendors.find(v => v.key === 'claude').accounts.map(a => a.email), ['w1@x.test', 'w2@x.test'])
  assert.deepEqual(w.vendors.find(v => v.key === 'codex').accounts.map(a => a.email), ['c@x.test'])
  assert.deepEqual(w.vendors.find(v => v.key === 'gemini').accounts, [], '沒回報的廠商是空陣列（畫面寫「目前未回報任何帳號」）')
  assert.equal(w.online, true)
  assert.equal(mine.find(d => d.key === E).online, false)
})

test('整頁資料：只有別台電腦的 Claude 可切換；手機只顯示；對方 ASN 離線時給提示', () => {
  const t = acctDeviceTree({ friends, nodeOrder: [S, W, P, E], selfNode: S, reports: { ...REPORTS, [P]: rep([{ vendor: 'claude', email: 'p1@x.test', current: true }, { vendor: 'claude', email: 'p2@x.test', current: false }]) } })
  const claudeOf = k => t.find(d => d.key === k).vendors.find(v => v.key === 'claude')
  assert.equal(claudeOf(W).switchable, true)
  assert.equal(claudeOf(P).switchable, false, '別支手機不提供切換')
  assert.equal(claudeOf(P).switchHint, '', '手機不顯示「ASN 沒有在線」那種誤導的提示')
  assert.equal(t.find(d => d.key === S).self, true)
  const off = acctDeviceTree({ friends, nodeOrder: [W], selfNode: S, reports: { [W]: rep([{ vendor: 'claude', email: 'a@x.test', current: true }, { vendor: 'claude', email: 'b@x.test' }], { asnOnline: false }) } })
  const c = off.find(d => d.key === W).vendors.find(v => v.key === 'claude')
  assert.equal(c.switchable, false)
  assert.match(c.switchHint, /沒有在線/)
})

test('整頁資料：本機是手機，標籤不叫「這台電腦」；整台沒回報＝空狀態；讀取中或失敗不當成有帳號', () => {
  const t = acctDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports: {} })
  const me = t.find(d => d.self)
  assert.equal(me.label, '手機本機')
  assert.equal(acctDeviceTree({ friends: [{ ...friends[0], device: '' }], selfNode: S })[0].label, '這支手機')
  assert.equal(me.vendors.length, 0); assert.ok(me.empty)
  const loading = acctDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports: { [W]: { ...REPORTS[W], loading: true } } }).find(d => d.key === W)
  assert.equal(loading.vendors.find(v => v.key === 'claude').accounts.length, 0)
  const failed = acctDeviceTree({ friends, nodeOrder: [S, W], selfNode: S, reports: { [W]: rep([], { msg: '沒有權限' }) } }).find(d => d.key === W)
  assert.match(failed.reportedText, /讀取失敗/)
})

test('預設選哪個頁籤：指定的設備優先；指定不到選第一台別台設備；都沒有就第一個', () => {
  const t = acctDeviceTree({ friends, nodeOrder: [S, W, P, E], selfNode: S, reports: {} })
  assert.equal(acctPickDevice(t, W).key, W)
  assert.equal(acctPickDevice(t, E).key, E)
  assert.equal(acctPickDevice(t, 'zzz').key, W)
  assert.equal(acctPickDevice(t, '').key, W)
  assert.equal(acctPickDevice([t[0]], 'zzz').key, S)
  assert.equal(acctPickDevice([], 'x'), null)
  assert.equal(acctNeedsLoad(t.find(d => d.key === W)), true)
  assert.equal(acctNeedsLoad(t.find(d => d.self)), false, '本機不用讀遠端帳號')
  assert.equal(acctNeedsLoad(t.find(d => d.key === P)), false, '手機不讀')
  assert.equal(acctNeedsLoad(null), false)
})

test('Claude 的確認畫面資料：只取 Claude 帳號交給既有的 acctSheetView', () => {
  const r = acctClaudeRemote(REPORTS[W])
  assert.deepEqual(r.list.map(a => a.email), ['w1@x.test', 'w2@x.test'])
  const v = acctSheetView(r, 'w2@x.test')
  assert.equal(v.pickEmail, 'w2@x.test'); assert.equal(v.canPick, true); assert.equal(v.currentEmail, 'w1@x.test')
  assert.deepEqual(acctClaudeRemote(undefined).list, [])
  assert.equal(acctReportOf(undefined), undefined)
  assert.equal(acctReportOf({ ...REPORTS[W], loading: true }), undefined)
  assert.equal(acctReportOf({ ...REPORTS[W], msg: '壞了' }).error, '壞了')
})

test('整頁畫面接線（細部頁）：廠商卡片、帳號列、虛線未回報、離線偏灰、整台空狀態；設備列表與排序見 device-list-page.test.mjs', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  const pane = /<section class="m-pg m-chat"[\s\S]*?<!-- 設置 -->/.exec(html)[0]
  assert.match(pane, /v-for="d in acctDevs"[\s\S]*?class="m-dv-go"/, '先是設備列表')
  assert.match(pane, /m-dv-dot/)
  assert.match(pane, /v-for="v in acctCur\.vendors"/)
  assert.match(pane, /vendorIconSvg\(v\.key\)/)
  assert.match(pane, /v-for="a in v\.accounts"/)
  assert.match(pane, /使用中/)
  assert.match(pane, /目前未回報任何帳號/)
  assert.match(pane, /class="m-dv-body" :class="{ off:/)
  assert.match(pane, /acctCur\.empty/)
  assert.match(pane, /@click="startAcctSwitch\(a\.email\)"/)
  assert.match(pane, /v\.key === 'claude'/, '只有 Claude 有切換鈕')
  assert.match(pane, /acctSw\.phase === 'confirm'/)
  assert.match(pane, /submitAcct/)
  assert.doesNotMatch(pane, /acctSections|ACCT_TEXT\.title\(/)
  assert.equal(ACCT_PAGE_TITLE, '設備與帳號')
  assert.match(pane, /ACCT_PAGE_TITLE/)
  // 資料只走電腦版的整理函式，手機端不另寫一套
  assert.match(read('ui', 'lib', 'mobile-acct.mjs'), /from '\.\/device-tree\.mjs'/)
  assert.match(js, /acctDeviceTree\(/)
  assert.doesNotMatch(js, /buildDeviceTree|vendorLabel|VENDOR_LABEL/)
  // 樣式：觸控區至少 40px、離線偏灰、虛線框（橫向頁籤已被列表取代）
  for (const sel of ['m-dv-list', 'm-dv-row', 'm-dv-vendor', 'm-dv-acct', 'm-dv-none', 'm-dv-body.off', 'm-dv-sw']) assert.ok(css.includes(`.${sel}`), `缺樣式 ${sel}`)
  assert.match(/\.m-dv-sw\{([^}]*)\}/.exec(css)[1], /min-height:\s*4\dpx/)
  assert.match(/\.m-dv-none\{([^}]*)\}/.exec(css)[1], /dashed/)
  assert.match(/\.m-dv-body\.off\{([^}]*)\}/.exec(css)[1], /grayscale/)
  assert.match(read('ui', 'lib', 'mobile.mjs'), /SWIPE_BLOCK_SELECTOR = '[^']*\.m-dv-grip/, '拖排序把手時不能被分頁手勢搶走')
})

test('流程行為：點「切換」＝選好帳號進確認畫面；從夥伴列表進來直接開那台的細部頁；導覽與分頁標籤維持', () => {
  const js = read('ui', 'm.js')
  assert.match(js, /async function openAcct\(g\)[\s\S]*?acctSw\.node = g\.node/, '直接開點進來的那台設備')
  assert.match(js, /function startAcctSwitch\(email\)[\s\S]*?acctSw\.phase = 'confirm'/)
  assert.match(js, /acctView\.value\.canPick/, '進確認前仍檢查能不能切換')
  assert.match(js, /if \(acctSw\.phase !== 'confirm' \|\| !acctView\.value\.pickEmail\) return/, '一定先看過確認畫面才送')
  assert.match(js, /acctSw\.phase = 'run'\n\s*acctSw\.view = await runAcctSwitch\(/, '送出後進進度畫面')
  assert.match(js, /android_acct_list/)
  assert.match(js, /go\(acctNav\(\)\)/)
  assert.equal(tabLabel('chats', acctNav()), '設備與帳號')
})
