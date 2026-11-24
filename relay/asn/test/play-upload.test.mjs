// Play 自動上傳：用只連 127.0.0.1 的假伺服器測完整流程、失敗清理、JWT 格式、重試規則、金鑰不外洩。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TRACKS, getAccessToken, loadServiceAccount, makeJwt, makeRequester, maxPlayCode, publishAab, releaseNotes, reportAlpha } from '../scripts/play-upload.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const keyBody = privateKey.split('\n').filter(l => l && !l.startsWith('-----')).join('')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-upload-'))
const aab = path.join(tmp, 'x.aab')
fs.writeFileSync(aab, crypto.randomBytes(2048))
const saFile = path.join(tmp, 'sa.json')
fs.writeFileSync(saFile, JSON.stringify({ client_email: 'bot@example.iam.gserviceaccount.com', private_key: privateKey }))

// 假伺服器：記錄每個請求；handler(req, bodyBuf, n) 可回 [status, obj]
const fake = async handler => {
  const calls = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const call = { method: req.method, url: req.url, headers: req.headers, body }
      calls.push(call)
      const [status, obj] = handler(call, calls.length) || [200, {}]
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  return { calls, base, close: () => new Promise(r => srv.close(r)) }
}
const sa = { client_email: 'bot@example.iam.gserviceaccount.com', private_key: privateKey }
const req = makeRequester({ retries: 2, backoffMs: 1, timeoutMs: 5000 })
const happy = c => {
  if (c.url === '/token') return [200, { access_token: 'tok123' }]
  if (c.url.endsWith('/edits') && c.method === 'POST') return [200, { id: 'E1' }]
  if (c.url.includes('/bundles')) return [200, { versionCode: 77 }]
  return [200, {}]
}

test('JWT：三段、RS256、聲明內容、簽章可用公開金鑰驗過', () => {
  const jwt = makeJwt(sa, 1000, 'http://x/token')
  const [h, c, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'http://x/token', iat: 1000, exp: 4600 })
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')))
  assert.ok(!jwt.includes(keyBody.slice(0, 40)))
})

test('完整流程：順序、參數、AAB 內容、zh-TW 更新說明、不刪除', async () => {
  const f = await fake(happy)
  const logs = []
  try {
    const r = await publishAab({ aabFile: aab, sa, notes: '- 新功能', version: '9.9.9', apiBase: f.base, tokenUri: `${f.base}/token`, request: req, log: m => logs.push(m) })
    assert.equal(r.versionCode, 77)
    const seq = f.calls.map(c => `${c.method} ${c.url.split('?')[0]}`)
    assert.deepEqual(seq, [
      'POST /token',
      'POST /androidpublisher/v3/applications/tw.yooliang.asn/edits',
      'POST /upload/androidpublisher/v3/applications/tw.yooliang.asn/edits/E1/bundles',
      'PUT /androidpublisher/v3/applications/tw.yooliang.asn/edits/E1/tracks/internal',
      'PUT /androidpublisher/v3/applications/tw.yooliang.asn/edits/E1/tracks/alpha',
      'POST /androidpublisher/v3/applications/tw.yooliang.asn/edits/E1:commit',
    ])
    const [tok, , up, tr, tr2, cm] = f.calls
    assert.match(tok.body.toString(), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=[\w-]+\.[\w-]+\.[\w-]+/)
    assert.equal(up.url.split('?')[1], 'uploadType=media')
    assert.equal(up.headers.authorization, 'Bearer tok123')
    assert.deepEqual(up.body, fs.readFileSync(aab))
    assert.deepEqual(JSON.parse(tr.body), { track: 'internal', releases: [{ name: '9.9.9', versionCodes: ['77'], status: 'completed', releaseNotes: [{ language: 'zh-TW', text: '- 新功能' }] }] })
    assert.deepEqual(JSON.parse(tr2.body), { track: 'alpha', releases: [{ name: '9.9.9', versionCodes: ['77'], status: 'completed', releaseNotes: [{ language: 'zh-TW', text: '- 新功能' }] }] })
    assert.equal(cm.headers.authorization, 'Bearer tok123')
    assert.ok(!f.calls.some(c => c.method === 'DELETE'))
    assert.ok(!logs.join('\n').includes(keyBody))
  } finally { await f.close() }
})

