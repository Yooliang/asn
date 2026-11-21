// tools/release/ci_verify_sig.mjs（#2022 ②-1）：正確通過；安裝檔被改、公鑰不符、簽章前後雜湊不一致都驗不過。
// 樣本與 verify-sig.test.mjs 共用：拋棄式金鑰產的黃金樣本（fixtures/sig/README.md），不用任何正式金鑰。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { ciVerify, main } from '../../../tools/release/ci_verify_sig.mjs'

const dir = new URL('./fixtures/sig/', import.meta.url)
const NAME = 'ASN_0.0.1_x64-setup.exe'
const exe = fs.readFileSync(new URL(NAME, dir))
const sigText = fs.readFileSync(new URL(`${NAME}.sig`, dir), 'utf8')
const pubkeyText = fs.readFileSync(new URL('throwaway.pub', dir), 'utf8').trim()
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const base = { pubkeyText, sigText, fileBytes: exe, expectedFileName: NAME, beforeSha: sha(exe) }
const fails = (r, re) => { assert.equal(r.ok, false); assert.ok(r.problems.some(p => re.test(p)), r.problems.join('\n')) }

test('正確的簽章通過', () => {
  assert.deepEqual(ciVerify(base), { ok: true, problems: [] })
})

test('安裝檔被改一個位元組：驗不過', () => {
  const t = Buffer.from(exe); t[10] ^= 1
  fails(ciVerify({ ...base, fileBytes: t, beforeSha: sha(t) }), /檔案簽章驗不過/)
})

test('公鑰不符（換成 repo 真正的公鑰，只讀公鑰）：驗不過', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).plugins.updater.pubkey
  fails(ciVerify({ ...base, pubkeyText: real }), /金鑰 ID/)
})

test('簽章前後 sha256 不一致、或格式不對：驗不過', () => {
  fails(ciVerify({ ...base, beforeSha: sha(Buffer.from('別的檔')) }), /sha256 不一致/)
  fails(ciVerify({ ...base, beforeSha: 'abc' }), /64 位/)
  fails(ciVerify({ ...base, beforeSha: undefined }), /64 位/)
})

test('檔名與 trusted comment 的 file: 不符：驗不過', () => {
  fails(ciVerify({ ...base, expectedFileName: 'ASN_0.0.2_x64-setup.exe' }), /file:/)
})

test('main：通過回 0、缺參數回 2、竄改回 1；公鑰從 --conf 的 plugins.updater.pubkey 讀', () => {
  const files = {
    'c.json': JSON.stringify({ plugins: { updater: { pubkey: pubkeyText } } }),
    [NAME]: exe, [`${NAME}.sig`]: sigText,
  }
  const out = []
  const run = (argv, over = {}) => main(argv, { readFile: p => Buffer.from(over[p] ?? files[p]), log: m => out.push(m) })
  const args = ['--conf', 'c.json', '--exe', NAME, '--before-sha', sha(exe)]
  assert.equal(run(args), 0)
  assert.equal(run([]), 2)
  const t = Buffer.from(exe); t[5] ^= 1
  assert.equal(run(args, { [NAME]: t }), 1)
  assert.equal(run(['--conf', 'nope.json', '--exe', NAME, '--before-sha', sha(exe)], { 'nope.json': 'not json' }), 1)
  assert.ok(out.join('\n').includes('CI 驗簽通過'))
})
