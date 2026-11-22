// #2111 ③ #2110 帳號卡設備列「切換」：結果在那一列下方原位顯示（成功綠、失敗紅、不跳框），成功後重讀列表讓頂端與設備列一起變。
// 電腦（claude-accounts.switchRow＋settings-panel）與手機（m.js 的 acctDevPress＋m.html）共用 lib/switch-result.mjs 的流程與文字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
// 共用元件的插槽會在輸出裡留下片段標記（<!--[-->、<!--]-->），比對畫面文字前先拿掉
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { createAccountsUi } from '../ui/lib/claude-accounts.mjs'
import { accountDeviceRows, accountInUse, rosterView } from '../ui/lib/account-roster.mjs'
import { runAcctSwitch } from '../ui/lib/mobile-acct.mjs'
import { SWITCH_RESULT_TEXT, SWITCH_SYNC_MS, createSwitchTracker, switchFailReason, switchResultOf, switchRowKey } from '../ui/lib/switch-result.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const MAIL = 'z@example.test'
const NOW = Date.parse('2026-11-22T12:00:00Z')
const iso = ms => new Date(ms).toISOString()

// 假時鐘：sleep 只把時間往前撥
function clock() {
  const c = { t: 0, timers: [] }
  c.now = () => c.t
  c.sleep = async ms => { c.t += ms }
  c.setTimer = (fn, ms) => { c.timers.push({ at: c.t + ms, fn }) }
  c.advance = ms => { c.t += ms; for (const x of c.timers.filter(x => x.at <= c.t)) { c.timers.splice(c.timers.indexOf(x), 1); x.fn() } }
  return c
}
const mkTracker = (c, state = {}, logs = []) => createSwitchTracker({ state, log: (...a) => logs.push(a.join(' ')), sleep: c.sleep, now: c.now, setTimer: c.setTimer })

test('#2111 成功：先「切換中」，列表真的更新了才顯示綠色一句，約 6 秒後自己消失', async () => {
  const c = clock(), state = {}
  const key = switchRowKey('claude', MAIL, 'W')
  let reloads = 0, listUpdated = false
  const phases = []
  const tr = mkTracker(c, state)
  const p = tr.press({ key, label: '工作機', run: async () => { phases.push(state[key]?.phase); return { ok: true } }, reload: async () => { reloads++; if (reloads === 2) listUpdated = true }, synced: () => listUpdated })
  const r = await p
  assert.deepEqual(phases, ['busy'], '送出時那一列是切換中')
  assert.equal(reloads, 2, '成功後立刻重讀；第一次還沒更新就再讀，直到那一列變成使用中')
  assert.deepEqual({ phase: r.phase, text: r.text }, { phase: 'ok', text: '已切換，工作機 現在用這個帳號。' })
  assert.deepEqual(switchResultOf(state, key), { phase: 'ok', text: SWITCH_RESULT_TEXT.ok('工作機') })
  c.advance(5900); assert.ok(state[key], '6 秒內還在')
  c.advance(200); assert.equal(state[key], undefined, '約 6 秒後自己消失')
})

test('#2111 成功但列表一直沒更新：維持切換中最多 30 秒，之後用白話說「等那台回報」，不假裝已切換', async () => {
  const c = clock(), state = {}, logs = []
  const key = switchRowKey('claude', MAIL, 'W')
  const seen = []
  const tr = mkTracker(c, state, logs)
  const origSleep = c.sleep
  const tr2 = createSwitchTracker({ state, log: (...a) => logs.push(a.join(' ')), sleep: async ms => { seen.push(state[key].phase); await origSleep(ms) }, now: c.now, setTimer: c.setTimer })
  void tr
  await tr2.press({ key, label: '工作機', run: async () => ({ ok: true }), reload: async () => {}, synced: () => false })
  assert.ok(seen.length >= 5 && seen.every(p => p === 'busy'), '等待期間一直是切換中')
  assert.ok(c.t >= SWITCH_SYNC_MS && c.t < SWITCH_SYNC_MS + 10000, '最多等約 30 秒')
  assert.equal(state[key].phase, 'waiting')
  assert.equal(state[key].text, SWITCH_RESULT_TEXT.waiting)
  assert.ok(!/已切換/.test(state[key].text))
  assert.ok(logs.some(l => l.includes('等不到更新')), '原因進 log')
})

