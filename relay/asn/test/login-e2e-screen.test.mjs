// 登入端到端（畫面）：要驗登入畫面截圖的三條——新電腦、已有金鑰還沒登入、上次登入。
// 需要先 `npm run build`；找不到 exe 就略過。login.test.mjs 原本整支擠在一個 120 秒的檔案上限裡（#1991），端到端依主題拆成兩支，各自一份時間。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultExe, runShot, shotCaptureSupported } from '../scripts/shot.mjs'
import { assertShotNotBlank } from './shot-png.mjs'
import { demoUploadUrl } from './png.mjs'

const e2eOpts = { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }
const tmpOut = tag => fs.mkdtempSync(path.join(os.tmpdir(), `asn-e2e-${tag}-`))

test('沒有節點金鑰的新電腦：只截登入畫面，不連真實後台、不寄任何帶金鑰的請求', { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-e2e-login-'))
  const r = await runShot(out, defaultExe, { noKey: true })
  assert.equal(r.code, 0, r.log)
  assert.equal(r.relay.reqs.length, 0, '登入畫面階段不打節點 API')
  assert.ok(!fs.existsSync(path.join(r.home, '.asn')), '沒登入就不建立任何金鑰檔')
  if (shotCaptureSupported) {
    assert.ok(r.files.includes('tabs-login.png'), `缺登入畫面截圖：${r.files}`)
    assertShotNotBlank(path.join(out, 'tabs-login.png'), { minBytes: 4000 })
  }
})

test('已有金鑰、還沒登入：停在登入畫面（有「暫時不登入」），不進名單、不打帳號與節點 API', e2eOpts, async () => {
  const out = tmpOut('key-unsigned')
  const r = await runShot(out, defaultExe, { login: 'none' })
  assert.equal(r.code, 0, r.log)
  assert.equal(r.relay.reqs.filter(q => ['account_bootstrap', 'node_claim', 'node_create'].includes(q.action)).length, 0, '沒登入就不打帳號 API')
  if (shotCaptureSupported) {
    assert.ok(r.files.includes('tabs-login.png'), `缺登入畫面截圖：${r.files}`)
    assert.ok(!r.files.includes('tabs-local.png') && !r.files.some(f => f.startsWith('tabs-chat')), '不該進名單')
    assertShotNotBlank(path.join(out, 'tabs-login.png'), { minBytes: 4000 })
  }
})

test('上次登入的畫面：登入過會在 Google 那顆標上次使用並顯示記住的頭像', { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-e2e-lastlogin-'))
  const r = await runShot(out, defaultExe, { login: 'none', lastLogin: { provider: 'google', account_avatar: demoUploadUrl() } })
  assert.equal(r.code, 0, r.log)
  assert.equal(r.relay.reqs.filter(q => ['account_bootstrap', 'node_claim', 'node_create'].includes(q.action)).length, 0)
  if (shotCaptureSupported) assertShotNotBlank(path.join(out, 'tabs-login.png'), { minBytes: 4000 })
})
