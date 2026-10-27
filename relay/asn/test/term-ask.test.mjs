// 手機「待確認」：電腦要往終端送字／代答提問時，本人在手機上按確認或拒絕（#285、#296）。純邏輯與接線守門。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { POLL_MS, TEXT, clean, countdownText, decideArgs, errorText, nextToAsk, normalizeList } from '../ui/lib/term-ask.mjs'
import { normalizeNav, termReqNav } from '../ui/lib/mobile.mjs'

const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const NOW = Date.parse('2026-10-27T00:00:00Z')
const H = 'a'.repeat(64)
const ID = '11111111-2222-3333-4444-555555555555'
const base = (o = {}) => ({ id: ID, node: 'N1', kind: 'send', term_id: '4', folder_label: 'proj', preview: '請只回覆 OK', enter: true, options: null, body_hash: H, expires_at: new Date(NOW + 90_000).toISOString(), ...o })
const list = (...rs) => ({ requests: rs })

test('清單：欄位壞掉、雜湊不是 64 位小寫十六進位、種類不認得、已過期、代答沒有選項的都丟掉', () => {
  const ok = normalizeList(list(base()), n => (n === 'N1' ? '家用機' : ''), NOW)
  assert.equal(ok.length, 1)
  assert.deepEqual([ok[0].deviceName, ok[0].term, ok[0].folder, ok[0].preview, ok[0].enter, ok[0].secondsLeft, ok[0].hash], ['家用機', '4', 'proj', '請只回覆 OK', true, 90, H])
  const bad = [
    base({ id: 'x' }), base({ body_hash: 'A'.repeat(64) }), base({ body_hash: 'a'.repeat(63) }), base({ kind: 'run' }),
    base({ expires_at: new Date(NOW - 1000).toISOString() }), base({ expires_at: '壞的' }), base({ kind: 'answer', options: [] }), base({ kind: 'answer', options: null }), null,
  ]
  assert.deepEqual(normalizeList(list(...bad), () => '', NOW), [])
  assert.deepEqual(normalizeList('壞的'), [])
  assert.equal(normalizeList(list(base()), () => '', NOW)[0].deviceName, '某台電腦', '查不到設備名稱')
})

test('預覽脫敏：ANSI 序列與控制字元、雙向文字控制都清掉；最多 200 字；送字不收選項', () => {
  const dirty = 'hi\u001b[31mred\u001b[0m\u0000x‮evil\r\n行'
  const r = normalizeList(list(base({ preview: dirty })), () => '', NOW)[0]
  assert.ok(!/[\u0000-\u0008\u000b-\u001f‪-‮]/.test(r.preview), JSON.stringify(r.preview))
  assert.ok(!r.preview.includes('[31m'), 'ANSI 序列整段拿掉')
  assert.equal(clean('a'.repeat(500), 200).length, 200)
  assert.deepEqual(normalizeList(list(base({ options: [{ n: 1, label: 'x' }] })), () => '', NOW)[0].options, [], '送字不帶選項')
})

test('代答：選項只收 n 0..99 的整數與文字，標籤清控制字元；n 不合格的丟掉', () => {
  const a = normalizeList(list(base({ kind: 'answer', options: [{ n: 1, label: 'Yes\u001b[1m' }, { n: 100, label: '壞' }, { n: 2.5, label: '壞' }, { n: 2, label: 'No' }, { n: 3, label: 5 }] })), () => '', NOW)[0]
  assert.deepEqual(a.options.map(o => [o.n, o.label]), [[1, 'Yes'], [2, 'No']])
})

test('下一筆、倒數字樣、輪詢間隔', () => {
  const rows = normalizeList(list(base(), base({ id: '22222222-2222-3333-4444-555555555555' })), () => '', NOW)
  assert.equal(nextToAsk(rows, new Set()).id, ID)
  assert.equal(nextToAsk(rows, new Set([ID])).id, '22222222-2222-3333-4444-555555555555')
  assert.equal(nextToAsk(rows, new Set(rows.map(r => r.id))), null)
  assert.equal(countdownText(65), '剩 1:05')
  assert.equal(countdownText(-3), '剩 0:00')
  assert.equal(POLL_MS, 30_000)
})