test('#2111 失敗：紅色一句、含白話原因、原文進 log、鈕回到可再按；再按一次才會洗掉', async () => {
  const c = clock(), state = {}, logs = []
  const key = switchRowKey('claude', MAIL, 'W')
  const tr = mkTracker(c, state, logs)
  await tr.press({ key, label: '工作機', run: async () => ({ ok: false, fail: { error: 'acct_switch HTTP 409 asn_offline' } }) })
  assert.deepEqual(state[key] && { phase: state[key].phase, text: state[key].text }, { phase: 'fail', text: '沒有切換成功：那台的 ASN 尚未開啟。' })
  assert.ok(logs.some(l => l.includes('HTTP 409 asn_offline')), '原文進 log')
  assert.ok(!/HTTP|409|asn_offline/.test(state[key].text), '畫面上沒有代碼')
  c.advance(60_000); assert.equal(state[key].phase, 'fail', '失敗留著到再按一次')
  await tr.press({ key, label: '工作機', run: async () => ({ ok: true }), synced: () => true })
  assert.equal(state[key].phase, 'ok', '再按一次，新結果取代舊的')
  // 例外也算失敗，不會卡在切換中
  const k2 = switchRowKey('claude', MAIL, 'V')
  await tr.press({ key: k2, label: '備用機', run: async () => { throw new Error('網路不通') } })
  assert.equal(state[k2].phase, 'fail'); assert.match(state[k2].text, /網路不通/)
})

test('#2111 失敗原因逐種白話：不放代碼、狀態碼、英文原文', () => {
  const cases = [
    [{ error: 'acct_switch HTTP 409 asn_offline' }, '那台的 ASN 尚未開啟。'],
    [{ error: 'acct_switch HTTP 403 forbidden' }, '這個帳號沒有權限替那台切換，請確認兩邊登入的是同一個人。'],
    [{ error: 'acct_switch HTTP 404' }, '後台還沒支援切換帳號，請等後台更新後再試。'],
    [{ error: 'acct_switch HTTP 429 rate_limited' }, '這個小時切換太多次了，請稍後再試。'],
    [{ error: 'acct_switch HTTP 500 weird' }, '後台暫時回不來，請稍後再試。'],
    [{ error: 'connection reset by peer' }, '切換沒有完成，請稍後再試。'],
    [{ error: '這個帳號存的登入不完整，請重新登入一次再加入' }, '這個帳號存的登入不完整，請重新登入一次再加入。'],
    [{ status: 'denied' }, '那台的使用者沒有同意。'],
    [{ status: 'failed', detail: 'login file locked' }, '那台沒有完成切換，請稍後再試。'],
    [{ status: 'failed', detail: '那台還沒加入帳號庫' }, '那台沒有完成切換：那台還沒加入帳號庫。'],
    [{ code: 'timeout' }, '那台沒有回應，請稍後再試。'],
    [{ code: 'missing' }, '查不到這次切換的結果，請稍後再試。'],
    [undefined, '切換沒有完成，請稍後再試。'],
  ]
  for (const [f, want] of cases) assert.equal(switchFailReason(f), want, JSON.stringify(f))
})

test('#2111 同一列正在切換時再按不理它；結果只記在被按的那一列', async () => {
  const c = clock(), state = {}
  const kW = switchRowKey('claude', MAIL, 'W'), kV = switchRowKey('claude', MAIL, 'V')
  const tr = mkTracker(c, state)
  let release
  const slow = new Promise(r => { release = r })
  let runs = 0
  const first = tr.press({ key: kW, label: '工作機', run: async () => { runs++; await slow; return { ok: false, fail: { code: 'timeout' } } } })
  await tr.press({ key: kW, label: '工作機', run: async () => { runs++; return { ok: true } } })
  assert.equal(runs, 1, '切換中再按不會送第二次')
  assert.equal(state[kW].phase, 'busy'); assert.equal(state[kV], undefined, '別台不受影響')
  release(); await first
  assert.equal(state[kW].phase, 'fail'); assert.equal(state[kV], undefined, '結果只在被按的那一列')
})

