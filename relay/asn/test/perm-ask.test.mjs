// 手機回答權限框（#853）的畫面邏輯與守門
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ARM_MS, TEXT, WATCH_MS, decideArgs, nextToAsk, normalizeList, resultOf, stillPending } from '../ui/lib/perm-ask.mjs'
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

test('還在不在：在清單裡 true、不在 false、查不到 null（不能當成結束）', () => {
  assert.equal(stillPending({ requests: [row()] }, ID), true)
  assert.equal(stillPending({ requests: [row({ id: '99999999-2222-3333-4444-555555555555' })] }, ID), false)
  assert.equal(stillPending({ requests: [] }, ID), false, '清單是空的：這筆已經結束')
  for (const bad of [null, undefined, {}, { requests: null }, { requests: 'x' }, 'x', 7]) assert.equal(stillPending(bad, ID), null, JSON.stringify(bad))
  assert.equal(stillPending({ requests: [row()] }, undefined), null)
  assert.equal(stillPending({ requests: [null, 3, row()] }, ID), true, '清單裡有壞列也不影響')
})

test('守門：框開著時才輪詢、只在前景、關框或切背景就停', () => {
  const js = read('../ui/m.js')
  const from = js.indexOf('手機回答權限框（#853）'), block = js.slice(from, js.indexOf('電腦要往終端送字／代答提問'))
  const body = (head, to) => { const i = block.indexOf(head); assert.ok(i > 0, head); return block.slice(i, block.indexOf(to, i)) }
  assert.ok(WATCH_MS >= 3000 && WATCH_MS <= 10000)
  // 輪詢本體：沒有開著的框、正在送／等結果、已經有結果、不在前景，一律不查
  const tick = body('async function pqWatchTick()', 'function pqWatchStart()')
  assert.match(tick, /const cur = pq\.cur/)
  assert.match(tick, /!cur \|\| pq\.busy \|\| pq\.waiting \|\| pq\.result \|\| document\.visibilityState !== 'visible'\) return/)
  assert.match(tick, /pqStill\(await invoke\('android_perm_req_list'\), cur\.id\)/)
  assert.match(tick, /alive === false/, '只有確定已結束（false）才收；null 不收')
  assert.match(tick, /pq\.result = \{ ok: false, text: PERMREQ_TEXT\.gone \}/, '和 not_found 同樣的「已經結束」處理')
  // 計時器：只有一處建立，建立前先清掉；框開著而且在前景才建
  assert.equal((block.match(/setInterval\(\(\) => \{ void pqWatchTick\(\)/g) ?? []).length, 1, '只有一處建立輪詢')
  const start = body('function pqWatchStart()', '\n    }\n')
  assert.ok(start.indexOf('pqWatchStop()') < start.indexOf('setInterval'), '建立前先停掉舊的，不會疊')
  assert.match(start, /if \(pq\.cur && !pq\.result && document\.visibilityState === 'visible'\) pqWatchTimer/)
  // 開框時才啟動（在 checkPermReqs 原本的提早 return 之後，不另開一條）；關框會停；切到背景會停
  assert.equal((block.match(/pqWatchStart\(\)/g) ?? []).length, 3, '定義＋開框＋回前景，三處')
  const check = body('async function checkPermReqs()', 'async function pqWatchTick()')
  assert.ok(check.indexOf('pqWatchStart()') > check.indexOf('go(permReqNav())'), '開框之後才啟動')
  assert.match(block, /const pqClose = \(\) => \{ pqWatchStop\(\);/, '關框會停')
  assert.match(block, /visibilityState === 'visible'\) pqWatchStart\(\); else pqWatchStop\(\)/, '切到背景會停')
})
