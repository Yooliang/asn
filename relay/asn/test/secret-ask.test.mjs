// 遠端密碼請求（#26 第二期）的畫面邏輯與接線：手機確認面板、電腦確認窗的遠端欄位。只用假值。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeList, nextToAsk, countdownText, secretError, errorText, POLL_MS, TEXT } from '../ui/lib/secret-ask.mjs'
import { viewModel } from '../ui/lib/askpass-dialog.mjs'
import { secretNav, normalizeNav } from '../ui/lib/mobile.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('清單：只收欄位完整且還有時間的；其餘丟掉', () => {
  const l = normalizeList({ requests: [
    { id: 'a', node_name: '雲端代理', program: 'git', purpose: 'push', fingerprint: 'ab12-cd34', seconds_left: 59.9 },
    { id: 'b', node_name: 'x', program: 'g', purpose: 'p', fingerprint: 'f', seconds_left: 0 },
    { id: 'c', program: 'g', purpose: 'p' },
    null,
  ] })
  assert.deepEqual(l, [{ id: 'a', nodeName: '雲端代理', program: 'git', purpose: 'push', fingerprint: 'ab12-cd34', secondsLeft: 59 }])
  assert.deepEqual(normalizeList(null), []); assert.deepEqual(normalizeList({ requests: 'x' }), [])
})

test('下一筆要問的跳過「先不處理」的', () => {
  const l = [{ id: 'a' }, { id: 'b' }]
  assert.equal(nextToAsk(l, new Set()).id, 'a')
  assert.equal(nextToAsk(l, new Set(['a'])).id, 'b')
  assert.equal(nextToAsk(l, new Set(['a', 'b'])), null)
})

test('倒數與密碼檢查', () => {
  assert.equal(countdownText(125), '剩 2:05'); assert.equal(countdownText(-3), '剩 0:00')
  assert.ok(secretError('')); assert.equal(secretError('abc'), ''); assert.ok(secretError('字'.repeat(400)), '以位元組算，1200 位元組超過上限')
  assert.equal(secretError('x'.repeat(1024)), '')
})

test('錯誤文字：後台代碼與 Rust 端的中文訊息都變成中文，不外洩原始字串', () => {
  assert.match(errorText(new Error('secret_reply HTTP 410 expired')), /過期/)
  assert.match(errorText(new Error('secret_reply HTTP 409 already_answered')), /回覆過/)
  assert.match(errorText('尚未登入，無法確認密碼請求'), /登入/)
  assert.match(errorText(new Error('這筆密碼請求已經結束（過期或已處理）')), /結束/)
  assert.equal(errorText(new Error('boom: HTTP 500 xyz')), '送出失敗，請稍後再試')
})

test('文案全中文（不夾英文單字）', () => {
  for (const v of Object.values(TEXT)) assert.doesNotMatch(v, /[A-Za-z]{3,}/, v)
  assert.equal(POLL_MS, 30000)
})

test('導覽：密碼面板是合法的 sheet，瀏覽記錄讀回來認得', () => {
  assert.deepEqual(secretNav(), { tab: 'chats', sheet: 'secret' })
  assert.deepEqual(normalizeNav({ sheet: 'secret', tab: 'x' }), secretNav())
})

test('電腦確認窗：遠端請求顯示設備與核對碼；本機小幫手的請求不變', () => {
  const r = viewModel({ kind: 'secret', origin: '雲端代理', fingerprint: 'ab12-cd34', program: 'git.exe', prompt: 'git push', seconds_left: 60 })
  assert.equal(r.remote, true); assert.equal(r.origin, '雲端代理'); assert.equal(r.fingerprint, 'ab12-cd34'); assert.match(r.title, /別台電腦/)
  const l = viewModel({ kind: 'secret', program: 'git.exe', cwd: 'C:/w', prompt: 'p', seconds_left: 60, origin: null, fingerprint: null })
  assert.equal(l.remote, false); assert.equal(l.title, '有程式要密碼')
  const html = read('../ui/askpass.html')
  assert.match(html, /v-if="vm\.remote"/); assert.match(html, /哪台電腦/); assert.match(html, /核對碼/); assert.match(html, /對方自報/)
  assert.match(html, /type="password"/); assert.match(html, /autocomplete="off"/)
})

test('守門：手機面板接線——只呼叫兩個指令，密碼只進輸入欄與 invoke，不進儲存／網址／console', () => {
  const js = read('../ui/m.js'), html = read('../ui/m.html'), lib = read('../ui/lib/secret-ask.mjs')
  assert.match(js, /invoke\('android_secret_pending'\)/); assert.match(js, /invoke\('android_secret_reply', \{ id: cur\.id, secret: value \}\)/)
  const from = js.indexOf('別台電腦／雲端代理要密碼'); const block = js.slice(from, js.indexOf('名單第三行', from))
  assert.ok(block.length > 500)
  for (const banned of ['localStorage', 'sessionStorage', 'clipboard', 'console.', 'indexedDB', 'cookie', 'location.']) {
    assert.ok(!block.includes(banned) && !lib.includes(banned), `密碼面板不能用「${banned}」`)
  }
  assert.match(block, /sec\.secret = ''/, '送出後立刻清空輸入欄')
  assert.match(html, /type="password"[^>]*autocomplete="off"/)
  assert.match(html, /nav\.sheet === 'secret'/)
  // Rust 端有註冊、安卓限定
  const rs = read('../src-tauri/src/lib.rs')
  assert.match(rs, /android::android_secret_pending/); assert.match(rs, /android::android_secret_reply/)
  assert.ok(!/^\s*(secret_pending|secret_reply|android_secret)/m.test(rs.slice(0, rs.indexOf('android::relay_attachment_save'))), '電腦版清單不放手機專用指令')
})

test('守門：後台沒有登入時手機不打確認動作（Rust 端驗簽章，畫面也先看 signed_in）', () => {
  const js = read('../ui/m.js')
  assert.match(js, /async function checkSecrets\(\) \{\s*if \(sec\.busy \|\| sec\.cur \|\| nav\.sheet \|\| !acct\.value\.signed_in/)
})