// ---- 電腦：claude-accounts.switchRow 走既有的 acct_remote_request／acct_remote_status ----
function mkAccounts(handlers, extra = {}) {
  const calls = [], logs = []
  const invoke = async (cmd, args) => { calls.push([cmd, args]); const h = handlers[cmd]; if (h instanceof Error) throw h; return typeof h === 'function' ? h(args, calls) : h }
  const c = clock()
  // 本機切換走 tauri.mjs 的 transport.accountSwitch（#2106）；這裡照它的指令對應轉給假 invoke，handlers 照舊用指令名
  const transport = { accountSwitch: (vendor, email) => invoke(vendor === 'grok' ? 'grok_account_switch' : 'claude_account_switch', { email }) }
  const ui = createAccountsUi({ invoke, transport, reactive: o => o, sleep: c.sleep, now: c.now, pollMs: 3000, log: (...a) => logs.push(a.join(' ')), ...extra })
  return { ui, calls, logs, c }
}
const names = calls => calls.map(x => x[0])

test('#2110 電腦：遠端切換成功 → 該列切換中 → 重讀（帳號回報與帳號列表）→ 列表更新後顯示綠句；沿用既有的 request／status', async () => {
  let applied = false
  const { ui, calls } = mkAccounts({
    acct_remote_request: { id: 'i1' },
    acct_remote_status: { switches: [{ id: 'i1', status: 'ok' }] },
    acct_remote_list: () => ({ asn_online: true, reported_at: iso(NOW), accounts: [] }),
    acct_roster: () => { applied = true; return { accounts: [] } },
  })
  const key = switchRowKey('claude', MAIL, 'W')
  const seen = []
  const p = ui.switchRow({ vendor: 'claude', email: MAIL, node: 'W', label: '工作機', self: false, synced: () => { seen.push(ui.state.rowSwitch[key].phase); return applied } })
  await p
  assert.deepEqual(names(calls).slice(0, 2), ['acct_remote_request', 'acct_remote_status'], '沿用既有的遠端切換指令')
  assert.deepEqual(calls[0][1], { node: 'W', email: MAIL, vendor: 'claude' })
  assert.ok(names(calls).includes('acct_remote_list') && names(calls).includes('acct_roster'), '成功後立刻重讀那台的回報與帳號列表')
  assert.deepEqual(seen, ['busy'], '重讀期間那一列還是切換中')
  assert.equal(ui.state.rowSwitch[key].text, '已切換，工作機 現在用這個帳號。')
  assert.equal(ui.state.remote.busy, false); assert.equal(ui.state.remote.msg, '', '不碰對話框用的那份狀態（兩處互不干擾）')
})

test('#2110 電腦：遠端切換失敗（ASN 沒開）→ 紅句含白話原因、原文進 log、沒有重讀', async () => {
  const { ui, calls, logs } = mkAccounts({ acct_remote_request: new Error('acct_remote_request HTTP 409 asn_offline') })
  await ui.switchRow({ vendor: 'claude', email: MAIL, node: 'W', label: '工作機', self: false, synced: () => true })
  const r = ui.state.rowSwitch[switchRowKey('claude', MAIL, 'W')]
  assert.equal(r.phase, 'fail'); assert.equal(r.text, '沒有切換成功：那台的 ASN 尚未開啟。')
  assert.ok(logs.some(l => l.includes('asn_offline')))
  assert.ok(!names(calls).includes('acct_roster'), '失敗不重讀')
})

