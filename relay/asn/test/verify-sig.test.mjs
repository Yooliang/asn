// tools/release/verify_sig.mjs（#1892 規格第 6 節第 9 點）：minisign 兩段驗證、file: 比對、反向驗證、與 latest.json 逐字相等。
// 黃金樣本是 Tauri 簽章工具用拋棄式金鑰產的（fixtures/sig/README.md）；另用 repo 真正的公鑰只做格式解析。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parsePubkey, parseSig, verifySig, reverseVerify, sigMatchesLatest, verifyAll, trustedFile, main } from '../../../tools/release/verify_sig.mjs'

const dir = new URL('./fixtures/sig/', import.meta.url)
const NAME = 'ASN_0.0.1_x64-setup.exe'
const exe = fs.readFileSync(new URL(NAME, dir))
const sigText = fs.readFileSync(new URL(`${NAME}.sig`, dir), 'utf8')
const pubkeyText = fs.readFileSync(new URL('throwaway.pub', dir), 'utf8').trim()
const base = { pubkeyText, sigText, fileBytes: exe, expectedFileName: NAME }

const unwrap = t => Buffer.from(t.trim(), 'base64').toString('utf8').trim().split('\n')
const wrap = ls => Buffer.from(`${ls.join('\n')}\n`, 'utf8').toString('base64')
const sigRaw = () => Buffer.from(unwrap(sigText)[1], 'base64')
const fails = (r, re) => { assert.equal(r.ok, false); assert.ok(r.problems.some(p => re.test(p)), r.problems.join('\n')) }

test('黃金樣本：通過，trusted comment 的 file: 就是安裝檔名', () => {
  const r = verifySig(base)
  assert.deepEqual(r, { ok: true, problems: [] })
  assert.equal(trustedFile(parseSig(sigText).trusted), NAME)
  assert.equal(parseSig(sigText).alg, 'ED')
})

test('黃金樣本：反向驗證通過（改檔案一位元組、改 trusted comment 一字都擋得住）', () => {
  assert.deepEqual(reverseVerify(base), { ok: true, problems: [] })
})

test('檔案改一個位元組：失敗', () => {
  const t = Buffer.from(exe); t[100] ^= 1
  fails(verifySig({ ...base, fileBytes: t }), /檔案簽章驗不過/)
})

test('trusted comment 改一個字：全域簽章失敗', () => {
  const ls = unwrap(sigText)
  ls[2] = ls[2].replace('version:0.0.1', 'version:0.0.2')
  fails(verifySig({ ...base, sigText: wrap(ls) }), /全域簽章驗不過/)
})

test('file: 不符：失敗（即使簽章本身是真的）', () => {
  fails(verifySig({ ...base, expectedFileName: 'ASN_0.0.2_x64-setup.exe' }), /file:/)
})

test('演算法標記改成 Ed（非預雜湊）：失敗', () => {
  const raw = sigRaw(); raw.write('Ed', 0, 'latin1')
  const ls = unwrap(sigText); ls[1] = raw.toString('base64')
  fails(verifySig({ ...base, sigText: wrap(ls) }), /預雜湊的 ED/)
})

test('金鑰 ID 與公鑰不同：失敗', () => {
  const raw = sigRaw(); raw[3] ^= 1
  const ls = unwrap(sigText); ls[1] = raw.toString('base64')
  fails(verifySig({ ...base, sigText: wrap(ls) }), /金鑰 ID/)
})

test('換成別把公鑰、壞格式：都回失敗、不拋例外', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).plugins.updater.pubkey
  fails(verifySig({ ...base, pubkeyText: real }), /金鑰 ID/)
  fails(verifySig({ ...base, sigText: 'not base64!!' }), /base64/)
  fails(verifySig({ ...base, pubkeyText: 'AAAA' }), /公鑰/)
  fails(verifySig({ ...base, fileBytes: Buffer.alloc(0) }), /空的/)
})

test('反向驗證：原樣就驗不過時不會假裝通過', () => {
  const t = Buffer.from(exe); t[1] ^= 1
  fails(reverseVerify({ ...base, fileBytes: t }), /反向驗證沒有意義/)
})

test('.sig 與 latest.json 的 signature 欄：逐字相等才過', () => {
  const sig = sigText.trim()
  const latest = s => ({ platforms: { 'windows-x86_64': { signature: s, url: 'u' } } })
  assert.equal(sigMatchesLatest({ sigText, latest: latest(sig) }).ok, true)
  assert.equal(sigMatchesLatest({ sigText: `${sig}\n`, latest: latest(sig) }).ok, true)
  fails(sigMatchesLatest({ sigText, latest: latest(`${sig}\n`) }), /逐字/)
  fails(sigMatchesLatest({ sigText, latest: latest(sig.slice(0, -4) + 'AAAA') }), /逐字/)
  fails(sigMatchesLatest({ sigText, latest: {} }), /沒有/)
  assert.equal(verifyAll({ ...base, latest: latest(sig) }).ok, true)
  fails(verifyAll({ ...base, latest: latest('x') }), /逐字/)
})

test('repo 真正的公鑰：只做格式解析（base64 外殼、42 位元組、Ed）', () => {
  const conf = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const p = parsePubkey(conf.plugins.updater.pubkey)
  assert.deepEqual(p.problems, [])
  assert.equal(p.keyId.length, 8)
  assert.equal(p.key.asymmetricKeyType, 'ed25519')
  // 壞例子：把演算法標記改掉要被擋
  const ls = unwrap(conf.plugins.updater.pubkey)
  const raw = Buffer.from(ls[1], 'base64'); raw.write('ED', 0, 'latin1'); ls[1] = raw.toString('base64')
  assert.ok(parsePubkey(wrap(ls)).problems.length > 0)
})

test('CLI：通過回 0、缺參數回 2、壞檔回 1', () => {
  const out = []
  const files = { 'c.json': JSON.stringify({ plugins: { updater: { pubkey: pubkeyText } } }), [NAME]: exe, 's.sig': sigText }
  const readFile = p => { const k = String(p); if (!(k in files)) throw new Error('無此檔'); return Buffer.from(files[k]) }
  assert.equal(main(['--conf', 'c.json', '--exe', NAME, '--sig', 's.sig'], { readFile, log: m => out.push(m) }), 0)
  assert.equal(main([], { readFile, log: m => out.push(m) }), 2)
  assert.equal(main(['--conf', 'x', '--exe', NAME, '--sig', 's.sig'], { readFile, log: m => out.push(m) }), 1)
})

test('真實的 0.2.36 簽章（latest.json 裡 Tauri 簽出來的）：格式解得開、ED、金鑰 ID 與 tauri.conf.json 的公鑰相同、file: 對得上', () => {
  const conf = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const latest = JSON.parse(fs.readFileSync(new URL('../../../site/public/update/latest.json', import.meta.url), 'utf8'))
  const s = parseSig(latest.platforms['windows-x86_64'].signature)
  assert.deepEqual(s.problems, [])
  assert.equal(s.alg, 'ED')
  assert.ok(s.keyId.equals(parsePubkey(conf.plugins.updater.pubkey).keyId))
  assert.equal(trustedFile(s.trusted), 'ASN_' + latest.version + '_x64-setup.exe')
})