test('決定：送字不帶選項；代答要先選一個真的在選項裡的（沒有預設選項）；拒絕不帶選項；雜湊原樣帶回', () => {
  const send = normalizeList(list(base()), () => '', NOW)[0]
  const ans = normalizeList(list(base({ kind: 'answer', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] })), () => '', NOW)[0]
  assert.deepEqual(decideArgs(send, 'approve', 7), { id: ID, decision: 'approve', hash: H, choiceN: null })
  assert.deepEqual(decideArgs(send, 'deny', null), { id: ID, decision: 'deny', hash: H, choiceN: null })
  assert.equal(decideArgs(ans, 'approve', null), null, '沒選不能確認')
  assert.equal(decideArgs(ans, 'approve', 9), null, '不在選項裡')
  assert.deepEqual(decideArgs(ans, 'approve', 2), { id: ID, decision: 'approve', hash: H, choiceN: 2 })
  assert.deepEqual(decideArgs(ans, 'deny', 2), { id: ID, decision: 'deny', hash: H, choiceN: null }, '拒絕不帶選項')
  assert.equal(decideArgs(ans, 'maybe', 1), null)
  assert.equal(decideArgs(null, 'approve', 1), null)
})

test('錯誤字樣：後台代碼翻成中文，不認得的給通用一句', () => {
  assert.match(errorText('term_req_decide HTTP 409 hash_mismatch'), /內容已經變了/)
  assert.match(errorText('term_req_decide HTTP 404 not_found'), /已經結束/)
  assert.match(errorText('term_req_decide HTTP 403 forbidden'), /本人/)
  assert.match(errorText('尚未登入，不能確認終端請求'), /請先登入/)
  assert.equal(errorText(new Error('奇怪')), '送出失敗，請稍後再試')
})

test('導覽：termreq 是合法的底部浮層，重整後還原', () => {
  assert.deepEqual(termReqNav(), { tab: 'chats', sheet: 'termreq' })
  assert.deepEqual(normalizeNav({ sheet: 'termreq', tab: 'x' }), termReqNav())
})

test('守門：只呼叫兩個指令、只在本人按鈕時決定；預覽與雜湊不進儲存／網址／console；沒登入不打；Rust 端有註冊且是手機專用', () => {
  const js = read('../ui/m.js'), html = read('../ui/m.html'), lib = read('../ui/lib/term-ask.mjs'), rs = read('../src-tauri/src/lib.rs'), and = read('../src-tauri/src/android.rs')
  assert.match(js, /invoke\('android_term_req_list'\)/)
  assert.equal((js.match(/invoke\('android_term_req_decide'/g) ?? []).length, 1, 'decide 只有一處呼叫')
  const from = js.indexOf('電腦要往終端送字／代答提問'), block = js.slice(from, js.indexOf('名單第三行', from))
  assert.ok(block.length > 800)
  for (const banned of ['localStorage', 'sessionStorage', 'clipboard', 'console.', 'indexedDB', 'cookie', 'location.']) assert.ok(!block.includes(banned) && !lib.includes(banned), `待確認面板不能用「${banned}」`)
  assert.match(js, /async function checkTermReqs\(\) \{\s*if \(tq\.busy \|\| tq\.cur \|\| sec\.cur \|\| nav\.sheet \|\| !acct\.value\.signed_in/)
  assert.match(block, /decideTermReq\(decision\)[\s\S]*tqDecideArgs\(/, '送出前先過 decideArgs')
  assert.equal((html.match(/decideTermReq\('approve'\)/g) ?? []).length, 1)
  assert.match(html, /nav\.sheet === 'termreq'/)
  assert.match(html, /:disabled="tq\.busy \|\| \(tq\.cur\.kind === 'answer' && tq\.choice === null\)" @click="decideTermReq\('approve'\)"/, '代答沒選項時確認鈕停用')
  assert.match(rs, /android::android_term_req_list/); assert.match(rs, /android::android_term_req_decide/)
  assert.ok(!/^\s*(term_req_|android_term_req)/m.test(rs.slice(0, rs.indexOf('android::relay_attachment_save'))), '電腦版清單不放手機專用指令')
  assert.match(and, /let Some\(t\) = token\.as_deref\(\)\.filter\(\|t\| !t\.is_empty\(\)\) else \{ return Err\("尚未登入，不能確認終端請求"/, '沒簽章憑證不打後台')
  assert.match(and, /build_term_decide_body\(&id, &decision, choice_n, &hash\)\?/, '決定前先檢查欄位')
  assert.ok(TEXT.note.includes('不等於授權這個資料夾'))
})
