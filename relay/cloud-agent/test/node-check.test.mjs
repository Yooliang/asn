// #832：啟動時金鑰對到的節點和設定的不同、或身分變數新舊兩組不同，就停下來，不用別的節點身分回報名單或收信。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { IDENTITY_ENV, NODE_CHECK_EXIT, identityEnvConflict, nodeMismatch } from '../node-check.mjs'
import { applyEnvCompat } from '../env-compat.mjs'

test('節點相同、或後台沒回節點：不擋', () => {
  assert.equal(nodeMismatch('grok', 'grok'), null)
  assert.equal(nodeMismatch('grok', undefined), null)
  assert.equal(nodeMismatch('grok', ''), null)
})

test('金鑰對到別的節點：要停，原因寫出兩個節點、不含金鑰', () => {
  const why = nodeMismatch('grok', 't5-abcd1234')
  assert.match(why, /grok/)
  assert.match(why, /t5-abcd1234/)
  assert.match(why, /停下來/)
})

test('身分變數新舊兩組不同才停；其他變數不同只記紀錄', () => {
  assert.deepEqual(IDENTITY_ENV, ['ASN_RELAY_ID', 'ASN_RELAY_KEY'])
  const both = applyEnvCompat({ ASN_RELAY_ID: 'a', IRORI_RELAY_ID: 'b' })
  assert.match(identityEnvConflict(both), /ASN_RELAY_ID/)
  const key = applyEnvCompat({ ASN_RELAY_KEY: 'k1', IRORI_RELAY_KEY: 'k2' })
  const why = identityEnvConflict(key)
  assert.match(why, /ASN_RELAY_KEY/)
  assert.ok(!why.includes('k1') && !why.includes('k2'), '不能印出金鑰')
  assert.equal(identityEnvConflict(applyEnvCompat({ ASN_RELAY_ID: 'a', IRORI_RELAY_ID: 'a' })), null, '相同不擋')
  assert.equal(identityEnvConflict(applyEnvCompat({ ASN_CLOUD_ENGINE: 'x', IRORI_CLOUD_ENGINE: 'y' })), null, '非身分變數不擋')
  assert.equal(NODE_CHECK_EXIT, 4)
})

test('recv.mjs：先檢查節點、通過後才回報名單與接門鈴；身分變數衝突在拿金鑰前就停', () => {
  const src = fs.readFileSync(new URL('../recv.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const main = src.slice(src.indexOf('export async function main('))
  const at = s => { const i = main.indexOf(s); assert.ok(i > 0, s); return i }
  assert.ok(at('identityEnvConflict(compat)') < at('readKey(cfg, env)'))
  assert.ok(at('nodeMismatch(cfg.node, w.node)') < at('core.connectBell('))
  assert.ok(at('nodeMismatch(cfg.node, w.node)') < at('void rx.rosterOnce()'), '名單要在確認節點之後才回報')
})
