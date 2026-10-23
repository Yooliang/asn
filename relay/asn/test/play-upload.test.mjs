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
import { getAccessToken, loadServiceAccount, makeJwt, makeRequester, publishAab, releaseNotes } from '../scripts/play-upload.mjs'

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
      'POST /androidpublisher/v3/applications/tw.yooliang.asn/edits/E1:commit',
    ])
    const [tok, , up, tr, cm] = f.calls
    assert.match(tok.body.toString(), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=[\w-]+\.[\w-]+\.[\w-]+/)
    assert.equal(up.url.split('?')[1], 'uploadType=media')
    assert.equal(up.headers.authorization, 'Bearer tok123')
    assert.deepEqual(up.body, fs.readFileSync(aab))
    assert.deepEqual(JSON.parse(tr.body), { track: 'internal', releases: [{ name: '9.9.9', versionCodes: ['77'], status: 'completed', releaseNotes: [{ language: 'zh-TW', text: '- 新功能' }] }] })
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
        assert.match(e.message, /HTTP 403，forbidden/)
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

test('更新說明：取 CHANGELOG 最新一段，超長截斷到 500 字', () => {
  assert.equal(releaseNotes('# t\n\n## 1.0（x）\n- 甲\n\n## 0.9（y）\n- 乙\n', '1.0'), '- 甲')
  assert.equal(releaseNotes('', '2.0'), 'ASN 2.0 更新')
  assert.equal(releaseNotes(`## 1（x）\n- ${'字'.repeat(900)}`, '1').length, 500)
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
