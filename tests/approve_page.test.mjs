// 網頁核准頁（site/public/link）的純邏輯與守門測試：node --test --test-force-exit --test-timeout=120000 tests/approve_page.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
const L = await import('../site/public/link/logic.mjs')
const C = await import('../site/public/link/config.mjs')

test('解析短碼：大小寫、空白、連字號都容忍；不在字母表的字、長度不對、授權碼一律不算', () => {
  assert.equal(L.parseUserCode('?code=abcd-2345'), 'ABCD-2345')
  assert.equal(L.parseUserCode('?code=ABCD2345'), 'ABCD-2345')
  assert.equal(L.parseUserCode('?code=%20abcd%202345%20'), 'ABCD-2345')
  assert.equal(L.parseUserCode('?code=ABCD-23O5'), null, 'O 不在字母表')
  assert.equal(L.parseUserCode('?code=ABCD-234'), null)
  assert.equal(L.parseUserCode('?code=ABCD-23456'), null)
  assert.equal(L.parseUserCode('?code=0b7c1a3e-9f2d-4a55-8c11-2f6d3a9e7b10'), null, '登入完成回來的授權碼不是短碼')
  assert.equal(L.parseUserCode(''), null)
  assert.equal(L.normalizeUserCode(undefined), null)
})

test('登入回來的網址分類：授權碼＋state、供應商回報錯誤、短碼、什麼都沒有', () => {
  assert.deepEqual(L.classifyReturn('?code=0b7c1a3e-9f2d-4a55-8c11-2f6d3a9e7b10&state=ST_1'), { kind: 'oauth', authCode: '0b7c1a3e-9f2d-4a55-8c11-2f6d3a9e7b10', state: 'ST_1' })
  assert.deepEqual(L.classifyReturn('?code=abcd-2345'), { kind: 'code', userCode: 'ABCD-2345' })
  assert.equal(L.classifyReturn('?error=access_denied&error_description=x&state=ST').kind, 'oauth_error')
  assert.deepEqual(L.classifyReturn(''), { kind: 'none' })
  // 授權碼格式不明但帶 state：仍當授權碼（交給 state 比對擋）
  assert.equal(L.classifyReturn('?code=weird_code_value_12345&state=S').kind, 'oauth')
})

test('錯誤文字：每個後台錯誤碼都有白話繁體中文，且不洩漏英文代碼', () => {
  const cases = {
    invalid_code: /短碼不對|過期/,
    rate_limited: /15 分鐘/,
    id_taken: /代號.*用了/,
    bad_id_prefix: /代號.*開頭/,
    too_many: /上限/,
    unauthorized: /登入/,
    bad_request: /不合格|格式/,
    tenant_inactive: /停用/,
    internal: /暫時/,
  }
  for (const [code, re] of Object.entries(cases)) {
    const t = L.errorText(code)
    assert.match(t, re, code)
    assert.doesNotMatch(t, new RegExp(code), `${code} 不該直接出現在畫面上`)
    assert.doesNotMatch(t, /[A-Za-z]{4,}/, `${code} 的說明不該夾英文`)
  }
  assert.match(L.errorText('network'), /連不上/)
  assert.match(L.errorText('totally_new'), /沒有成功/)
  assert.match(L.errorText(''), /沒有成功/)
  assert.equal(L.isLoginProblem('unauthorized'), true)
  assert.equal(L.isLoginProblem('invalid_code'), false)
})

