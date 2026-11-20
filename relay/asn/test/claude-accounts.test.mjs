// 設定頁「帳號」：前端只呼叫 Rust 指令、只顯示 email／方案，權杖不經過前端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { OTHER_VENDORS, SWITCH_NOTICE, accountLine, codexLine, createAccountsUi, isFinalStatus, remoteStatusText } from '../ui/lib/claude-accounts.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const reactive = o => o

function fake(handlers) {
  const calls = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    const h = handlers[cmd]
    if (h instanceof Error) throw h
    return typeof h === 'function' ? h(args) : h
  }
  return { calls, invoke }
}
const mk = (handlers, extra = {}) => { const f = fake(handlers); return { f, ui: createAccountsUi({ invoke: f.invoke, reactive, sleep: async () => {}, ...extra }) } }

test('整理一行顯示：email 與方案，缺的就略過', () => {
  assert.equal(accountLine({ email: 'a@x.test', plan: 'max' }), 'a@x.test · max')
  assert.equal(accountLine({ email: 'a@x.test', plan: '' }), 'a@x.test')
  assert.equal(accountLine({ email: '', plan: '' }), '')
})

test('加入目前登入的帳號：不用取名字，呼叫沒有參數；成功後重抓清單並回報給收發室', async () => {
  const { f, ui } = mk({ claude_accounts_list: [{ email: 'a@x.test', plan: 'max', current: true }], claude_account_current: { email: 'a@x.test', saved: true }, codex_account_current: null, claude_account_save: { email: 'a@x.test' }, acct_remote_report: {} })
  await ui.addCurrent()
  assert.deepEqual(f.calls[0], ['claude_account_save', undefined])
  assert.deepEqual(f.calls.map(c => c[0]).slice(0, 4), ['claude_account_save', 'claude_accounts_list', 'claude_account_current', 'grok_accounts_list'])
  assert.match(ui.state.msg, /已加入 a@x\.test/)
  assert.equal(ui.state.list.length, 1)
  assert.ok(f.calls.some(c => c[0] === 'acct_remote_report'))
})

test('切換成功要說不用重開 Claude 視窗，指令只帶 email；失敗顯示 Rust 回的中文原因', async () => {
  const { f, ui } = mk({ claude_accounts_list: [], claude_account_current: null, codex_account_current: null, claude_account_switch: a => ({ email: a.email }), acct_remote_report: {} })
  await ui.switchTo('b@x.test')
  assert.deepEqual(f.calls[0], ['claude_account_switch', { email: 'b@x.test' }])
  assert.ok(ui.state.msg.includes(SWITCH_NOTICE) && SWITCH_NOTICE.includes('不用重開'))
  const ui2 = mk({ claude_account_switch: new Error('目前登入的帳號還沒加入帳號庫'), claude_accounts_list: [], claude_account_current: null, codex_account_current: null }).ui
  await ui2.switchTo('b@x.test')
  assert.match(ui2.state.msg, /還沒加入帳號庫/)
  assert.equal(ui2.state.busy, false)
})

test('刪除要按兩次才真的刪', async () => {
  const { f, ui } = mk({ claude_accounts_list: [], claude_account_current: null, codex_account_current: null, claude_account_delete: null, acct_remote_report: {} })
  await ui.remove('a@x.test')
  assert.equal(f.calls.length, 0)
  assert.equal(ui.state.confirmDel, 'a@x.test')
  await ui.remove('a@x.test')
  assert.deepEqual(f.calls[0], ['claude_account_delete', { email: 'a@x.test' }])
  assert.equal(ui.state.confirmDel, '')
})

test('Codex：只顯示目前登入的 email；API 金鑰登入、沒登入、讀取失敗各有一行說明', () => {
  assert.equal(codexLine({ email: 'me@x.test', plan: 'plus', mode: 'chatgpt' }), 'me@x.test · plus')
  assert.match(codexLine({ email: '', mode: 'api_key' }), /API 金鑰/)
  assert.match(codexLine(null), /沒有登入/)
  assert.equal(codexLine(null, 'Codex 登入檔格式不對'), 'Codex 登入檔格式不對')
})

test('其他廠商先留位置', () => {
  assert.deepEqual(OTHER_VENDORS.map(v => v.key), ['gemini', 'other'])
})

