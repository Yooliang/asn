// 帳號設定「AI 之間互相叫醒的上限」：輸入檢查（純邏輯），以及電腦版、手機版設定頁與外殼指令都接上了。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { checkAiWakeLimit, AI_WAKE_LIMIT_DEFAULT, AI_WAKE_LIMIT_LABEL } from '../ui/lib/ai-wake-limit.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('輸入檢查：0～200 的整數（數字或文字）；其他不合格並給中文提示', () => {
  assert.equal(AI_WAKE_LIMIT_DEFAULT, 20)
  for (const [raw, v] of [['0', 0], [5, 5], [' 7 ', 7], ['20', 20], ['200', 200], ['05', 5]]) assert.deepEqual(checkAiWakeLimit(raw), { ok: true, value: v, error: '' }, String(raw))
  for (const raw of ['', ' ', '-1', '201', '999', '1000', '2.5', 'abc', '1e1', null, undefined, '１２']) {
    const r = checkAiWakeLimit(raw)
    assert.equal(r.ok, false, String(raw)); assert.match(r.error, /0 到 200/); assert.equal(r.value, 20)
  }
})

test('設定頁標題用詞固定', () => {
  assert.equal(AI_WAKE_LIMIT_LABEL, 'AI 之間互相叫醒的上限（每次你發言後）')
})

test('電腦版、手機版設定頁與外殼指令都接上同一個設定', () => {
  const login = read('../ui/lib/login-panel.mjs'), mhtml = read('../ui/m.html'), mjs = read('../ui/m.js')
  const tauri = read('../ui/lib/tauri.mjs'), lib = read('../src-tauri/src/lib.rs'), acct = read('../src-tauri/src/account.rs')
  assert.match(login, /checkAiWakeLimit/); assert.match(login, /authApi\.setAiWakeLimit/); assert.match(login, /authApi\.getAiWakeLimit/)
  assert.match(login, /AI_WAKE_LIMIT_LABEL/)
  assert.match(mjs, /checkAiWakeLimit/); assert.match(mjs, /authApi\.setAiWakeLimit/); assert.match(mjs, /authApi\.getAiWakeLimit/)
  assert.match(mhtml, /AI_WAKE_LIMIT_LABEL[\s\S]{0,200}v-model="wakeDraft"/)
  assert.match(tauri, /'auth_ai_wake_limit_get'/); assert.match(tauri, /'auth_ai_wake_limit_set'/)
  // 兩份指令清單（桌面、安卓）都要註冊
  assert.equal(lib.split('account::auth_ai_wake_limit_get').length - 1, 2); assert.equal(lib.split('account::auth_ai_wake_limit_set').length - 1, 2)
  assert.match(acct, /pub async fn auth_ai_wake_limit_get/); assert.match(acct, /"account_settings"/)
})
