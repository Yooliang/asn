// 登入端到端（綁定）：只斷言送給後台的請求與本機檔案的四條，不拍逐頁籤截圖（noTabs），不然每條多跑二十幾秒（#1991）。
// 需要先 `npm run build`；找不到 exe 就略過。login.test.mjs 原本整支擠在一個 120 秒的檔案上限裡（#1991），端到端依主題拆成兩支，各自一份時間。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultExe, hooksExe, hooksExeSkip, runShot } from '../scripts/shot.mjs'

const e2eOpts = { skip: !fs.existsSync(defaultExe) && '先執行 npm run build', timeout: 120_000 }
// 要設 ASN_SHOT_LOGIN 的情境只有 test-hooks 版 exe 讀得到（正式版讀不到，#2163 PR-3b）；CI 設 ASN_E2E_REQUIRE_HOOKS=1，找不到就紅而不是略過
const hooksOpts = { skip: hooksExeSkip(), timeout: 120_000 }
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// noTabs 的證據：沒有任何逐頁籤（tabs-*，登入畫面那張 tabs-login 除外）與分離視窗（panel-*）的截圖檔。拿掉 noTabs，這條就紅
const assertNoTabShots = r => assert.deepEqual(r.files.filter(f => /^(tabs-(?!login)|panel-)/.test(f)), [], 'noTabs 不該拍逐頁籤截圖')
const tmpOut = tag => fs.mkdtempSync(path.join(os.tmpdir(), `asn-e2e-${tag}-`))

test('已有金鑰、選了暫時不登入：照舊進名單，不打帳號 API', e2eOpts, async () => {
  const r = await runShot(tmpOut('key-skipped'), defaultExe, { login: 'skipped', noTabs: true })
  assert.equal(r.code, 0, r.log)
  assertNoTabShots(r)
  assert.equal(r.relay.reqs.filter(q => ['account_bootstrap', 'node_claim', 'node_create'].includes(q.action)).length, 0)
  assert.ok(r.relay.reqs.some(q => q.action === 'list'), '有進名單')
})

test('已登入的舊電腦：啟動後自動 node_claim 綁到帳號（帶登入憑證與現有金鑰），金鑰檔不動', hooksOpts, async () => {
  const r = await runShot(tmpOut('auto-bind'), hooksExe, { login: 'user@example.com', timeoutMs: 120_000, noTabs: true })
  assert.equal(r.code, 0, r.log)
  assertNoTabShots(r)
  const claim = r.relay.reqs.find(q => q.action === 'node_claim')
  assert.ok(claim, `沒有送 node_claim：${r.relay.reqs.map(q => q.action)}`)
  assert.match(claim.auth, /^Bearer \S+/)
  assert.equal(claim.key, 'fake-machine-key')
  assert.ok(r.relay.reqs.some(q => q.action === 'list'), '有進名單')
  assert.ok(!r.relay.reqs.some(q => q.action === 'node_create'), '已有金鑰就不建新節點')
  const home = path.join(r.home, '.asn')
  assert.ok(!fs.existsSync(home) || !fs.readdirSync(home).some(f => f.endsWith('.key') || f === 'node'), '沒有寫任何金鑰檔')
})

test('綁定失敗（舊租戶還沒被認領）不擋使用：照常進名單', hooksOpts, async () => {
  const r = await runShot(tmpOut('bind-fail'), hooksExe, { login: 'user@example.com', claim: 'tenant_not_yours', noTabs: true })
  assert.equal(r.code, 0, r.log)
  assertNoTabShots(r)
  assert.ok(r.relay.reqs.some(q => q.action === 'node_claim'), '有試著綁')
  assert.ok(r.relay.reqs.some(q => q.action === 'list'), '照常進名單')
  assert.ok(r.relay.sent.length >= 1, '照常能寄信')
})

test('沒有金鑰的新電腦登入後：自動 node_create，把新金鑰寫進本機檔案', hooksOpts, async () => {
  const r = await runShot(tmpOut('new-pc'), hooksExe, { noKey: true, login: 'user@example.com', noTabs: true })
  assert.equal(r.code, 0, r.log)
  assertNoTabShots(r)
  const create = r.relay.reqs.find(q => q.action === 'node_create')
  assert.ok(create, `沒有送 node_create：${r.relay.reqs.map(q => q.action)}`)
  assert.match(create.auth, /^Bearer \S+/)
  assert.ok(!r.relay.reqs.some(q => q.action === 'node_claim'))
  const home = path.join(r.home, '.asn')
  assert.equal(fs.readFileSync(path.join(home, 't1-newnode01.key'), 'utf8'), 'fake-new-node-key')
  assert.equal(fs.readFileSync(path.join(home, 'node'), 'utf8'), 't1-newnode01')
})

test('#1991 noTabs 的接線：shot.mjs 寫進設定檔，名單頁照它跳過逐頁籤截圖迴圈（不靠 exe，沒建置也會跑）', () => {
  assert.ok(read('scripts/shot.mjs').includes('noTabs ? { ...(me ?? {}), shotNoTabs: true } : me'))
  assert.ok(read('ui/list.js').includes("savedMe.shotNoTabs ? [] : [['local'"))
})