test('#2110 電腦：對方不同意／逾時／查不到結果，各自說白話', async () => {
  for (const [st, want] of [[{ id: 'i1', status: 'denied' }, '那台的使用者沒有同意。'], [{ id: 'i1', status: 'failed', detail: '那台還沒加入帳號庫' }, '那台沒有完成切換：那台還沒加入帳號庫。']]) {
    const { ui } = mkAccounts({ acct_remote_request: { id: 'i1' }, acct_remote_status: { switches: [st] } })
    await ui.switchRow({ vendor: 'claude', email: MAIL, node: 'W', label: '工作機', synced: () => true })
    assert.equal(ui.state.rowSwitch[switchRowKey('claude', MAIL, 'W')].text, `沒有切換成功：${want}`)
  }
  const none = mkAccounts({ acct_remote_request: { id: 'i1' }, acct_remote_status: { switches: [] } })
  await none.ui.switchRow({ vendor: 'claude', email: MAIL, node: 'W', label: '工作機', synced: () => true })
  assert.match(none.ui.state.rowSwitch[switchRowKey('claude', MAIL, 'W')].text, /查不到這次切換的結果/)
  const slow = mkAccounts({ acct_remote_request: { id: 'i1' }, acct_remote_status: { switches: [{ id: 'i1', status: 'taken' }] } }, { pollMax: 3 })
  await slow.ui.switchRow({ vendor: 'claude', email: MAIL, node: 'W', label: '工作機', synced: () => true })
  assert.match(slow.ui.state.rowSwitch[switchRowKey('claude', MAIL, 'W')].text, /那台沒有回應/)
})

test('#2110 電腦：本機切換直接換、不經對話框；失敗講白話；成功後重讀本機帳號與列表', async () => {
  let switched = false
  const ok = mkAccounts({
    claude_account_switch: () => { switched = true; return { email: MAIL } },
    claude_accounts_list: () => [{ email: MAIL, current: switched }], claude_account_current: () => ({ email: MAIL }), grok_accounts_list: [], codex_account_current: null, claude_mod_report: null, claude_login_failed: false, claude_quota_state: null,
    acct_roster: { accounts: [] }, acct_remote_report: {},
  })
  await ok.ui.switchRow({ vendor: 'claude', email: MAIL, node: 'H', label: '家用機', self: true, synced: () => ok.ui.state.list.some(a => a.email === MAIL && a.current) })
  assert.equal(ok.ui.state.rowSwitch[switchRowKey('claude', MAIL, 'H')].text, '已切換，家用機 現在用這個帳號。')
  assert.ok(!names(ok.calls).includes('acct_remote_request'), '本機不走遠端')
  assert.equal(ok.ui.state.busy, false)
  const bad = mkAccounts({ claude_account_switch: new Error('找不到這個帳號的登入檔') })
  await bad.ui.switchRow({ vendor: 'claude', email: MAIL, node: 'H', label: '家用機', self: true, synced: () => true })
  assert.equal(bad.ui.state.rowSwitch[switchRowKey('claude', MAIL, 'H')].text, '沒有切換成功：找不到這個帳號的登入檔。')
})

// ---- 同步：成功後重讀，頂端「使用中」與設備列一致 ----
test('#2110 切換後畫面同步：重讀前頂端沒有使用中、重讀後頂端與設備列一起變；不重讀就等不到（測試會逾時）', async () => {
  const state = { used: false }
  const roster = () => ({ now: iso(NOW), accounts: [{ vendor: 'claude', account: MAIL, plan: 'pro', windows: [], seen_at: iso(NOW), seen_node: 'W', nodes: [{ node: 'W', current: state.used, reported_at: iso(NOW) }] }] })
  const devices = [{ key: 'W', label: '工作機', self: false, hidden: false, removed: false, kind: '電腦', vendors: [{ key: 'claude', switchable: true, switchHint: '', accounts: [{ email: MAIL, current: false }, { email: 'o@example.test', current: !state.used }] }] }]
  const view = () => { const my = rosterView(roster(), { nodeLabel: () => '工作機', now: NOW }); const a = my.vendors[0].accounts[0]; const rows = accountDeviceRows(devices, 'claude', MAIL, a.usedOn); return { top: accountInUse(rows, a.current), rows } }
  assert.equal(view().top, false); assert.equal(view().rows[0].state, 'switch')
  const c = clock(), st = {}
  const tr = mkTracker(c, st)
  let loaded = false
  await tr.press({ key: 'k', label: '工作機', run: async () => ({ ok: true }), reload: async () => { loaded = true; state.used = true }, synced: () => view().rows[0].current })
  assert.ok(loaded)
  assert.equal(st.k.phase, 'ok')
  assert.equal(view().top, true, '卡片頂端變成使用中'); assert.equal(view().rows[0].state, 'current', '設備列也是使用中')
  // 反例：不重讀 → 一直等不到 → 不會顯示「已切換」
  const c2 = clock(), st2 = {}
  state.used = false
  await mkTracker(c2, st2).press({ key: 'k', label: '工作機', run: async () => ({ ok: true }), reload: async () => {}, synced: () => view().rows[0].current })
  assert.equal(st2.k.phase, 'waiting', '沒重讀＝頂端與設備列都沒變，不能說已切換')
})

