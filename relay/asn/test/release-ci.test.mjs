// scripts/release-ci.mjs 的純函式（#1892）：CI 建置入口不接受略過冒煙、tauri 參數固定帶 --locked 與不簽章設定、SHA256SUMS 格式
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NOSIGN_CONFIG, installerProblem, parseCiArgs, sha256SumsText, tauriBuildArgs } from '../scripts/release-ci.mjs'
import { wezTermReleaseGuard } from '../scripts/fetch-wezterm.mjs'

test('parseCiArgs：--skip-smoke 一律拒絕，不認得的旗標拒絕，--out 要有值', () => {
  assert.match(parseCiArgs(['--skip-smoke']).error, /--skip-smoke/)
  assert.match(parseCiArgs(['--out', 'x', '--skip-smoke']).error, /--skip-smoke/)
  assert.match(parseCiArgs(['--dry-run']).error, /不認得/)
  assert.match(parseCiArgs(['--out']).error, /資料夾/)
  assert.deepEqual(parseCiArgs([]), { out: null })
  assert.deepEqual(parseCiArgs(['--out', 'dist']), { out: 'dist' })
})

test('tauriBuildArgs：只出 NSIS、用不簽章設定、Cargo 帶 --locked', () => {
  const a = tauriBuildArgs('tauri.js')
  assert.deepEqual(a.slice(0, 5), ['tauri.js', 'build', '--bundles', 'nsis', '--config'])
  assert.equal(a[5], NOSIGN_CONFIG)
  assert.deepEqual(a.slice(6), ['--', '--locked'])
})

test('不簽章設定檔真的把 createUpdaterArtifacts 關掉（沒有簽章金鑰也能建）', () => {
  const conf = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.nosign.conf.json', import.meta.url), 'utf8'))
  assert.equal(conf.bundle.createUpdaterArtifacts, false)
})

test('sha256SumsText：sha256sum 相容格式、依檔名排序、結尾換行；空輸入是空字串', () => {
  const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64)
  assert.equal(sha256SumsText([{ name: 'z.exe', sha256: h2 }, { name: 'a.exe', sha256: h1 }]), `${h1}  a.exe\n${h2}  z.exe\n`)
  assert.equal(sha256SumsText([]), '')
})

test('installerProblem：不存在與空檔都回訊息，正常回 null', () => {
  assert.match(installerProblem('x.exe', () => { throw new Error('ENOENT') }), /沒產出/)
  assert.match(installerProblem('x.exe', () => ({ size: 0 })), /空的/)
  assert.equal(installerProblem('x.exe', () => ({ size: 5 })), null)
})

test('CI 入口擋 ASN_SKIP_WEZTERM（不管值是什麼）', () => {
  assert.ok(wezTermReleaseGuard({ ASN_SKIP_WEZTERM: '' }))
  assert.equal(wezTermReleaseGuard({}), null)
})

test('release-ci.mjs 不 import release.mjs、不讀簽章金鑰、不寫官網檔', () => {
  const src = fs.readFileSync(new URL('../scripts/release-ci.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(src, /from\s+['"]\.\/release\.mjs['"]/)
  assert.doesNotMatch(src, /TAURI_SIGNING_PRIVATE_KEY|asn\.key|ASN_UPDATER_KEY/)
  assert.doesNotMatch(src, /latest\.json|index\.html/)
})
