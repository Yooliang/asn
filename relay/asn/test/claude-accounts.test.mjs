// 設定頁「Claude 帳號」：前端只呼叫 Rust 指令、只顯示名稱／email／方案，權杖不經過前端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SWITCH_NOTICE, accountLine, createAccountsUi } from '../ui/lib/claude-accounts.mjs'

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

test('整理一行顯示：email 與方案，缺的就略過', () => {
  assert.equal(accountLine({ email: 'a@x.test', plan: 'max' }), 'a@x.test · max')
  assert.equal(accountLine({ email: 'a@x.test', plan: '' }), 'a@x.test')
  assert.equal(accountLine({ email: '', plan: '' }), '')
})

test('存成帳號：送出去的是修剪過的名稱，成功後清空輸入並重抓清單', async () => {
  const f = fake({ claude_accounts_list: [{ name: '甲', email: 'a@x.test', plan: 'max', current: true }], claude_account_save: a => ({ name: a.name }) })
  const ui = createAccountsUi({ invoke: f.invoke, reactive })
  ui.state.name = '  甲 '
  await ui.save()
  assert.deepEqual(f.calls.map(c => c[0]), ['claude_account_save', 'claude_accounts_list'])
  assert.deepEqual(f.calls[0][1], { name: '甲' })
  assert.equal(ui.state.name, '')
  assert.match(ui.state.msg, /已存成帳號「甲」/)
  assert.equal(ui.state.list.length, 1)
})

test('切換成功要提示重開 Claude 視窗；失敗顯示 Rust 回的中文原因', async () => {
  const f = fake({ claude_accounts_list: [], claude_account_switch: a => ({ name: a.name }) })
  const ui = createAccountsUi({ invoke: f.invoke, reactive })
  await ui.switchTo('乙')
  assert.ok(ui.state.msg.includes(SWITCH_NOTICE) && SWITCH_NOTICE.includes('重開'))
  const ui2 = createAccountsUi({ invoke: async c => { if (c === 'claude_account_switch') throw '目前登入的帳號還沒存成帳號，請先存'; return [] }, reactive })
  await ui2.switchTo('乙')
  assert.match(ui2.state.msg, /還沒存成帳號/)
  assert.equal(ui2.state.busy, false)
})

test('刪除要按兩次才真的刪', async () => {
  const f = fake({ claude_accounts_list: [], claude_account_delete: null })
  const ui = createAccountsUi({ invoke: f.invoke, reactive })
  await ui.remove('甲')
  assert.equal(f.calls.length, 0)
  assert.equal(ui.state.confirmDel, '甲')
  await ui.remove('甲')
  assert.deepEqual(f.calls[0], ['claude_account_delete', { name: '甲' }])
  assert.equal(ui.state.confirmDel, '')
})

test('接線守門：設定頁有這一塊、Rust 指令有註冊、前端不碰權杖', () => {
  const html = read('ui/lib/settings-panel.mjs'), js = read('ui/list.js'), lib = read('ui/lib/claude-accounts.mjs'), rs = read('src-tauri/src/lib.rs')   // 設定表單在設定聊天窗的元件裡
  assert.match(html, /acct-set/)
  assert.match(js, /createAccountsUi/)
  for (const c of ['claude_accounts_list', 'claude_account_save', 'claude_account_switch', 'claude_account_delete']) {
    assert.ok(rs.includes(`claude_accounts::${c}`), c)
    assert.ok(lib.includes(c), c)
  }
  assert.doesNotMatch(lib, /accessToken|refreshToken|credentials|\bfetch\(|localStorage/)
  assert.doesNotMatch(html.slice(html.indexOf('acct-set'), html.indexOf('視窗外框')), /token|credential|權杖/i)
})