// ---- 畫面：電腦原位顯示 ----
async function renderPanel(rowSwitch, devices) {
  globalThis.Vue = Vue
  const roster = { now: iso(NOW), accounts: [{ vendor: 'claude', account: MAIL, plan: 'pro', windows: [], seen_at: iso(NOW), seen_node: 'W', nodes: [{ node: 'W', current: false, reported_at: iso(NOW) }, { node: 'V', current: false, reported_at: iso(NOW) }] }] }
  const my = rosterView(roster, { nodeLabel: n => ({ W: '工作機', V: '備用機' }[n] ?? ''), now: NOW })
  const st = { devices, accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true, rowSwitch }, myAccounts: my }
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'accounts', meAv: '' }) }))
}
const twoDevs = () => ['W', 'V'].map(k => ({ key: k, label: k === 'W' ? '工作機' : '備用機', self: false, hidden: false, removed: false, kind: '電腦', vendors: [{ key: 'claude', switchable: true, switchHint: '', accounts: [{ email: MAIL, current: false }, { email: 'o@example.test', current: true }] }] }))

test('#2111 電腦畫面：結果句出現在被按的那一列正下方，別列沒有；成功綠、失敗紅、不是對話框', async () => {
  const kW = switchRowKey('claude', MAIL, 'W')
  const ok = await renderPanel({ [kW]: { phase: 'ok', text: '已切換，工作機 現在用這個帳號。', seq: 1 } }, twoDevs())
  const iW = ok.indexOf('dv-devn">工作機'), iRes = ok.indexOf('dv-devres ok'), iV = ok.indexOf('dv-devn">備用機')
  assert.ok(iW > -1 && iRes > iW && iRes < iV, '句子在工作機那列之後、備用機那列之前')
  assert.equal((ok.match(/dv-devres/g) ?? []).length, 1, '只有被按的那一列有')
  assert.match(ok, /<span class="dv-devres ok" role="status">已切換，工作機 現在用這個帳號。<\/span>/)
  assert.ok(!/<dialog|role="dialog"|role="alertdialog"/.test(ok.slice(ok.indexOf('dv-acctpage'))), '不跳框')
  const fail = await renderPanel({ [kW]: { phase: 'fail', text: '沒有切換成功：那台的 ASN 尚未開啟。', seq: 1 } }, twoDevs())
  assert.match(fail, /<span class="dv-devres fail" role="status">沒有切換成功：那台的 ASN 尚未開啟。<\/span>/)
  assert.match(fail, />切換<\/button>/, '失敗後鈕是「切換」，可以再按')
  const busy = await renderPanel({ [kW]: { phase: 'busy', text: '', seq: 1 } }, twoDevs())
  assert.match(busy, /class="asn-btn lv-secondary st-busy fixed dv-devbtn"[^>]*disabled[^>]*>切換中…</, '切換中那列的鈕寫「切換中…」')
  assert.equal((busy.match(/st-busy fixed dv-devbtn/g) ?? []).length, 1, '只有被按的那一列')
  assert.ok(!busy.includes('dv-devres'), '切換中不寫句子（鈕上已經寫了）')
})

