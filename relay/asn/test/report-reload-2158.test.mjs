// #2158：別台的帳號回報自動重讀，畫面只剩四種狀態，不再出現「在線」又「沒回報」。
// 用假時鐘、假計時器與假的後台回覆；畫面文字用電腦版設定頁（SSR）與手機版樣板守門檢查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { createAccountsUi } from '../ui/lib/claude-accounts.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { acctDeviceTree, acctReportEntry } from '../ui/lib/mobile-acct.mjs'
import { REPORT_FAIL_LIMIT, REPORT_FRESH_MS, REPORT_RELOAD_MS, REPORT_STATUS, REPORT_TEXT, deviceReportStatus } from '../ui/lib/device-state.mjs'
import { createReportScheduler, nextReport, reportsDue } from '../ui/lib/report-reload.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
const S = 'aaaaaaaa-0000-4000-8000-000000000001'
const W = 'bbbbbbbb-0000-4000-8000-000000000002'
const T0 = Date.parse('2026-11-23T10:00:00Z')
const iso = ms => new Date(ms).toISOString()
const OLD_TEXT = '還沒收到這台的回報'

const fr = (node, device, status = 'online') => ({ node, device, agent: `a-${node.slice(0, 2)}`, engine: 'claude', status, kind: null, partnerId: 'eeeeeeee-0000-4000-8000-0000000000aa' })
const tree = ({ rep, online = true, now = T0, mobile = false }) => {
  const args = {
    friends: [fr(S, '家用機'), fr(W, '工作機', online ? 'online' : 'offline')], nodeOrder: [S, W], selfNode: S, now,
    asn: online ? { [W]: [{}] } : {},
    launchers: { [S]: { profiles: [{ id: 'claude' }], detected: true }, [W]: { profiles: [{ id: 'claude' }] } },
    reports: rep ? { [W]: rep } : {},
    self: { claude: [{ email: 's@b.c', plan: 'max', current: true }], codex: { loggedIn: false, text: '' } },
  }
  const mobileReports = rep ? { [W]: { loading: false, asnOnline: true, reportedAt: rep.reportedAt, msg: rep.error, list: rep.accounts, failCount: rep.failCount } } : {}
  return (mobile ? acctDeviceTree({ ...args, reports: mobileReports }) : buildDeviceTree(args)).find(d => d.key === W)
}
const freshRep = (now = T0, extra = {}) => ({ error: '', asnOnline: true, reportedAt: iso(now - 60_000), accounts: [{ vendor: 'claude', email: 'w@b.c', plan: 'pro', current: true }], failCount: 0, ...extra })
const staleRep = (now = T0, extra = {}) => ({ ...freshRep(now), reportedAt: iso(now - REPORT_FRESH_MS - 60_000), ...extra })
const errRep = failCount => ({ error: '暫時讀不到', failedAt: T0, asnOnline: false, reportedAt: '', accounts: [], failCount })

test('#2158 開超過 15 分鐘：別台的回報會被自動重讀（假時鐘），不是只讀第一次', async () => {
  let t = T0
  let reportedAt = iso(T0)
  const calls = []
  const invoke = async (cmd, args) => { calls.push([cmd, args?.node]); return { asn_online: true, reported_at: reportedAt, accounts: [] } }
  const ui = createAccountsUi({ invoke, reactive: Vue.reactive, sleep: async () => {}, now: () => t })
  await ui.retryReports([W])
  assert.equal(calls.length, 1, '第一次出現：讀一次')
  t += 4 * 60_000
  assert.equal(await ui.retryReports([W]), 0, '5 分鐘內不重讀')
  // 開著放到超過 15 分鐘：每滿 5 分鐘重讀一次，回報時間跟著更新，永遠不會過期
  for (let i = 0; i < 6; i++) {
    t += REPORT_RELOAD_MS
    reportedAt = iso(t - 30_000)
    assert.equal(await ui.retryReports([W]), 1, `第 ${i + 1} 次滿 5 分鐘重讀`)
  }
  assert.ok(t - T0 > 15 * 60_000 + 60_000)
  assert.equal(deviceReportStatus({ rep: ui.state.reports[W], now: t }), REPORT_STATUS.OK, '開了 30 分鐘還是「有回報」')
  // 已經過期（超過 15 分鐘）的紀錄：一輪檢查就會重讀
  assert.deepEqual(reportsDue({ nodes: [W], reports: { [W]: staleRep(T0, { readAt: T0 - REPORT_RELOAD_MS }) }, now: T0 }), [W])
})

