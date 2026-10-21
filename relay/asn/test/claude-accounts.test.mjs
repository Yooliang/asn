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
  assert.deepEqual(f.calls.map(c => c[0]).slice(0, 4), ['claude_account_save', 'claude_accounts_list', 'claude_account_current', 'codex_account_current'])
  assert.match(ui.state.msg, /已加入 a@x\.test/)
  assert.equal(ui.state.list.length, 1)
  assert.ok(f.calls.some(c => c[0] === 'acct_remote_report'))
})

test('切換成功要提示重開 Claude 視窗，指令只帶 email；失敗顯示 Rust 回的中文原因', async () => {
  const { f, ui } = mk({ claude_accounts_list: [], claude_account_current: null, codex_account_current: null, claude_account_switch: a => ({ email: a.email }), acct_remote_report: {} })
  await ui.switchTo('b@x.test')
  assert.deepEqual(f.calls[0], ['claude_account_switch', { email: 'b@x.test' }])
  assert.ok(ui.state.msg.includes(SWITCH_NOTICE) && SWITCH_NOTICE.includes('重開'))
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
  assert.deepEqual(f.calls[1], ['acct_remote_request', { node: 'W', email: 'w@x.test' }], '指令只帶設備與 email')
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
  assert.deepEqual(ui.state.incoming, [{ id: 'ID2', email: 'b@x.test', from: 'H', fromLabel: '家用機' }])
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

test('接線守門：設定頁有這一塊、Rust 指令有註冊、前端不碰權杖', () => {
  const panel = read('ui/lib/settings-panel.mjs'), js = read('ui/list.js'), lib = read('ui/lib/claude-accounts.mjs'), rs = read('src-tauri/src/lib.rs')
  assert.match(panel, /acct-set/)
  assert.match(js, /createAccountsUi/)
  for (const c of ['claude_accounts_list', 'claude_account_current', 'claude_account_save', 'claude_account_switch', 'claude_account_delete']) {
    assert.ok(rs.includes(`claude_accounts::${c}`), c)
    assert.ok(lib.includes(c), c)
  }
  assert.ok(rs.includes('codex_accounts::codex_account_current') && lib.includes('codex_account_current'))
  for (const c of ['acct_remote_report', 'acct_remote_list', 'acct_remote_request', 'acct_remote_status', 'acct_remote_pending', 'acct_remote_apply', 'acct_remote_decline', 'acct_remote_trust_get', 'acct_remote_trust_set']) {
    assert.ok(rs.includes(c), `lib.rs 沒註冊 ${c}`)
    assert.ok(lib.includes(c), `前端沒用到 ${c}`)
  }
  assert.doesNotMatch(lib, /accessToken|refreshToken|credentials|\bfetch\(|localStorage/)
  const acctPart = panel.slice(panel.indexOf('acct-set'), panel.indexOf("catKey === 'look'"))
  assert.doesNotMatch(acctPart, /token|credential/i)
  assert.ok(!/acct-save|acctName|存成帳號|取個名字/.test(panel + js + lib), '不再有取名字的流程')
})
