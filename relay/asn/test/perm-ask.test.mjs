// 手機回答權限框（#853）的畫面邏輯與守門
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ARM_MS, TEXT, decideArgs, nextToAsk, normalizeList, resultOf } from '../ui/lib/perm-ask.mjs'
import { normalizeNav, permReqNav } from '../ui/lib/mobile.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const ID = '11111111-2222-3333-4444-555555555555'
const H = 'a'.repeat(64)
const NOW = Date.parse('2026-11-05T00:00:00Z')
const row = o => ({ id: ID, node: 'w', window_name: '小乙', prompt_text: 'Do you want?\nrm x', complete: true, options: [{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }], body_hash: H, expires_at: '2026-11-05T00:10:00Z', ...o })
const list = (...r) => normalizeList({ requests: r }, () => '家用機', NOW)

test('清單：留換行、拿掉控制字元和雙向控制', () => {
  const [r] = list(row({ prompt_text: 'a\nb\u001b[31m‮c', window_name: '小‮乙' }))
  assert.equal(r.text, 'a\nb c')
  assert.equal(r.window, '小 乙')
  assert.equal(r.deviceName, '家用機')
  assert.deepEqual(r.options, [{ n: 1, label: 'Yes' }, { n: 3, label: 'No' }])
})

test('清單：壞的、過期的丟掉', () => {
  for (const b of [{ id: 'x' }, { body_hash: 'x' }, { expires_at: '2026-11-04T00:00:00Z' }, { expires_at: 'x' }, { prompt_text: null }]) {
    assert.deepEqual(list(row(b)), [], JSON.stringify(b))
  }
  assert.deepEqual(list(row({ options: [{ n: 0, label: 'x' }, { n: 10, label: 'y' }] }))[0].options, [], '編號不對的選項不給按')
  assert.deepEqual(list(row({ options: [] }))[0].options, [], '沒有選項：看得到不能按')
  assert.deepEqual(normalizeList(null), [])
})

test('決定：只有清單裡的數字，只帶編號、數字、雜湊', () => {
  const [r] = list(row())
  assert.deepEqual(decideArgs(r, 3), { id: ID, choiceN: 3, hash: H })
  assert.equal(decideArgs(r, 2), null)
  assert.equal(decideArgs(null, 1), null)
})

test('先不處理的不再跳', () => {
  const [r] = list(row())
  assert.equal(nextToAsk([r], new Set()), r)
  assert.equal(nextToAsk([r], new Set([ID])), null)
})

test('結果：沒有最終結果就繼續等；失敗要說', () => {
  assert.equal(resultOf({ recent: [] }, ID), null)
  assert.equal(resultOf({ recent: [{ id: ID, status: 'taken' }] }, ID), null)
  assert.equal(resultOf({ recent: [{ id: ID, status: 'decided' }] }, ID), null)
  assert.deepEqual(resultOf({ recent: [{ id: ID, status: 'done' }] }, ID), { ok: true, text: TEXT.done })
  assert.equal(resultOf({ recent: [{ id: ID, status: 'failed', detail: '內容變了' }] }, ID).text, `${TEXT.failed}：內容變了`)
  assert.equal(resultOf({ recent: [{ id: ID, status: 'expired' }] }, ID).ok, false)
  assert.equal(resultOf({ recent: [{ id: ID, status: 'cancelled' }] }, ID).ok, false)
})

test('導覽', () => {
  assert.deepEqual(permReqNav(), { tab: 'chats', sheet: 'permreq' })
  assert.deepEqual(normalizeNav({ sheet: 'permreq', tab: 'x' }), permReqNav())
})

test('守門：全文不進儲存、網址、console；只有選項按鈕，沒有輸入框；按鈕要等一下才能按', () => {
  const js = read('../ui/m.js'), html = read('../ui/m.html')
  const from = js.indexOf('手機回答權限框（#853）'), block = js.slice(from, js.indexOf('電腦要往終端送字／代答提問'))
  assert.ok(from > 0 && block.length > 500)
  for (const banned of ['localStorage', 'sessionStorage', 'clipboard', 'console.', 'indexedDB', 'cookie', 'location.', 'notify']) assert.ok(!block.includes(banned), banned)
  assert.equal((js.match(/invoke\('android_perm_req_decide'/g) ?? []).length, 1, 'decide 只有一處呼叫')
  assert.match(block, /pqDecideArgs\(/, '送出前先過 decideArgs')
  const sheet = html.slice(html.indexOf("nav.sheet === 'permreq'"), html.indexOf('<group-sheet'))
  assert.ok(sheet.length > 200)
  assert.ok(!/<input|<textarea|contenteditable|v-html/.test(sheet), '沒有輸入框，全文不走 v-html')
  assert.match(sheet, /:disabled="pq\.busy \|\| !pq\.armed"/)
  assert.ok(ARM_MS >= 500)
})

test('守門：指令只在手機、簽章、欄位先檢查；舊表不動', () => {
  const lib = read('../src-tauri/src/lib.rs'), and = read('../src-tauri/src/android.rs'), rel = read('../src-tauri/src/relay.rs')
  assert.match(lib, /android::android_perm_req_list/); assert.match(lib, /android::android_perm_req_decide/)
  assert.ok(!/^\s*android_perm_req/m.test(lib.slice(0, lib.indexOf('android::relay_attachment_save'))))
  assert.match(and, /build_perm_decide_body\(&id, choice_n, &hash\)\?/)
  assert.match(and, /api_signed\("perm_req_list"/); assert.match(and, /api_signed\("perm_req_decide"/)
  const fn = rel.slice(rel.indexOf('pub fn build_perm_decide_body'), rel.indexOf('pub fn build_perm_decide_body') + 600)
  assert.match(fn, /\(1\.\.=9\)\.contains/)
  assert.ok(!/text|keys/.test(fn), '沒有文字欄位')
})

test('設定：獨立開關，預設開；說明要講內容會經後台', () => {
  const panel = read('../ui/lib/settings-panel.mjs'), list = read('../ui/list.js'), mod = read('../src-tauri/src/bridge/mod.rs'), lib = read('../src-tauri/src/lib.rs')
  assert.match(panel, /act\('bridge-perm-phone', \$event\.target\.checked\)/)
  assert.match(list, /permPhone: s\.perm_phone !== false/, '預設開：舊後端沒有這個欄位也顯示開著')
  assert.match(list, /case 'bridge-perm-phone': await setBridgePermPhone\(value === true\)/)
  assert.match(mod, /perm_phone: !s\.perm_phone_off/)
  assert.match(lib, /perm_remote::set_user_off\(bridge::read_settings\(&data_dir\)\.perm_phone_off\)/)
  assert.match(panel, /權限框的內容和選項[^<]*經過 ASN 的伺服器/)
  assert.ok(!panel.includes('畫面內容不會離開這台電腦'), '舊說法已經不對')
})