test('#2158 四種狀態各自的畫面文字：有回報不多寫／正在讀取（灰字轉圈）／讀不到（列上警告標籤＋詳情說明）／離線不寫', async () => {
  const ok = tree({ rep: freshRep() })
  assert.deepEqual([ok.reportStatus, ok.reportTag, ok.reportNote], [REPORT_STATUS.OK, '', null])
  const loading = tree({ rep: null })
  assert.deepEqual([loading.reportStatus, loading.reportTag, loading.reportNote], [REPORT_STATUS.LOADING, '', { text: '正在讀取這台的帳號資料…', busy: true }], '列上不放標籤')
  const failed = tree({ rep: errRep(REPORT_FAIL_LIMIT) })
  assert.equal(failed.reportStatus, REPORT_STATUS.FAILED)
  assert.equal(failed.reportTag, '讀不到帳號資料')
  assert.deepEqual(failed.reportNote, { text: '讀不到這台的帳號資料，會自動重試。一直讀不到，請在那台重新登入。', busy: false })
  const off = tree({ rep: errRep(5), online: false })
  assert.deepEqual([off.reportStatus, off.reportTag, off.reportNote], [REPORT_STATUS.NONE, '', null], '離線中：不寫任何回報字樣')
  // 畫面：電腦版設定頁的列與詳情
  globalThis.Vue = Vue
  const st = devices => ({ devices, accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts: null })
  const html = async (devices, extra = {}) => renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: st(devices), catKey: 'devices', meAv: '', ...extra }) }))
  const listOk = await html([ok]), listFailed = await html([failed]), listLoading = await html([loading]), listOff = await html([off])
  assert.ok(listFailed.includes('讀不到帳號資料') && listFailed.includes('dv-tag warn noreport'), '讀不到：列上警告標籤')
  for (const h of [listOk, listLoading, listOff]) assert.ok(!h.includes('讀不到帳號資料') && !h.includes('dv-tag warn noreport'), '其他三種列上不放標籤')
  const detail = d => html([d], { dev: W })
  const dLoading = await detail(loading)
  assert.ok(dLoading.includes('正在讀取這台的帳號資料…') && dLoading.includes('asn-spin'), '剛連上：詳情灰字＋轉圈')
  const dFailed = await detail(failed)
  assert.ok(dFailed.includes(failed.reportNote.text) && !dFailed.includes('asn-spin'), '讀不到：詳情說明、不轉圈')
  for (const [name, d] of [['有回報', await detail(ok)], ['離線', await detail(off)]]) assert.ok(!d.includes('讀取這台') && !d.includes('讀不到這台') && !d.includes('dvid-note'), `${name}：詳情不多寫`)
  for (const h of [listOk, listFailed, listLoading, listOff, dLoading, dFailed]) assert.ok(!h.includes(OLD_TEXT) && !h.includes('沒回報'), '舊字樣不再出現')
})

test('#2158 在線時永遠不會同時出現「在線」與「沒回報」：各種回報狀況全部掃過一遍（電腦與手機）', () => {
  const reps = [null, freshRep(), staleRep(), errRep(0), errRep(1), errRep(2), errRep(9), staleRep(T0, { failCount: 3 })]
  for (const mobile of [false, true]) for (const rep of reps) for (const online of [true, false]) {
    const d = tree({ rep, online, mobile })
    const shown = [d.onlineText, d.reportTag, d.reportNote?.text ?? ''].join('|')
    assert.ok(!shown.includes('沒回報') && !shown.includes(OLD_TEXT), `${mobile ? '手機' : '電腦'} 在線=${online} ${JSON.stringify(rep)}`)
    assert.ok(!('noReport' in d), '舊的 noReport 欄位已拿掉')
    if (!online) assert.equal(d.reportNote, null, '離線不寫回報字樣')
  }
  for (const f of ['ui/m.html', 'ui/lib/settings-panel.mjs', 'ui/lib/device-order.mjs', 'ui/lib/device-identity.mjs']) assert.ok(!read(f).includes('沒回報') && !read(f).includes(OLD_TEXT), f)
})