test('遠端：選設備→列出對方回報的 email→選了送出→輪詢到結果', async () => {
  const seq = ['pending', 'taken', 'ok']
  const { f, ui } = mk({
    acct_remote_list: { accounts: [{ vendor: 'claude', email: 'w@x.test', plan: 'pro', current: false }, { vendor: 'codex', email: 'no@x.test' }], asn_online: true, reported_at: '2026-10-21T08:00:00Z' },
    acct_remote_request: { id: 'ID1' },
    acct_remote_status: () => ({ switches: [{ id: 'ID1', status: seq.shift() }] }),
  })
  await ui.remoteSelect('W')
  assert.deepEqual(f.calls[0], ['acct_remote_list', { node: 'W' }])
  assert.deepEqual(ui.state.remote.list.map(a => a.email), ['w@x.test'], '只列 Claude 帳號')
  await ui.remoteSwitch('w@x.test')
  assert.deepEqual(f.calls[1], ['acct_remote_request', { node: 'W', email: 'w@x.test', vendor: 'claude' }], '指令只帶設備與 email')
  assert.match(ui.state.remote.msg, /對方已切換到 w@x\.test/)
  assert.equal(ui.state.remote.busy, false)
})

test('遠端：對方沒同意、失敗、離線的訊息', async () => {
  for (const [st, re] of [[{ status: 'denied' }, /沒有同意/], [{ status: 'failed', detail: '找不到這個帳號' }, /切換失敗：找不到這個帳號/]]) {
    const { ui } = mk({ acct_remote_list: { accounts: [{ vendor: 'claude', email: 'w@x.test' }], asn_online: true }, acct_remote_request: { id: 'ID1' }, acct_remote_status: { switches: [{ id: 'ID1', ...st }] } })
    await ui.remoteSelect('W'); await ui.remoteSwitch('w@x.test')
    assert.match(ui.state.remote.msg, re)
  }
  const off = mk({ acct_remote_list: { accounts: [], asn_online: false } }).ui
  await off.remoteSelect('W')
  assert.match(off.state.remote.msg, /沒有在線/)
  const err = mk({ acct_remote_request: new Error('acct_switch HTTP 403 forbidden'), acct_remote_list: { accounts: [{ vendor: 'claude', email: 'w@x.test' }], asn_online: true } }).ui
  await err.remoteSelect('W'); await err.remoteSwitch('w@x.test')
  assert.match(err.state.remote.msg, /403/)
  assert.equal(remoteStatusText({ status: 'zzz' }), '')
  assert.ok(isFinalStatus('ok') && isFinalStatus('denied') && !isFinalStatus('taken'))
})

test('收到別台的切換要求：預設跳確認（按同意才切、拒絕會回報）；信任自己的設備才直接切', async () => {
  const base = { claude_accounts_list: [], claude_account_current: null, codex_account_current: null, acct_remote_report: {} }
  const row = { id: 'ID2', email: 'b@x.test', requested_by: 'H', needs_confirm: true }
  let { f, ui } = mk({ ...base, acct_remote_pending: [row], acct_remote_apply: {} }, { nodeLabel: n => (n === 'H' ? '家用機' : n) })
  assert.equal(await ui.pollIncoming(), 1)
  assert.deepEqual(ui.state.incoming, [{ id: 'ID2', email: 'b@x.test', from: 'H', fromLabel: '家用機', vendor: 'claude' }])
  assert.ok(!f.calls.some(c => c[0] === 'acct_remote_apply'), '還沒按同意，不切')
  await ui.approve('ID2')
  assert.deepEqual(f.calls.find(c => c[0] === 'acct_remote_apply'), ['acct_remote_apply', { id: 'ID2', confirmed: true }])
  assert.deepEqual(ui.state.incoming, [])
  assert.match(ui.state.msg, /家用機 的要求切換到 b@x\.test/)

  ;({ f, ui } = mk({ ...base, acct_remote_pending: [row], acct_remote_decline: null }))
  await ui.pollIncoming(); await ui.decline('ID2')
  assert.deepEqual(f.calls.find(c => c[0] === 'acct_remote_decline'), ['acct_remote_decline', { id: 'ID2' }])
  assert.ok(!f.calls.some(c => c[0] === 'acct_remote_apply'))

  ;({ f, ui } = mk({ ...base, acct_remote_pending: [{ ...row, needs_confirm: false }], acct_remote_apply: {} }))
  await ui.pollIncoming()
  assert.deepEqual(ui.state.incoming, [], '信任自己的設備：不跳確認')
  assert.deepEqual(f.calls.find(c => c[0] === 'acct_remote_apply'), ['acct_remote_apply', { id: 'ID2', confirmed: false }], '不確認，由 Rust 端依設定放行')

  ;({ f, ui } = mk({ acct_remote_pending: new Error('後台沒部署') }))
  assert.equal(await ui.pollIncoming(), 0, '取不到待辦就當沒有，不吵使用者')
})

