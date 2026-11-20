// #1892 補充定案：上傳金鑰硬擋。帶 --upload（或 CI 設 ASN_REQUIRE_UPLOAD_KEY=1）時，金鑰資料夾缺正式 upload.jks／密碼檔就結束碼非 0，
// 絕不呼叫 keytool 產新金鑰；不帶時（演練、本機第一次建置）行為不變。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requireUploadKey, uploadKeyProblem } from '../scripts/release-android-lib.mjs'

const script = new URL('../scripts/release-play.mjs', import.meta.url)
const scriptPath = script.pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n')

test('requireUploadKey：帶 --upload 或 ASN_REQUIRE_UPLOAD_KEY=1 才要求；其他值不算', () => {
  assert.equal(requireUploadKey(['--upload'], {}), true)
  assert.equal(requireUploadKey([], { ASN_REQUIRE_UPLOAD_KEY: '1' }), true)
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(requireUploadKey([], { ASN_REQUIRE_UPLOAD_KEY: v }), false, String(v))
  assert.equal(requireUploadKey(['--test'], {}), false)
})

test('uploadKeyProblem：要求時缺任一檔都回錯誤、兩個都在才放行；不要求時一律 null（維持自動產生的舊行為）', () => {
  const k = 'D:/k'
  assert.match(uploadKeyProblem({ required: true, hasKeystore: false, hasPassFile: false, keyDir: k }), /upload\.jks、upload\.jks\.password/)
  assert.match(uploadKeyProblem({ required: true, hasKeystore: false, hasPassFile: true, keyDir: k }), /upload\.jks/)
  assert.match(uploadKeyProblem({ required: true, hasKeystore: true, hasPassFile: false, keyDir: k }), /upload\.jks\.password/)
  assert.equal(uploadKeyProblem({ required: true, hasKeystore: true, hasPassFile: true, keyDir: k }), null)
  assert.equal(uploadKeyProblem({ required: false, hasKeystore: false, hasPassFile: false, keyDir: k }), null)
})

test('release-play.mjs：硬擋在 keytool 與產生金鑰之前（至少命中 1 次）', () => {
  const iBlock = src.indexOf('if (keyProblem) fail(keyProblem)')
  const iGen = src.indexOf('-genkeypair')
  assert.ok(iBlock > 0 && iGen > 0, '找不到硬擋或產生金鑰的程式，規則可能失效')
  assert.ok(iBlock < iGen, '硬擋要在 keytool 產生金鑰之前')
  assert.ok(src.includes("requireUploadKey(process.argv.slice(2), process.env)"))
})

// 真的跑腳本：--skip-smoke 避開冒煙、假的 JAVA_HOME 讓它走到金鑰那一步；空資料夾裡若出現任何檔就代表它動手產金鑰了
const runWith = (args, env) => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-key-'))
  const javaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-java-'))
  const r = spawnSync(process.execPath, [scriptPath, '--skip-smoke', ...args], {
    encoding: 'utf8', env: { ...process.env, JAVA_HOME: javaHome, ASN_PLAY_KEY_DIR: keyDir, ...env }, timeout: 60000,
  })
  const left = fs.readdirSync(keyDir)
  fs.rmSync(keyDir, { recursive: true, force: true })
  fs.rmSync(javaHome, { recursive: true, force: true })
  return { r, left }
}

test('實跑：--upload 且金鑰資料夾是空的 → 結束碼非 0、講明缺檔、資料夾仍是空的（沒產金鑰）', () => {
  const { r, left } = runWith(['--upload'], {})
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /缺正式的 upload\.jks/)
  assert.deepEqual(left, [], '不該產生任何金鑰檔')
})

test('實跑：不帶 --upload 但 ASN_REQUIRE_UPLOAD_KEY=1（CI 正式建置）→ 同樣中止', () => {
  const { r, left } = runWith([], { ASN_REQUIRE_UPLOAD_KEY: '1' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /缺正式的 upload\.jks/)
  assert.deepEqual(left, [])
})