test('核准請求：只送短碼、名字、可選代號；憑證只在標頭；網址不帶任何機密', () => {
  const r = L.buildApproveRequest({ token: 'TOKEN_abc', userCode: ' abcd 2345 ', name: ' 我的主機 ', nodeId: '' })
  assert.equal(r.url, `${C.RELAY_URL}?action=device_code_approve`)
  assert.equal(r.init.method, 'POST')
  assert.equal(r.init.headers.authorization, 'Bearer TOKEN_abc')
  assert.equal(r.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(r.init.body), { user_code: 'ABCD-2345', name: '我的主機' }, '代號留空就不送 node_id')
  assert.ok(!r.url.includes('TOKEN_abc') && !r.url.includes('ABCD'), '網址不含憑證與短碼')
  assert.equal(JSON.parse(L.buildApproveRequest({ token: 't', userCode: 'ABCD-2345', name: 'x', nodeId: ' t1-box ' }).init.body).node_id, 't1-box')
  assert.match(L.buildApproveRequest({ token: 't', userCode: 'ABC', name: 'x' }).error, /8 碼/)
  assert.match(L.buildApproveRequest({ token: 't', userCode: 'ABCD-2345', name: '   ' }).error, /名字/)
  assert.match(L.buildApproveRequest({ token: 't', userCode: 'ABCD-2345', name: '字'.repeat(41) }).error, /名字/)
  assert.match(L.buildApproveRequest({ token: 't', userCode: 'ABCD-2345', name: 'a\u0007b' }).error, /名字/)
  assert.match(L.buildApproveRequest({ token: 't', userCode: 'ABCD-2345', name: 'x', nodeId: 'bad id' }).error, /代號/)
  assert.match(L.buildApproveRequest({ token: '', userCode: 'ABCD-2345', name: 'x' }).error, /登入/)
})

test('核准結果：成功帶節點代號與名字；失敗依狀態碼與錯誤碼轉成白話', () => {
  assert.deepEqual(L.readApproveReply(200, { ok: true, id: 'box-1', name: '盒子' }), { ok: true, id: 'box-1', name: '盒子' })
  assert.equal(L.readApproveReply(200, { ok: true }).ok, false, '沒有節點代號不當成功')
  assert.equal(L.readApproveReply(404, { error: 'invalid_code' }).code, 'invalid_code')
  assert.match(L.readApproveReply(429, { error: 'rate_limited' }).text, /15 分鐘/)
  assert.equal(L.readApproveReply(401, null).code, 'unauthorized')
  assert.equal(L.readApproveReply(500, null).code, 'internal')
  assert.equal(L.readApproveReply(0, null).code, 'network')
})

test('登入：PKCE 驗證向量、授權網址、換權杖請求', async () => {
  assert.equal(await L.challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 附錄 B')
  const v = L.newVerifier(), s = L.newState()
  assert.match(v, /^[A-Za-z0-9_-]{43}$/)
  assert.match(s, /^[A-Za-z0-9_-]{22}$/)
  assert.notEqual(v, L.newVerifier())
  const red = L.redirectTo('ST_1')
  assert.equal(red, `${C.SITE_ORIGIN}/link/?state=ST_1`)
  assert.ok(!/code=/.test(red), '回呼網址不含短碼')
  const u = L.buildAuthorizeUrl({ provider: 'google', state: 'ST_1', challenge: 'CH' })
  assert.ok(u.startsWith(`${C.AUTH_BASE}/auth/v1/authorize?provider=google&redirect_to=`))
  assert.ok(u.includes(encodeURIComponent('https://asnmessenger.web.app/link/?state=ST_1')))
  assert.ok(u.endsWith('&code_challenge=CH&code_challenge_method=s256'))
  assert.equal(L.buildAuthorizeUrl({ provider: 'google&evil=1', state: 's', challenge: 'c' }), null)
  assert.equal(L.buildAuthorizeUrl({ provider: 'facebook', state: 's', challenge: 'c' }), null)
  const t = L.buildTokenRequest({ authCode: 'CODE1', verifier: 'VERIF1' })
  assert.equal(t.url, `${C.AUTH_BASE}/auth/v1/token?grant_type=pkce`)
  assert.equal(t.init.headers.apikey, C.ANON_KEY)
  assert.deepEqual(JSON.parse(t.init.body), { auth_code: 'CODE1', code_verifier: 'VERIF1' })
  assert.equal(L.tokenFromReply(200, { access_token: 'AT', expires_in: 3600, refresh_token: 'RT' }), 'AT')
  assert.equal(L.tokenFromReply(200, { access_token: '' }), null)
  assert.equal(L.tokenFromReply(400, { access_token: 'AT' }), null)
})

test('回呼 state 驗證：不符、缺少、已用過都擋下', () => {
  const stash = { v: 'VERIF', s: 'STATE_OK_1234567890ab', c: 'ABCD-2345' }
  assert.equal(L.checkReturn(stash, 'STATE_OK_1234567890ab').ok, true)
  assert.equal(L.checkReturn(stash, 'STATE_BAD_1234567890ab').ok, false)
  assert.equal(L.checkReturn(stash, '').ok, false)
  assert.equal(L.checkReturn(null, 'STATE_OK_1234567890ab').ok, false)
  assert.equal(L.checkReturn({ v: '', s: 'x' }, 'x').ok, false)
})

test('設定與後台一致：網址、公開金鑰和 Rust 內建值相同（兩份真相要對得上）', () => {
  const rs = read('relay/asn/src-tauri/src/identity.rs')
  assert.ok(rs.includes(`"${C.RELAY_URL}"`), '後台網址要和 identity.rs 的 DEFAULT_URL 相同')
  assert.ok(rs.includes(`"${C.ANON_KEY}"`), '公開金鑰要和 identity.rs 的 BUILTIN_ANON 相同')
  assert.equal(C.AUTH_BASE, C.RELAY_URL.replace(/\/functions\/v1\/relay$/, ''))
  const dl = read('relay/asn/src-tauri/src/device_login.rs')
  assert.ok(dl.includes(`"${C.SITE_ORIGIN}/link/"`), '主機印出的網址要指向同一個核准頁')
})

test('頁面守門：沒有外部相依、沒有行內程式、說明要核對短碼、手機與深色模式', () => {
  const html = read('site/public/link/index.html')
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[^<]/i, '不得有行內程式')
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, '不得有行內事件處理')
  assert.doesNotMatch(html, /<style[\s>]/i, '樣式放外部檔（CSP 不開 unsafe-inline）')
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) assert.doesNotMatch(m[1], /^(https?:)?\/\//, `外部資源：${m[1]}`)
  assert.match(html, /核准前請確認.*短碼.*主機/s)
  assert.match(html, /name="viewport"/)
  assert.match(html, /name="referrer" content="no-referrer"/)
  assert.match(html, /name="robots" content="noindex"/)
  assert.match(html, /type="module"/)
  const css = read('site/public/link/link.css')
  assert.match(css, /prefers-color-scheme:\s*dark/)
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/i, 'CSS 不連外')
  assert.doesNotMatch(css, /@import/i)
})

