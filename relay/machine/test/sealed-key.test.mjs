// 電腦版節點金鑰加密保存（desk-node-key-protect，0.2.20／0.2.21）：Node 腳本讀到加密的金鑰檔（ak1: 開頭）時，
// 不把它當金鑰送出去，直接說清楚改用 asn-cli 或設 ASN_RELAY_KEY；ASN_RELAY_KEY 照舊優先；明文檔照舊。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Fail, SEALED_KEY_MSG, SEALED_PREFIX, keyFromFileText } from '../identity.mjs'

const MACHINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-sealed-test-'))
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }

test('金鑰檔的內容：明文照舊（去頭尾空白）；加密的（ak1:）丟明確的錯誤，說要改用 asn-cli 或 ASN_RELAY_KEY', () => {
  assert.equal(SEALED_PREFIX, 'ak1:', '和 Rust 的 secret_file 同一個前綴')
  assert.equal(keyFromFileText(' plain-key\r\n'), 'plain-key')
  assert.equal(keyFromFileText(''), '')
  assert.equal(keyFromFileText(undefined), '')
  assert.throws(() => keyFromFileText('ak1:\x01\x02binary'), e => e instanceof Fail && e.code === 1 && e.message === SEALED_KEY_MSG)
  assert.throws(() => keyFromFileText('  ak1:xx\n'), e => e.message === SEALED_KEY_MSG, '前後有空白也認得')
  for (const w of ['asn-cli', 'ASN_RELAY_KEY', '加密保存']) assert.ok(SEALED_KEY_MSG.includes(w), w)
  assert.match(SEALED_KEY_MSG, /%LOCALAPPDATA%\\ASN\\asn-cli\.exe/)
})

test('實際跑：金鑰檔是加密的 → 結束並印出說明，不送出；設了 ASN_RELAY_KEY 照用', () => {
  const run = (home, extraEnv = {}) => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, ASN_HOME: path.join(home, '.asn'), ...extraEnv }
    const code = "import('" + path.join(MACHINE, 'identity.mjs').replace(/\\/g, '/').replace(/^/, 'file:///') + "').then(m=>{try{process.stdout.write(m.readMachineKey('H'))}catch(e){process.stderr.write(e.message);process.exit(e.code||9)}})"
    return spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', windowsHide: true })
  }
  const h = tmp(); put(path.join(h, '.asn', 'H.key'), 'ak1:' + 'x'.repeat(40))
  const r = run(h)
  assert.equal(r.status, 1); assert.equal(r.stdout, '', '沒有把加密內容當金鑰印出或送出'); assert.equal(r.stderr, SEALED_KEY_MSG)
  const ok = run(h, { ASN_RELAY_KEY: 'env-key' })
  assert.equal(ok.status, 0, ok.stderr); assert.equal(ok.stdout, 'env-key', 'ASN_RELAY_KEY 優先，不讀檔')
  const p = tmp(); put(path.join(p, '.asn', 'H.key'), 'plain-key\n')
  const pr = run(p)
  assert.equal(pr.status, 0, pr.stderr); assert.equal(pr.stdout, 'plain-key', '明文檔照舊')
})

test('守門：relay/machine 讀節點金鑰統一走 identity.mjs（readMachineKey／keyFromFileText），不直接讀 <節點>.key（anon.key 不是秘密，不在此限）', () => {
  const skip = new Set(['identity.mjs'])
  const bad = []
  for (const f of fs.readdirSync(MACHINE).filter(n => n.endsWith('.mjs') && !skip.has(n))) {
    const src = fs.readFileSync(path.join(MACHINE, f), 'utf8')
    for (const line of src.split('\n')) {
      if (/readFileSync\([^)]*\.key[`'"]/.test(line) && !/anon\.key/.test(line)) bad.push(`${f}: ${line.trim().slice(0, 80)}`)
    }
  }
  assert.deepEqual(bad, [], '直接讀金鑰檔的地方要改走 readMachineKey')
  for (const f of ['bridge.mjs', 'bridge-aegis.mjs', 'tools-provision.mjs', 'tools-roster-once.mjs', 'tools-roundtrip.mjs']) assert.match(fs.readFileSync(path.join(MACHINE, f), 'utf8'), /readMachineKey\(/, f)
  assert.match(fs.readFileSync(path.join(MACHINE, 'register.mjs'), 'utf8'), /return keyFromFileText\(text\)/)
  for (const f of ['bridge.mjs', 'bridge-aegis.mjs']) assert.match(fs.readFileSync(path.join(MACHINE, f), 'utf8'), /if \(e\?\.message === SEALED_KEY_MSG\) \{ console\.error\(e\.message\); process\.exit\(2\) \}/, f + '：加密的金鑰檔印說明並停下')
})