for (const [name, failAt] of [['上傳失敗', '/bundles'], ['設定軌道失敗', '/tracks/'], ['提交失敗', ':commit']]) {
  test(`${name}：${failAt === ':commit' ? '已嘗試提交但' : '不提交，'}送出 edits.delete 清半成品，錯誤只含狀態與代碼`, async () => {
    const f = await fake(c => c.url.includes(failAt) ? [403, { error: { code: 403, message: `秘密訊息 ${keyBody}`, status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } }] : happy(c))
    try {
      await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', apiBase: f.base, tokenUri: `${f.base}/token`, request: req }), e => {
        assert.match(e.message, failAt === '/tracks/' ? /發布權限/ : /HTTP 403，forbidden/)
        assert.ok(!e.message.includes('秘密訊息') && !e.message.includes(keyBody))
        return true
      })
      const last = f.calls.at(-1)
      assert.equal(last.method, 'DELETE')
      assert.ok(last.url.endsWith('/edits/E1'))
      if (failAt !== ':commit') assert.ok(!f.calls.some(c => c.url.includes(':commit')))
    } finally { await f.close() }
  })
}

const count = (calls, re) => calls.filter(c => re.test(`${c.method} ${c.url}`)).length

test('兩條軌道：同一個編輯、AAB 只傳一次、兩條都設同一個 versionCode、只提交一次', async () => {
  assert.deepEqual(DEFAULT_TRACKS, ['internal', 'alpha'])
  const f = await fake(happy)
  try {
    const r = await publishAab({ aabFile: aab, sa, notes: 'n', version: '1.0', apiBase: f.base, tokenUri: `${f.base}/token`, request: req })
    assert.deepEqual(r.tracks, ['internal', 'alpha'])
    assert.equal(count(f.calls, /^POST \/androidpublisher\/v3\/applications\/[^/]+\/edits$/), 1, '只建一個編輯')
    assert.equal(count(f.calls, /^POST .*\/upload\/.*\/bundles/), 1, 'AAB 只傳一次')
    assert.equal(count(f.calls, /:commit$/), 1, '只提交一次')
    const puts = f.calls.filter(c => c.method === 'PUT')
    assert.deepEqual(puts.map(c => c.url.split('/').pop()), ['internal', 'alpha'])
    for (const p of puts) {
      assert.ok(p.url.includes('/edits/E1/'), '同一個編輯')
      assert.deepEqual(JSON.parse(p.body).releases[0].versionCodes, ['77'])
    }
    assert.ok(f.calls.findIndex(c => c.url.endsWith(':commit')) > f.calls.findLastIndex(c => c.method === 'PUT'), '兩條都設好才提交')
  } finally { await f.close() }
})

const putsOf = calls => calls.filter(c => c.method === 'PUT').map(c => `${c.url.split('/edits/')[1]}`)
const alpha403 = c => (c.url.endsWith('/tracks/alpha') ? [403, { error: { code: 403, message: `秘密 ${keyBody}`, status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } }] : null)
// 每次建編輯回不同代號，才分得出第一個與第二個編輯
const twoEdits = over => { let n = 0; return c => over(c) || (c.url.endsWith('/edits') && c.method === 'POST' ? [200, { id: `E${++n}` }] : happy(c)) }