test('#2158 連續失敗兩次才顯示「讀不到」；讀到新的回報就歸零', async () => {
  let t = T0
  let mode = 'error'
  const log = []
  const invoke = async () => {
    if (mode === 'error') throw new Error('HTTP 503 raw-detail')
    return { asn_online: true, reported_at: iso(t - 10_000), accounts: [] }
  }
  const ui = createAccountsUi({ invoke, reactive: Vue.reactive, sleep: async () => {}, now: () => t, log: (...a) => log.push(a.join(' ')) })
  const status = () => deviceReportStatus({ rep: ui.state.reports[W], now: t })
  assert.equal(status(), REPORT_STATUS.LOADING, '還沒讀：正在讀取')
  await ui.retryReports([W])
  assert.equal(status(), REPORT_STATUS.LOADING, '第一次失敗：還是「正在讀取」，不說讀不到')
  assert.equal(tree({ rep: ui.state.reports[W], now: t }).reportTag, '')
  // 每分鐘照樣重試，但計次要距上次計次滿 5 分鐘：失敗 2 次、3 次、4 次但不到 5 分鐘 → 仍是「正在讀取」
  for (let i = 0; i < 4; i++) { t += 60_000; await ui.retryReports([W]); assert.equal(status(), REPORT_STATUS.LOADING, `第 ${i + 2} 次失敗、距第一次不到 5 分鐘：仍是正在讀取`) }
  t = T0 + REPORT_RELOAD_MS - 1
  await ui.retryReports([W])
  assert.equal(status(), REPORT_STATUS.LOADING, '差 1 毫秒滿 5 分鐘：仍是正在讀取')
  t = T0 + REPORT_RELOAD_MS
  await ui.retryReports([W])
  assert.equal(status(), REPORT_STATUS.FAILED, '第一次失敗後滿 5 分鐘仍讀不到：讀不到')
  assert.equal(tree({ rep: ui.state.reports[W], now: t }).reportTag, '讀不到帳號資料')
  assert.ok(log.some(l => l.includes('503 raw-detail')), '原始錯誤進 log')
  assert.ok(!JSON.stringify(tree({ rep: ui.state.reports[W], now: t })).includes('503'), '原始錯誤不上畫面')
  t += 60_000
  mode = 'ok'
  await ui.retryReports([W])
  assert.equal(status(), REPORT_STATUS.OK, '讀到就恢復')
  assert.equal(ui.state.reports[W].failCount, 0)
  // 在線卻一直讀到過期的回報（那台沒在回報）也算失敗：兩次之後才說讀不到
  const stale = iso(T0 - REPORT_FRESH_MS - 120_000)
  let r = nextReport(null, { value: { asn_online: true, reported_at: stale, accounts: [] } }, T0)
  assert.equal(deviceReportStatus({ rep: r, now: T0 }), REPORT_STATUS.LOADING)
  r = nextReport(r, { value: { asn_online: true, reported_at: stale, accounts: [] } }, T0 + REPORT_RELOAD_MS)
  assert.equal(deviceReportStatus({ rep: r, now: T0 + REPORT_RELOAD_MS }), REPORT_STATUS.FAILED)
})