test('免確認切好之後：留一筆讓使用者看一眼，可按還原（呼叫本機還原）；切換失敗不留', async () => {
  const base = { claude_accounts_list: [], claude_account_current: null, codex_account_current: null, acct_remote_report: {} }
  const row = { id: 'ID3', email: 'b@x.test', requested_by: 'P', needs_confirm: false }
  let { f, ui } = mk({ ...base, acct_remote_pending: [row], acct_remote_apply: {}, claude_account_undo: '已還原到切換前的帳號。' }, { nodeLabel: n => (n === 'P' ? '手機' : n) })
  await ui.pollIncoming()
  assert.deepEqual(ui.state.done, [{ id: 'ID3', email: 'b@x.test', from: 'P', fromLabel: '手機', vendor: 'claude' }])
  assert.deepEqual(ui.state.incoming, [])
  await ui.undo('ID3')
  assert.ok(f.calls.some(c => c[0] === 'claude_account_undo'), '按還原才呼叫本機還原')
  assert.deepEqual(ui.state.done, [])
  assert.equal(ui.state.msg, '已還原到切換前的帳號。')

  ;({ f, ui } = mk({ ...base, acct_remote_pending: [row], acct_remote_apply: {} }))
  await ui.pollIncoming()
  ui.dismissDone('ID3')
  assert.deepEqual(ui.state.done, [])
  assert.ok(!f.calls.some(c => c[0] === 'claude_account_undo'), '按「知道了」不還原')

  ;({ f, ui } = mk({ ...base, acct_remote_pending: [row], acct_remote_apply: new Error('找不到這個指令') }))
  await ui.pollIncoming()
  assert.deepEqual(ui.state.done, [], '沒切成功就不顯示「已切換」')
  assert.match(ui.state.msg, /找不到/)
})