test('alpha 失敗（403）：刪掉第一個編輯、另開第二個編輯只發 internal 並提交一次；結果標明封閉測試沒發成', async () => {
  const f = await fake(twoEdits(alpha403))
  const logs = []
  try {
    const r = await publishAab({ aabFile: aab, sa, notes: 'n', version: '1.0', apiBase: f.base, tokenUri: `${f.base}/token`, request: req, log: m => logs.push(m) })
    assert.deepEqual(r.tracks, ['internal'])
    assert.equal(r.versionCode, 77)
    assert.equal(r.editId, 'E2')
    assert.equal(r.alpha.status, 'failed')
    assert.equal(r.alpha.kind, 'permission')
    assert.match(r.alpha.message, /封閉測試.*Play Console/s)
    assert.ok(!/HTTP|403|forbidden|秘密/.test(r.alpha.message))
    assert.deepEqual(putsOf(f.calls), ['E1/tracks/internal', 'E1/tracks/alpha', 'E2/tracks/internal'])
    assert.equal(count(f.calls, /:commit$/), 1, '只提交一次')
    assert.ok(f.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/edits/E1')), '第一個編輯被刪')
    assert.ok(f.calls.find(c => c.url.endsWith('E2:commit')), '提交的是第二個編輯')
    assert.equal(count(f.calls, /^POST .*\/upload\/.*\/bundles/), 2, '新編輯要重傳 AAB')
    assert.ok(!logs.join('\n').includes('秘密'))
  } finally { await f.close() }
})

test('alpha 失敗：404（軌道不存在）與其他（例如送審中 400）都走降級；分類各自正確', async () => {
  for (const [status, kind] of [[404, 'notfound'], [400, 'other'], [401, 'permission']]) {
    const f = await fake(twoEdits(c => (c.url.endsWith('/tracks/alpha') ? [status, {}] : null)))
    try {
      const r = await publishAab({ aabFile: aab, sa, notes: 'n', apiBase: f.base, tokenUri: `${f.base}/token`, request: makeRequester({ retries: 0, backoffMs: 1 }) })
      assert.deepEqual(r.tracks, ['internal'])
      assert.equal(r.alpha.kind, kind)
      assert.equal(count(f.calls, /:commit$/), 1)
    } finally { await f.close() }
  }
})

test('internal 失敗（403）：整體失敗、沒有 commit、不再嘗試 alpha、不開第二個編輯', async () => {
  const f = await fake(twoEdits(c => (c.url.endsWith('/tracks/internal') ? [403, {}] : null)))
  try {
    await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', apiBase: f.base, tokenUri: `${f.base}/token`, request: req }), e => /內部測試/.test(e.message) && !/HTTP|403/.test(e.message))
    assert.equal(count(f.calls, /:commit$/), 0)
    assert.equal(count(f.calls, /\/tracks\/alpha$/), 0)
    assert.equal(count(f.calls, /^POST .*\/edits$/), 1, '只建一個編輯')
    assert.equal(f.calls.at(-1).method, 'DELETE')
  } finally { await f.close() }
})

test('降級後第二輪也失敗＝整體失敗：不提交', async () => {
  const f = await fake(twoEdits(c => (c.url.endsWith('/tracks/alpha') ? [403, {}] : c.url.includes('/E2/tracks/internal') ? [500, {}] : null)))
  try {
    await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', apiBase: f.base, tokenUri: `${f.base}/token`, request: makeRequester({ retries: 0, backoffMs: 1 }) }), /內部測試/)
    assert.equal(count(f.calls, /:commit$/), 0)
  } finally { await f.close() }
})

test('只指定 alpha 單軌道：alpha 失敗沒有別的軌道可發，整體失敗不降級', async () => {
  const f = await fake(twoEdits(alpha403))
  try {
    await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', tracks: ['alpha'], apiBase: f.base, tokenUri: `${f.base}/token`, request: req }), /封閉測試/)
    assert.equal(count(f.calls, /:commit$/), 0)
    assert.equal(count(f.calls, /^POST .*\/edits$/), 1)
  } finally { await f.close() }
})

test('兩條都成功：結果 alpha.status=ok；reportAlpha 寫 GITHUB_OUTPUT；失敗時寫 play-alpha annotation 與 summary', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gh-'))
  const env = { GITHUB_OUTPUT: path.join(dir, 'o'), GITHUB_STEP_SUMMARY: path.join(dir, 's') }
  const out = []
  reportAlpha({ status: 'ok' }, env, m => out.push(m))
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'alpha_status=ok\nalpha_kind=\n')
  assert.deepEqual(out, [])
  reportAlpha({ status: 'failed', kind: 'permission', message: '封閉測試沒發成' }, env, m => out.push(m))
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /alpha_status=failed\nalpha_kind=permission\n/)
  assert.match(out[0], /^::warning title=play-alpha::封閉測試沒發成$/)
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /play-alpha 告警[\s\S]*內部測試已照常發出/)
  reportAlpha(null, env, m => out.push(m))
  assert.equal(out.length, 1)
})

test('軌道名稱只能是小寫英文、數字、底線、減號：不合規在建編輯之前就擋下（含舊 track 參數）', async () => {
  for (const bad of ['../x', 'Alpha', 'a b', 'a/b', 'a?b', '', 'alpha;']) {
    for (const opt of [{ tracks: ['internal', bad] }, { track: bad }]) {
      if (!bad && opt.track !== undefined) continue   // 空字串的舊 track 參數等於沒給
      const f = await fake(happy)
      try {
        await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', apiBase: f.base, tokenUri: `${f.base}/token`, request: req, ...opt }), /軌道名稱只能用小寫英文、數字、底線或減號/)
        assert.equal(f.calls.length, 0, `${JSON.stringify(opt)} 不該有任何請求`)
      } finally { await f.close() }
    }
  }
  await assert.rejects(maxPlayCode({ sa, tracks: ['A/B'], request: req }), /軌道名稱/)
})