test('#2158 同一台正在讀就不再發；頁面關閉後不再排程', async () => {
  // 同一台正在讀：兩次同時檢查只發一次
  let release
  const calls = []
  const invoke = (cmd, a) => { calls.push(a.node); return new Promise(res => { release = () => res({ asn_online: true, reported_at: iso(T0), accounts: [] }) }) }
  const ui = createAccountsUi({ invoke, reactive: Vue.reactive, sleep: async () => {}, now: () => T0 })
  const p1 = ui.retryReports([W]); const p2 = ui.retryReports([W])
  release(); await Promise.all([p1, p2])
  assert.equal(calls.length, 1)
  // 排程：假計時器
  const timers = new Map(); let nextId = 1
  let open = true, runs = 0
  const sch = createReportScheduler({ run: async () => { runs++; return 1 }, isOpen: () => open, everyMs: 60_000, setTimer: f => { timers.set(nextId, f); return nextId++ }, clearTimer: id => timers.delete(id) })
  sch.start(); await Promise.resolve()
  assert.equal(runs, 1, '開頁面就讀一輪')
  sch.start(); assert.equal(timers.size, 1, '重複 start 不會多排一個')
  await sch.tick()
  assert.equal(runs, 2)
  sch.stop()
  assert.equal(timers.size, 0, '頁面關掉：計時器清掉')
  // 保險：呼叫端漏了 stop，頁面已關，下一次計時器觸發時自己停
  sch.start({ immediate: false }); assert.equal(timers.size, 1)
  open = false
  await [...timers.values()][0]()
  assert.equal(timers.size, 0, '頁面已關：自己把計時器清掉')
  assert.equal(runs, 2, '關掉之後不再讀')
  // 接線：電腦版與手機版都是「頁面開著才 start、關掉就 stop」
  assert.match(read('ui/list.js'), /watch\(devicesOpen, open => \{ if \(open\) reportScheduler\.start\(\); else reportScheduler\.stop\(\) \}, \{ immediate: true \}\)/)
  assert.match(read('ui/m.js'), /watch\(\(\) => fourthPage\.value\?\.kind === 'acct', open => \{ if \(open\) acctReportScheduler\.start\(\{ immediate: false \}\); else acctReportScheduler\.stop\(\) \}, \{ immediate: true \}\)/)
  assert.match(read('ui/m.js'), /filter\(n => !acctReloading\.has\(n\)\)/, '手機：同一台正在讀不重發')
})

test('#2158 電腦與手機同一份判斷與文字：同樣的回報，兩邊的狀態、標籤、灰字一模一樣', () => {
  for (const rep of [null, freshRep(), staleRep(), errRep(1), errRep(2)]) for (const online of [true, false]) {
    const a = tree({ rep, online }), b = tree({ rep, online, mobile: true })
    assert.deepEqual([a.reportStatus, a.reportTag, a.reportNote], [b.reportStatus, b.reportTag, b.reportNote], JSON.stringify([rep, online]))
  }
  // 手機存的回報形狀也走同一個 nextReport
  const e = acctReportEntry(null, { error: '暫時讀不到' }, T0)
  const e1m = acctReportEntry(e, { error: '暫時讀不到' }, T0 + 60_000)
  assert.equal(e1m.failCount, 1, '手機同一個計次規則：不到 5 分鐘不加')
  const e2 = acctReportEntry(e1m, { error: '暫時讀不到' }, T0 + REPORT_RELOAD_MS)
  assert.deepEqual([e.failCount, e2.failCount, e2.msg], [1, 2, '暫時讀不到'])
  assert.equal(acctReportEntry(e2, { value: { asn_online: true, reported_at: iso(T0), accounts: [] } }, T0).failCount, 0)
  // 文字只有一份：樣板與設定頁都讀 row.reportTag／reportNote，不寫死
  for (const f of ['ui/m.html', 'ui/lib/settings-panel.mjs']) for (const s of Object.values(REPORT_TEXT)) assert.ok(!read(f).includes(s), `${f} 不寫死「${s}」`)
  assert.equal(REPORT_RELOAD_MS, 5 * 60_000)
  assert.equal(REPORT_FAIL_LIMIT, 2)
})

test('#2158 冒煙：在線、回報過期 → 自動重讀成功 → 畫面從「正在讀取」變成不多寫', async () => {
  let t = T0
  const state = { reportedAt: iso(T0 - REPORT_FRESH_MS - 5 * 60_000) }   // 那台的回報已經 20 分鐘沒更新
  const invoke = async () => ({ asn_online: true, reported_at: state.reportedAt, accounts: [{ vendor: 'claude', email: 'w@b.c', plan: 'pro', current: true }] })
  const ui = createAccountsUi({ invoke, reactive: Vue.reactive, sleep: async () => {}, now: () => t })
  await ui.retryReports([W])
  let row = tree({ rep: ui.state.reports[W], now: t })
  assert.equal(row.onlineText, '在線')
  assert.equal(row.reportNote?.text, REPORT_TEXT.loading, '在線、回報過期：正在讀取，不是「沒回報」')
  // 那台回報了，下一輪自動重讀就讀到新的
  t += REPORT_RELOAD_MS; state.reportedAt = iso(t - 20_000)
  assert.equal(await ui.retryReports([W]), 1)
  row = tree({ rep: ui.state.reports[W], now: t })
  assert.deepEqual([row.onlineText, row.reportStatus, row.reportTag, row.reportNote], ['在線', REPORT_STATUS.OK, '', null])
})