test('腳本守門：不寫 console、不存憑證、儲存空間只放登入往返所需的非機密欄位', () => {
  for (const f of ['site/public/link/logic.mjs', 'site/public/link/link.mjs', 'site/public/link/config.mjs']) {
    const src = read(f)
    assert.doesNotMatch(src, /console\./, `${f} 不得寫 console（短碼以外的東西不進 log）`)
    assert.doesNotMatch(src, /localStorage|indexedDB|document\.cookie/, `${f} 不得長期存任何東西`)
    assert.doesNotMatch(src, /https?:\/\/(?!asnmessenger\.web\.app|etccgmkrosbzpltudlgt\.supabase\.co)[a-z0-9.-]+/i, `${f} 不得連到別的網站`)
  }
  const ui = read('site/public/link/link.mjs')
  const sets = [...ui.matchAll(/sessionStorage\.setItem\(([^)]*)\)/g)].map(m => m[1])
  assert.ok(sets.length >= 1, '登入往返要暫存驗證碼')
  for (const s of sets) assert.doesNotMatch(s, /token|access/i, `不得把憑證存進儲存空間：${s}`)
  assert.match(ui, /removeItem/, '暫存用過就清')
  assert.match(ui, /replaceState/, '登入回來後要把授權碼從網址拿掉')
})

test('主機託管設定：核准頁的 CSP 只開自己的腳本與後台一個來源，不快取、不送來源網址', () => {
  const fb = JSON.parse(read('site/firebase.json'))
  const rule = fb.hosting.headers.find(h => /link/.test(h.source))
  assert.ok(rule, 'firebase.json 要有 /link 的標頭')
  const h = Object.fromEntries(rule.headers.map(x => [x.key, x.value]))
  const csp = h['Content-Security-Policy']
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.match(csp, new RegExp(`connect-src ${C.AUTH_BASE.replace(/\./g, '\\.')}(;|$| )`))
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(h['Referrer-Policy'], 'no-referrer')
  assert.equal(h['Cache-Control'], 'no-store')
})