test('--check-only 的軌道檢查：用 tracks.get 看每條軌道在不在；查不到只警告、不算失敗、仍回最大版號', async () => {
  const warns = []
  const f = await fake(c => (c.method === 'GET' && c.url.endsWith('/bundles') ? [200, { bundles: [{ versionCode: 5 }] }] : c.method === 'GET' && c.url.endsWith('/tracks/alpha') ? [404, {}] : happy(c)))
  try {
    const max = await maxPlayCode({ sa, apiBase: f.base, tokenUri: `${f.base}/token`, request: req, tracks: DEFAULT_TRACKS, warn: m => warns.push(m) })
    assert.equal(max, 5)
    assert.equal(warns.length, 1)
    assert.match(warns[0], /封閉測試.*Play Console/s)
    assert.ok(f.calls.some(c => c.method === 'GET' && c.url.endsWith('/tracks/internal')))
    assert.equal(f.calls.at(-1).method, 'DELETE')
    assert.equal(count(f.calls, /:commit$/), 0)
  } finally { await f.close() }
})

test('單軌道舊行為：tracks 或舊參數 track 指定一條時只設那一條、只提交一次', async () => {
  for (const opt of [{ tracks: ['internal'] }, { track: 'internal' }]) {
    const f = await fake(happy)
    try {
      const r = await publishAab({ aabFile: aab, sa, notes: 'n', apiBase: f.base, tokenUri: `${f.base}/token`, request: req, ...opt })
      assert.deepEqual(r.tracks, ['internal'])
      assert.deepEqual(f.calls.filter(c => c.method === 'PUT').map(c => c.url.split('/').pop()), ['internal'])
      assert.equal(count(f.calls, /:commit$/), 1)
    } finally { await f.close() }
  }
  await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', tracks: [], request: req }), /軌道清單不可為空/)
})

test('換權杖失敗：只報狀態與 OAuth 錯誤代碼，沒有建立編輯', async () => {
  const f = await fake(() => [400, { error: 'invalid_grant', error_description: keyBody }])
  try {
    await assert.rejects(getAccessToken(sa, req, `${f.base}/token`), e => /HTTP 400，invalid_grant/.test(e.message) && !e.message.includes(keyBody))
  } finally { await f.close() }
})

test('重試：5xx 與網路錯誤會重試，4xx 不重試', async () => {
  let n = 0
  const f = await fake(() => (++n < 3 ? [503, {}] : [200, { ok: 1 }]))
  try {
    const r = await req('GET', `${f.base}/a`)
    assert.equal(r.status, 200)
    assert.equal(f.calls.length, 3)
  } finally { await f.close() }
  const g = await fake(() => [404, {}])
  try {
    assert.equal((await req('GET', `${g.base}/a`)).status, 404)
    assert.equal(g.calls.length, 1)
  } finally { await g.close() }
  let tries = 0
  const flaky = makeRequester({ retries: 2, backoffMs: 1, fetchFn: async () => { tries++; throw new TypeError('fetch failed') } })
  await assert.rejects(flaky('GET', 'http://127.0.0.1:1/'), /連線失敗/)
  assert.equal(tries, 3)
})

test('更新說明：取 CHANGELOG 最新一段；第一條就超長才截在 500 字', () => {
  assert.equal(releaseNotes('# t\n\n## 1.0（x）\n- 甲\n\n## 0.9（y）\n- 乙\n', '1.0'), '- 甲')
  assert.equal(releaseNotes('', '2.0'), 'ASN 2.0 更新')
  const long = releaseNotes(`## 1（x）\n- ${'字'.repeat(900)}`, '1')
  assert.equal(long.length, 500)
  assert.ok(long.endsWith('…'))
})

test('更新說明超長：截在整條結尾，不留半句，總長不超過 500', () => {
  const line = n => `- ${String(n).padStart(3, '0')}${'字'.repeat(95)}`   // 每條 100 字，加換行 101
  const lines = Array.from({ length: 8 }, (_, i) => line(i))
  const notes = releaseNotes(`## 1（x）\n${lines.join('\n')}`, '1')
  assert.equal(notes, `${lines.slice(0, 4).join('\n')}\n…`)
  assert.ok(notes.length <= 500, String(notes.length))
  for (const l of notes.split('\n').slice(0, -1)) assert.ok(lines.includes(l), '每一條都要完整')
})

