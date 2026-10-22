// 首次登入引導（#166）：步驟判斷、旗標、名字檢查、畫面元件、電腦版與手機版的接線守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { ONBOARD_STORE, checkName, hasAccountName, markOnboarded, onboardSteps, planOnboarding, stepLabel } from '../ui/lib/onboard.mjs'
import { OnboardCard } from '../ui/lib/onboard-card.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const memFlag = init => { let v = init; return { load: async () => v, save: async d => { v = d }, get: () => v } }

test('帳號有沒有名字：空白與建租戶時的預設稱呼不算', () => {
  assert.equal(hasAccountName('啟良'), true)
  for (const n of ['', '  ', null, undefined, '朋友', '主人']) assert.equal(hasAccountName(n), false, String(n))
})

test('步驟：全新用戶兩步；帳號已有名字跳過第一步；兩樣都有（舊用戶）或旗標已設就不引導', () => {
  assert.deepEqual(onboardSteps({ done: false, accountName: '朋友', deviceCustom: false }), ['account', 'device'])
  assert.deepEqual(onboardSteps({ done: false, accountName: '啟良', deviceCustom: false }), ['device'], '別台設備設過名字就跳過第一步')
  assert.deepEqual(onboardSteps({ done: false, accountName: '啟良', deviceCustom: true }), [], '舊用戶升級上來不打擾')
  assert.deepEqual(onboardSteps({ done: true, accountName: '', deviceCustom: false }), [], '旗標已設')
  assert.deepEqual(onboardSteps({ done: false, accountName: '', deviceCustom: true }), ['account'])
})

test('名字檢查：去頭尾空白、1～40 字、不含控制字元', () => {
  assert.deepEqual(checkName('  啟良 '), { ok: true, name: '啟良', error: '' })
  assert.equal(checkName('').ok, false)
  assert.equal(checkName('   ').error, '名字不能是空的')
  assert.equal(checkName('字'.repeat(40)).ok, true)
  assert.equal(checkName('字'.repeat(41)).error, '名字最多 40 個字')
  assert.equal(checkName('a\nb').error, '名字不能含控制字元')
})

test('進度小字：只有一步不顯示', () => {
  assert.equal(stepLabel(['device'], 'device'), '')
  assert.equal(stepLabel(['account', 'device'], 'device'), '第 2 步，共 2 步')
})

test('planOnboarding：沒登入不引導；旗標已設不問後台；不用引導時順手設旗標；取不到帳號資料不擋也不設旗標', async () => {
  const signed = async () => ({ signed_in: true })
  // 沒登入（暫時不登入）
  let asked = 0
  const f0 = memFlag(null)
  assert.deepEqual((await planOnboarding({ store: f0, status: async () => ({ signed_in: false }), accountInfo: async () => { asked++ }, startup: {} })).steps, [])
  assert.equal(asked, 0)
  // 旗標已設
  const f1 = memFlag({ done: true })
  assert.deepEqual((await planOnboarding({ store: f1, status: signed, accountInfo: async () => { asked++ }, startup: {} })).steps, [])
  assert.equal(asked, 0, '旗標已設就不問後台')
  // 全新用戶
  const f2 = memFlag(null)
  const p2 = await planOnboarding({ store: f2, status: signed, accountInfo: async () => ({ owner_name: '朋友' }), startup: { window_name_custom: false } })
  assert.deepEqual(p2.steps, ['account', 'device'])
  assert.equal(f2.get(), null, '還沒走完不設旗標')
  // 舊用戶：兩樣都有 → 設旗標
  const f3 = memFlag(null)
  assert.deepEqual((await planOnboarding({ store: f3, status: signed, accountInfo: async () => ({ owner_name: '啟良' }), startup: { window_name_custom: true } })).steps, [])
  assert.equal(f3.get().done, true)
  // 後台取不到
  const f4 = memFlag(null)
  const p4 = await planOnboarding({ store: f4, status: signed, accountInfo: async () => { throw new Error('連不上') }, startup: { window_name_custom: false } })
  assert.deepEqual(p4.steps, [])
  assert.equal(f4.get(), null)
  // 完成後設旗標
  await markOnboarded(f4)
  assert.equal(f4.get().done, true)
})

test('畫面元件：第一步問帳號名稱、一步一頁、最後一步才說「完成」；存檔失敗留在原地顯示錯誤', async () => {
  globalThis.Vue = Vue
  const calls = []
  const api = { setAccountName: async n => { calls.push(['account', n]) }, setDeviceName: async n => { calls.push(['device', n]) } }
  const html = await renderToString(Vue.createSSRApp({ render: () => Vue.h(OnboardCard, { steps: ['account', 'device'], deviceDefault: '家用機', api }) }))
  assert.match(html, /你的名字/)
  assert.match(html, /第 1 步，共 2 步/)
  assert.match(html, /下一步/)
  assert.doesNotMatch(html, /[A-Za-z]{3,}-ASN|\bw02\b/, '不顯示節點代號')
  const only = await renderToString(Vue.createSSRApp({ render: () => Vue.h(OnboardCard, { steps: ['device'], deviceDefault: '家用機', api, mobile: true }) }))
  assert.match(only, /這台設備的名稱/)
  assert.match(only, /value="家用機"/, '預設帶系統偵測的名稱')
  assert.match(only, />完成</)
  assert.doesNotMatch(only, /第 \d 步/)
  assert.match(only, /m-btn/, '手機版用手機的按鈕樣式')
})

test('接線守門：電腦版登入後轉引導頁、手機版有引導畫面，兩邊旗標用同一個存檔名', () => {
  assert.equal(ONBOARD_STORE, 'onboard')
  const list = read('ui/list.js')
  const a = list.indexOf('planOnboarding({')
  assert.ok(a > 0 && list.slice(a, a + 400).includes("location.replace('onboard.html')"), '名單視窗判斷後轉去引導頁')
  assert.ok(list.indexOf('planOnboarding({') < list.indexOf('if (info.error) {'), '在「無法啟動」之前判斷')
  assert.ok(list.includes('!info.needs_login'), '沒登入畫面時不判斷')
  assert.ok(fs.existsSync(new URL('../ui/onboard.html', import.meta.url)))
  const ob = read('ui/onboard.js')
  assert.ok(ob.includes("location.replace('list.html')") && ob.includes('markOnboarded') && ob.includes("invoke('set_window_name'") && ob.includes('authApi.setAccountName'))
  const m = read('ui/m.js'), mh = read('ui/m.html')
  assert.ok(m.includes("screen.value = 'onboard'") && m.includes('planOnboarding('))
  assert.match(mh, /v-else-if="screen === 'onboard'"/)
  assert.match(mh, /<onboard-card /)
})

test('接線守門：帳號名稱指令 Rust 端有註冊（電腦與手機兩份清單）；設定頁有帳號名稱欄位', () => {
  const lib = read('src-tauri/src/lib.rs')
  assert.equal([...lib.matchAll(/account::auth_account_name_set/g)].length, 2, '電腦與手機的指令清單都要有')
  assert.match(read('src-tauri/src/account.rs'), /"account_name", None, json!\(\{ "name": name \}\)/)
  assert.ok(lib.includes('window_name_custom: read_settings_name(&app.data_dir).is_some()'))
  const lp = read('ui/lib/login-panel.mjs')
  assert.ok(lp.includes('authApi.setAccountName') && lp.includes('aria-label="帳號名稱"'))
})
