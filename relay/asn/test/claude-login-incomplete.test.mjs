// 存的登入不完整（權杖檔沒有 refreshToken）的 Claude 帳號：清單標「登入不完整」、不能選、切換反灰並寫原因（10-30 工作機事故）。
// 前端只拿得到 login_incomplete 這個布林，權杖內容不經過前端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { INCOMPLETE_LABEL, INCOMPLETE_REASON, createAccountsUi, loginIncomplete } from '../ui/lib/claude-accounts.mjs'
import { dialogView } from '../ui/lib/device-acct-dialog.mjs'
import { acctSheetView } from '../ui/lib/mobile-acct.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-30T10:00:00Z')
const list = () => [
  { email: 'a@x.test', plan: 'max', current: true },
  { email: 'b@x.test', plan: 'max', current: false, login_incomplete: true },
  { email: 'c@x.test', plan: 'pro', current: false, login_incomplete: false },
]

test('判斷只看 login_incomplete 布林；原因寫的是使用者要做的事', () => {
  assert.equal(loginIncomplete({ login_incomplete: true }), true)
  assert.equal(loginIncomplete({ login_incomplete: false }), false)
  assert.equal(loginIncomplete({}), false, '舊版 Rust 沒有這欄：當成正常')
  assert.equal(loginIncomplete(null), false)
  assert.equal(INCOMPLETE_LABEL, '登入不完整')
  assert.equal(INCOMPLETE_REASON, '這個帳號存的登入不完整，請重新登入一次再加入')
})

test('本機切換：登入不完整的帳號不送指令，直接顯示原因', async () => {
  const calls = []
  const invoke = async (cmd, args) => { calls.push(cmd); return cmd === 'claude_accounts_list' ? list() : cmd === 'claude_account_switch' ? { email: args.email } : null }
  const ui = createAccountsUi({ invoke, reactive: o => o, sleep: async () => {} })
  await ui.refresh()
  calls.length = 0
  await ui.switchTo('b@x.test')
  assert.equal(calls.includes('claude_account_switch'), false, '不送切換指令')
  assert.equal(ui.state.msg, INCOMPLETE_REASON)
  await ui.switchTo('c@x.test')
  assert.equal(calls.includes('claude_account_switch'), true, '正常的帳號照常切換')
})

test('設備樹：本機與別台回報的 Claude 帳號都帶 incomplete 標記', () => {
  const SELF = 'aaaaaaaa-0000-4000-8000-000000000001', W = 'bbbbbbbb-0000-4000-8000-000000000002'
  const fr = (node, device, agent) => ({ node, device, agent, engine: 'claude', status: 'online', kind: null, partnerId: 'dddddddd-0000-4000-8000-0000000000aa' })
  const t = buildDeviceTree({
    friends: [fr(SELF, '家用機', 'a1'), fr(W, '工作機', 'w1')], nodeOrder: [SELF, W], selfNode: SELF, now: NOW,
    asn: { [W]: [{ status: 'online', version: '1.0.0' }] }, launchers: {},
    reports: { [W]: { error: '', asnOnline: true, reportedAt: '2026-10-30T09:59:00Z', accounts: list().map(a => ({ vendor: 'claude', ...a })) } },
    self: { claude: list() },
  })
  for (const d of t) {
    const accts = d.vendors.find(v => v.key === 'claude').accounts
    assert.deepEqual(accts.map(a => [a.email, a.incomplete]), [['a@x.test', false], ['b@x.test', true], ['c@x.test', false]], d.label)
  }
})

test('電腦版遠端切換對話框：登入不完整的帳號選了也不能送，列上寫原因', () => {
  const remote = { node: 'n1', asnOnline: true, loading: false, busy: false, msg: '', reportedAt: '2026-10-30T09:59:00Z', list: list() }
  const v = dialogView(remote, 'b@x.test', NOW)
  assert.equal(v.canSwitch, false)
  assert.equal(v.switchEmail, '')
  const row = v.rows.find(r => r.email === 'b@x.test')
  assert.deepEqual([row.incomplete, row.picked, row.incompleteLabel, row.incompleteReason], [true, false, INCOMPLETE_LABEL, INCOMPLETE_REASON])
  assert.equal(v.rows.find(r => r.email === 'c@x.test').incomplete, false)
  assert.equal(dialogView(remote, 'c@x.test', NOW).canSwitch, true)
})

test('手機切換畫面：登入不完整的帳號不能選', () => {
  const remote = { loading: false, asnOnline: true, reportedAt: '2026-10-30T09:59:00Z', msg: '', list: list().map(a => ({ vendor: 'claude', ...a })) }
  const v = acctSheetView(remote, 'b@x.test', NOW)
  assert.equal(v.pickEmail, '')
  assert.equal(v.rows.find(r => r.email === 'b@x.test').incomplete, true)
  assert.equal(acctSheetView(remote, 'c@x.test', NOW).pickEmail, 'c@x.test')
})

test('畫面接線：切換按鈕在登入不完整時反灰，並寫出標籤與原因', () => {
  const panel = read('ui/lib/settings-panel.mjs')
  assert.match(panel, /:disabled="st\.accounts\.busy \|\| a\.current \|\| isIncomplete\(a\)"/, '本機帳號卡')
  assert.match(panel, /:disabled="!v\.switchable \|\| a\.incomplete"/, '別台設備帳號卡')
  assert.ok(panel.includes('{{ INCOMPLETE_LABEL }}') && panel.includes('{{ INCOMPLETE_REASON }}'))
  const listHtml = read('ui/list.html')
  assert.match(listHtml, /name="device-acct"[^>]*:disabled="a\.current \|\| a\.incomplete/, '遠端切換對話框的選項')
  assert.ok(listHtml.includes('{{ a.incompleteReason }}'))
  const m = read('ui/m.html')
  assert.match(m, /class="m-dv-sw"[^>]*:disabled="!v\.switchable \|\| a\.incomplete"/, '手機帳號卡')
  assert.ok(m.includes('{{ INCOMPLETE_LABEL }}') && m.includes('{{ INCOMPLETE_REASON }}'))
  const mjs = read('ui/m.js')
  assert.match(mjs, /import \{ INCOMPLETE_LABEL, INCOMPLETE_REASON(, LOGIN_FAILED_LABEL)? \} from '\.\/lib\/claude-accounts\.mjs'/)
  assert.match(mjs, /PLAN_UNKNOWN, INCOMPLETE_LABEL, INCOMPLETE_REASON,/)
})