test('更新說明長度邊界：剛好 500 不截；501 才截；結尾的「…」不會讓總長超過 500', () => {
  const sized = n => `- ${'甲'.repeat(240)}\n- ${'乙'.repeat(n - 245)}`   // 第一條 242 字＋換行＋第二條
  assert.equal(sized(500).length, 500)
  assert.equal(releaseNotes(`## 1（x）\n${sized(500)}`, '1'), sized(500))
  assert.equal(releaseNotes(`## 1（x）\n${sized(501)}`, '1'), `- ${'甲'.repeat(240)}\n…`)
  // 換行正好落在上限前後：整條能放下就留，放不下就退到前一條，總長都不超過 500
  for (const firstLen of [496, 497, 498, 499, 500]) {
    const first = `- ${'甲'.repeat(firstLen - 2)}`
    const notes = releaseNotes(`## 1（x）\n- 短\n${first}\n- 尾`, '1')
    assert.ok(notes.length <= 500, `${firstLen}：${notes.length}`)
    assert.ok(notes.endsWith('\n…'), `${firstLen} 要截在整條結尾`)
    for (const l of notes.split('\n').slice(0, -1)) assert.ok(l === '- 短' || l === first, `${firstLen} 不能有半句`)
  }
})

test('金鑰檔：缺檔給純中文設定說明、結束碼非 0；格式不對不洩漏內容', () => {
  const missing = path.join(tmp, 'nope.json')
  assert.throws(() => loadServiceAccount(missing), /找不到 Play 服務帳戶金鑰.*ASN_PLAY_SA_FILE/s)
  const bad = path.join(tmp, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ private_key: privateKey }))
  assert.throws(() => loadServiceAccount(bad), e => /缺少必要欄位/.test(e.message) && !e.message.includes(keyBody))
  assert.equal(loadServiceAccount(saFile).client_email, sa.client_email)
  const r = spawnSync(process.execPath, [path.join(here, '..', 'scripts', 'play-upload.mjs'), `--aab=${aab}`], { env: { ...process.env, ASN_PLAY_SA_FILE: missing }, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /上傳中止：找不到 Play 服務帳戶金鑰/)
  assert.ok(!(r.stdout + r.stderr).includes(keyBody))
})

// versionCode 規則（play-version.mjs）：有給 expectCode 就先查 Play 上最大值，不比它大不上傳；上傳回的值不同就不提交
const withBundles = (max, uploaded) => c => {
  if (c.method === 'GET' && c.url.endsWith('/edits/E1/bundles')) return [200, max == null ? {} : { bundles: [{ versionCode: 2005 }, { versionCode: max }] }]
  if (c.url.includes('/upload/') && c.url.includes('/bundles')) return [200, { versionCode: uploaded }]
  return happy(c)
}

test('expectCode：比 Play 上最大值大才上傳，流程多一步查詢，其餘照舊', async () => {
  const f = await fake(withBundles(2006, 20061))
  try {
    const r = await publishAab({ aabFile: aab, sa, notes: 'n', version: '0.2.6', expectCode: 20061, apiBase: f.base, tokenUri: `${f.base}/token`, request: req })
    assert.equal(r.versionCode, 20061)
    const seq = f.calls.map(c => `${c.method} ${c.url.split('?')[0]}`)
    assert.deepEqual(seq.slice(1, 4), [
      'POST /androidpublisher/v3/applications/tw.yooliang.asn/edits',
      'GET /androidpublisher/v3/applications/tw.yooliang.asn/edits/E1/bundles',
      'POST /upload/androidpublisher/v3/applications/tw.yooliang.asn/edits/E1/bundles',
    ])
    assert.ok(f.calls.some(c => c.url.endsWith(':commit')))
  } finally { await f.close() }
})

test('expectCode：沒比 Play 上最大值大就不上傳、清掉編輯；上傳回的值不同也不提交', async () => {
  const f = await fake(withBundles(20061, 20061))
  try {
    await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', expectCode: 20061, apiBase: f.base, tokenUri: `${f.base}/token`, request: req }), /沒有比 Play 上最大的 20061 大/)
    assert.ok(!f.calls.some(c => c.url.includes('/upload/')), '不上傳')
    assert.equal(f.calls.at(-1).method, 'DELETE')
  } finally { await f.close() }
  const g = await fake(withBundles(2006, 20060))
  try {
    await assert.rejects(publishAab({ aabFile: aab, sa, notes: 'n', expectCode: 20061, apiBase: g.base, tokenUri: `${g.base}/token`, request: req }), /不是預期的 20061/)
    assert.ok(!g.calls.some(c => c.url.endsWith(':commit')), '不提交')
  } finally { await g.close() }
})