test('#2111 電腦：按鈕送 row-switch（不再開對話框）；樞紐接得住、帶本機判斷與列表同步判斷', () => {
  const panel = read('ui/lib/settings-panel.mjs'), hub = read('ui/list.js')
  assert.match(panel, /act\('row-switch', \{ vendor, email: a\.account, node: b\.node, label: b\.label, self: b\.self \}\)/)
  assert.ok(!panel.includes('pendingDev'), '舊的 5 秒假「切換中」拿掉了，改用真的結果狀態')
  assert.ok(hub.includes("case 'row-switch'") && hub.includes('accounts.switchRow('))
  assert.match(hub, /rowSwitch: \{ \.\.\.accounts\.state\.rowSwitch \}/, '結果狀態進設定頁快照（分離視窗也看得到）')
})

// ---- 手機：同一份流程與文字 ----
test('#2111 手機：用同一個 tracker 與 runAcctSwitch；成功／失敗句子與電腦一字不差', async () => {
  const mobile = async (transport) => {
    const c = clock(), state = {}
    const tr = mkTracker(c, state)
    let current = false
    await tr.press({
      key: switchRowKey('claude', MAIL, 'W'), label: '工作機',
      run: async () => { const v = await runAcctSwitch(transport, 'W', MAIL, { sleep: async () => {} }); return v.phase === 'done' ? { ok: true } : { ok: false, fail: v.fail } },
      reload: async () => { current = true }, synced: () => current,
    })
    return state[switchRowKey('claude', MAIL, 'W')]
  }
  const okT = { acctSwitch: async () => ({ id: 'i1' }), acctStatus: async () => ({ switches: [{ id: 'i1', status: 'ok' }] }) }
  assert.equal((await mobile(okT)).text, '已切換，工作機 現在用這個帳號。')
  const offT = { acctSwitch: async () => { throw new Error('android_acct_switch HTTP 409 asn_offline') }, acctStatus: async () => ({}) }
  const off = await mobile(offT)
  assert.deepEqual({ phase: off.phase, text: off.text }, { phase: 'fail', text: '沒有切換成功：那台的 ASN 尚未開啟。' })
  const deny = await mobile({ acctSwitch: async () => ({ id: 'i1' }), acctStatus: async () => ({ switches: [{ id: 'i1', status: 'denied' }] }) })
  assert.equal(deny.text, '沒有切換成功：那台的使用者沒有同意。')
  // 電腦走同一組代碼，句子相同
  const desk = mkAccounts({ acct_remote_request: new Error('acct_remote_request HTTP 409 asn_offline') })
  await desk.ui.switchRow({ vendor: 'claude', email: MAIL, node: 'W', label: '工作機', synced: () => true })
  assert.equal(desk.ui.state.rowSwitch[switchRowKey('claude', MAIL, 'W')].text, off.text, '電腦與手機同一句')
})

test('#2111 手機接線與樣板：結果句在被按那列之後、用共用流程、重讀列表；文字只放一份', () => {
  const js = read('ui/m.js'), html = read('ui/m.html'), css = read('ui/mobile.css'), desk = read('ui/style.css')
  assert.ok(js.includes("from './lib/switch-result.mjs'") && js.includes('createSwitchTracker({ state: acctRowSwitch'))
  assert.match(js, /reload: async \(\) => \{ await loadRoster\(\); await loadAcct\(b\.node, true\) \}/, '成功後重讀帳號列表與那台的回報')
  assert.ok(js.includes('switchBusyNode(acctRowSwitch'), '切換中的列由共用狀態決定')
  assert.match(html, /<span class="m-dv-devrow">[\s\S]*?<\/span><span :class="\['m-dv-devres', acctRowResult\(v\.key, a, b\.node\)\.phase\]" role="status" v-if="acctRowResult\(v\.key, a, b\.node\)">\{\{ acctRowResult\(v\.key, a, b\.node\)\.text \}\}<\/span><\/template>/, '結果句接在那一列之後')
  assert.ok(css.includes('.m-dv-devres.ok') && css.includes('.m-dv-devres.fail') && desk.includes('.dv-devres.ok') && desk.includes('.dv-devres.fail'))
  for (const f of ['ui/m.html', 'ui/m.js', 'ui/lib/settings-panel.mjs', 'ui/list.js']) {
    const t = read(f)
    assert.ok(!t.includes('現在用這個帳號') && !t.includes('沒有切換成功'), `${f} 不自己寫結果句子，只引用 switch-result.mjs`)
  }
})