test('接線守門：設定頁有這一塊、Rust 指令有註冊、前端不碰權杖', () => {
  const panel = read('ui/lib/settings-panel.mjs'), js = read('ui/list.js'), lib = read('ui/lib/claude-accounts.mjs'), rs = read('src-tauri/src/lib.rs')
  assert.match(panel, /dv-set/)   // 帳號管理併進「設備與帳號」頁（這台的頁籤）
  assert.match(js, /createAccountsUi/)
  for (const c of ['claude_accounts_list', 'claude_account_current', 'claude_account_save', 'claude_account_switch', 'claude_account_delete']) {
    assert.ok(rs.includes(`claude_accounts::${c}`), c)
    assert.ok(lib.includes(c), c)
  }
  assert.ok(rs.includes('codex_accounts::codex_account_current') && lib.includes('codex_account_current'))
  for (const c of ['acct_remote_report', 'acct_remote_list', 'acct_remote_request', 'acct_remote_status', 'acct_remote_pending', 'acct_remote_apply', 'acct_remote_decline', 'acct_remote_allow_get', 'acct_remote_allow_set', 'claude_account_undo']) {
    assert.ok(rs.includes(c), `lib.rs 沒註冊 ${c}`)
    assert.ok(lib.includes(c), `前端沒用到 ${c}`)
  }
  assert.doesNotMatch(lib, /accessToken|refreshToken|credentials|\bfetch\(|localStorage/)
  const acctPart = panel.slice(panel.indexOf('dv-set'), panel.indexOf("catKey === 'look'"))
  assert.doesNotMatch(acctPart, /token|credential/i)
  assert.ok(!/acct-save|acctName|存成帳號|取個名字/.test(panel + js + lib), '不再有取名字的流程')
})

test('自動加入：Rust 背景工作通知後顯示一行小字、清單即時更新；只回存權杖時不吵', async () => {
  const { f, ui } = mk({ claude_accounts_list: [{ email: 'a@x.test', plan: 'max', current: true }], claude_account_current: { email: 'a@x.test', saved: true }, codex_account_current: null, acct_remote_report: {} })
  await ui.onAuto({ kind: 'updated', email: 'a@x.test' })
  assert.equal(ui.state.autoNote, '', '回存最新權杖不顯示字')
  await ui.onAuto({ kind: 'added', email: 'a@x.test' })
  assert.equal(ui.state.autoNote, '已自動加入 a@x.test')
  assert.equal(ui.state.list.length, 1, '清單已重抓')
  assert.ok(f.calls.some(c => c[0] === 'acct_remote_report'))
})

test('登入檔被其他程式換過：顯示實際帳號一行小字並回報', async () => {
  const { f, ui } = mk({ claude_accounts_list: [{ email: 'b@x.test', plan: 'max', current: true }], claude_account_current: { email: 'b@x.test', saved: true }, codex_account_current: null, acct_remote_report: {} })
  await ui.onAuto({ kind: 'external', email: 'b@x.test' })
  assert.equal(ui.state.autoNote, '登入檔被其他程式換過，現在是 b@x.test')
  assert.ok(f.calls.some(c => c[0] === 'acct_remote_report'))
})

test('自動加入接線守門：開關預設開、存進 asn-me.json、設定頁有開關、Rust 背景工作已啟動', () => {
  const panel = read('ui/lib/settings-panel.mjs'), js = read('ui/list.js'), rs = read('src-tauri/src/lib.rs')
  assert.match(js, /autoAddClaude = ref\(true\)/, '固定開啟，不看舊存檔')
  assert.match(js, /meStore\.save\(\{[^]*?autoAddClaude: autoAddClaude\.value/, '開關要寫進 asn-me.json')
  assert.ok(!js.includes("case 'acct-auto'"), '設定頁沒有開關了')
  assert.match(js, /listen\('claude-account-auto'/)
  assert.ok(!panel.includes("act('acct-auto'") && !panel.includes('<span>自動加入</span>'), '設定頁沒有自動加入勾選')
  assert.ok(rs.includes('claude_accounts::auto_loop') && rs.includes('"claude-account-auto"'))
})

test('Grok：帳號庫清單進狀態；切換呼叫本機指令並重抓；遠端指令帶廠商；Grok 的免確認通知不提供還原（還原只對 Claude）', async () => {
  const { f, ui } = mk({ claude_accounts_list: [], claude_account_current: null, codex_account_current: null, grok_accounts_list: [{ email: 'g1@x.test', current: true, saved: true }, { email: 'g2@x.test', current: false, saved: true }], grok_account_switch: { email: 'g2@x.test', notice: '已切換。開著的 Grok 視窗還在用舊帳號，請重開才會生效' }, acct_remote_report: {} })
  await ui.refresh()
  assert.deepEqual(ui.state.grok.map(g => g.email), ['g1@x.test', 'g2@x.test'])
  await ui.grokSwitch('g2@x.test')
  assert.deepEqual(f.calls.find(c => c[0] === 'grok_account_switch'), ['grok_account_switch', { email: 'g2@x.test' }])
  assert.match(ui.state.msg, /重開/)
  // 舊版 Rust 沒有 Grok 指令：當沒有，不影響其他
  const old = mk({ claude_accounts_list: [], claude_account_current: null, codex_account_current: null })
  await old.ui.refresh()
  assert.deepEqual(old.ui.state.grok, [])
  // 遠端：選 Grok 就只列 Grok 帳號、送出時帶 vendor
  const r = mk({ acct_remote_list: { accounts: [{ vendor: 'claude', email: 'c@x.test' }, { vendor: 'grok', email: 'g@x.test' }], asn_online: true }, acct_remote_request: { id: 'ID9' }, acct_remote_status: { switches: [{ id: 'ID9', status: 'ok' }] } })
  await r.ui.remoteSelect('W', 'grok')
  assert.deepEqual(r.ui.state.remote.list.map(a => a.email), ['g@x.test'])
  await r.ui.remoteSwitch('g@x.test')
  assert.deepEqual(r.f.calls.find(c => c[0] === 'acct_remote_request'), ['acct_remote_request', { node: 'W', email: 'g@x.test', vendor: 'grok' }])
})

test('手機要求切換後的彈窗：Claude 不說要重開、不提已併掉的舊選項，指到現在的「允許切換帳號」（Grok 照舊要重開）', async () => {
  const fs = await import('node:fs')
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const block = html.slice(html.indexOf('accounts.state.incoming.length'), html.indexOf('av-menu launch-picker'))
  assert.ok(block.includes('不用再到這台確認') === false, '舊選項已整合進「允許切換帳號」')
  assert.ok(block.includes('「允許切換帳號」'))
  assert.ok(!/Claude 視窗要關掉重開/.test(block), 'Claude 切換不用重開')
  assert.ok(/Grok 視窗要關掉重開/.test(block), 'Grok 還是要重開')
})

test('#1883 只重讀額度查詢狀態：不重抓帳號清單；讀不到（舊版沒有這個指令）維持原樣；形狀不對當作還沒讀到', async () => {
  let state = { email: 'a@x.test', status: 'ok', read_at: '2026-11-20T10:00:00Z', windows: [{ name: 'five_hour', left_pct: 80, resets_at: null, read_at: '2026-11-20T10:00:00Z' }] }
  const { f, ui } = mk({ claude_accounts_list: [{ email: 'a@x.test', plan: 'max', current: true }], claude_account_current: null, codex_account_current: null, claude_quota_state: () => { if (state instanceof Error) throw state; return state } })
  await ui.refresh()
  assert.equal(ui.state.quotaState.status, 'ok')
  assert.deepEqual(ui.state.quotaState.windows.map(w => w.left_pct), [80])
  state = { email: 'a@x.test', status: 'login_expired', read_at: null, windows: [] }
  f.calls.length = 0
  await ui.refreshQuota()
  assert.deepEqual(f.calls.map(c => c[0]), ['claude_quota_state'], '只讀額度狀態')
  assert.equal(ui.state.quotaState.status, 'login_expired')
  assert.equal(ui.state.list[0].plan, 'max', '帳號其他欄位不動')
  state = new Error('舊版沒有這個指令')
  await ui.refreshQuota()
  assert.equal(ui.state.quotaState.status, 'login_expired', '讀不到就維持原樣')
  state = { status: '亂寫', windows: 'x' }
  await ui.refreshQuota()
  assert.equal(ui.state.quotaState.status, 'none')
})

test('重讀額度接線：每 5 分鐘重讀、打開設定頁時重讀；帳號回報不靠畫面定時', () => {
  const js = read('ui/list.js')
  assert.match(js, /setInterval\(\(\) => \{ void accounts\.refreshQuota\(\);[^\n]*\}, 5 \* 60_000\)/)
  assert.doesNotMatch(js, /accounts\.report\(\)/)   // #374 起同一支也順便讀帳號列表
  assert.match(js, /watch\(\(\) => ui\.panel\.setting, k => \{[^]*?if \(k\) void accounts\.refreshQuota\(\)[^]*?\}, \{ immediate: true \}\)/)
})

test('設備分類讀帳號回報：失敗後過了一分鐘會再讀；成功之後不再重讀；剛登入立刻重讀失敗的', async () => {
  let t = 1_000_000
  let fail = true
  const f = fake({ acct_remote_list: ({ node }) => { if (node === 'bad' && fail) throw new Error('沒登入'); return { asn_online: true, reported_at: '', accounts: [] } } })
  const ui = createAccountsUi({ invoke: f.invoke, reactive, sleep: async () => {}, now: () => t })
  const reads = () => f.calls.filter(c => c[0] === 'acct_remote_list').map(c => c[1].node)
  await ui.loadReports(['good', 'bad'])
  assert.equal(ui.state.reports.bad.failedAt, 1_000_000)
  assert.equal(await ui.retryReports(['good', 'bad']), 0, '剛失敗：不重讀')
  t += 59_000
  assert.equal(await ui.retryReports(['good', 'bad']), 0)
  t += 1_000
  fail = false
  assert.equal(await ui.retryReports(['good', 'bad']), 1, '滿 60 秒：只重讀失敗的那台')
  assert.deepEqual(reads(), ['good', 'bad', 'bad'])
  assert.equal(ui.state.reports.bad.error, '')
  t += 600_000
  assert.equal(await ui.retryReports(['good', 'bad']), 0, '成功的不重讀')
  // 剛登入：失敗的立刻讀，不等時間
  fail = true
  await ui.loadReports(['bad'])
  fail = false
  assert.equal(await ui.retryReports(['bad']), 0)
  assert.equal(await ui.retryReports(['bad'], { force: true }), 1)
  assert.equal(await ui.retryReports(['new']), 1, '沒讀過的也讀')
})

test('守門：電腦版每分鐘檢查、只在設備分類開著時重讀；登入事件接上', () => {
  const src = read('ui/list.js')
  assert.match(src, /setInterval\(\(\) => \{ if \(devicesOpen\(\)\) void accounts\.retryReports\(otherDeviceNodes\(\)\) \}, REPORT_RETRY_MS\)/)
  assert.match(src, /onSignedIn = \(\) => void accounts\.retryReports\(otherDeviceNodes\(\), \{ force: true \}\)/)
})

test('上次確認可用（#1512 C）：只顯示 Rust 給的毫秒數，沒有或不合理就不顯示', async () => {
  const { usableAtText, USABLE_AT_LABEL } = await import('../ui/lib/claude-accounts.mjs')
  assert.equal(usableAtText({ usable_at_ms: Date.UTC(2026, 10, 15, 8, 5) }, 'Asia/Taipei'), `${USABLE_AT_LABEL}：2026/11/15 16:05`)
  for (const a of [{}, null, { usable_at_ms: 0 }, { usable_at_ms: -1 }, { usable_at_ms: 'x' }, { usable_at_ms: 1e20 }]) assert.equal(usableAtText(a, 'Asia/Taipei'), '', JSON.stringify(a))
})

test('上次確認可用（#1512 C2）：別台經後台回報的是 UTC 字串，一樣顯示成當地時間；設備頁的列帶出這行', async () => {
  const { usableAtText, USABLE_AT_LABEL } = await import('../ui/lib/claude-accounts.mjs')
  assert.equal(usableAtText({ usable_at: '2026-11-15T08:05:00Z' }, 'Asia/Taipei'), `${USABLE_AT_LABEL}：2026/11/15 16:05`)
  assert.equal(usableAtText({ usable_at: '不是時間' }, 'Asia/Taipei'), '')
  assert.equal(usableAtText({ usable_at: 12345 }, 'Asia/Taipei'), '', '型別不對不顯示')
  const tree = fs.readFileSync(new URL('../ui/lib/device-tree.mjs', import.meta.url), 'utf8')
  assert.match(tree, /\.\.\.\(k === 'claude' && usableAtText\(a\) \? \{ usableAt: usableAtText\(a\) \} : \{\}\)/, '只有 Claude 的列帶')
  const html = fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8')
  assert.match(html, /<span class="m-dv-usable" v-if="a\.usableAt">\{\{ a\.usableAt \}\}<\/span>/)
})

test('#1880 讀不到目前登入的帳號：畫面寫讀不到，不當成沒登入、不沿用上次的帳號', async () => {
  let cur = { email: 'a@x.test', saved: true }
  const { ui } = mk({ claude_accounts_list: [], claude_account_current: () => { if (cur instanceof Error) throw cur; return cur }, codex_account_current: null })
  await ui.refresh()
  assert.equal(ui.state.current.email, 'a@x.test')
  assert.equal(ui.state.currentErr, '')
  cur = new Error('讀不到目前登入的帳號')
  await ui.refresh()
  assert.equal(ui.state.current, null, '不沿用舊值')
  assert.equal(ui.state.currentErr, '讀不到目前登入的帳號')
  assert.match(read('ui/lib/settings-panel.mjs'), /st\.accounts\.currentErr/, '設定頁有顯示這句')
  cur = { email: 'b@x.test', saved: true }
  await ui.refresh()
  assert.equal(ui.state.currentErr, '', '恢復後清掉')
})

test('#1880 切換失敗：畫面顯示 Rust 回的「切換沒有成功」，不寫已切換', async () => {
  const { ui } = mk({ claude_accounts_list: [], claude_account_current: null, codex_account_current: null, claude_account_switch: new Error('切換沒有成功：這台電腦登入的帳號沒有換過去。'), acct_remote_report: {} })
  await ui.switchTo('b@x.test')
  assert.match(ui.state.msg, /^切換沒有成功/)
  assert.doesNotMatch(ui.state.msg, /已切換/)
})
