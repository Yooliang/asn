// 雲端代理金鑰目錄的預設位置（#14 R2，與 machine/home.mjs 同一套規則）。全部用暫存資料夾與假環境，不碰真的資料夾。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../config.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-cloud-keydir-'))
const keyDir = (root, extra = {}) => resolveConfig({ ASN_CLOUD_HOME: root, ...extra }).keyDir

test('全新：<根>/.asn；只有舊 <根>/.irori-relay：沿用舊的', () => {
  const a = tmp()
  assert.equal(keyDir(a), path.join(a, '.asn'))
  const b = tmp(); fs.mkdirSync(path.join(b, '.irori-relay'))
  assert.equal(keyDir(b), path.join(b, '.irori-relay'))
})

test('兩邊都有：舊的有內容（尚未遷移）用舊的；舊的是空的或連結用新的', () => {
  const a = tmp()
  fs.mkdirSync(path.join(a, '.asn')); fs.mkdirSync(path.join(a, '.irori-relay'))
  fs.writeFileSync(path.join(a, '.irori-relay', 'grok.key'), 'fake')
  assert.equal(keyDir(a), path.join(a, '.irori-relay'))
  const b = tmp(); fs.mkdirSync(path.join(b, '.asn')); fs.mkdirSync(path.join(b, '.irori-relay'))
  assert.equal(keyDir(b), path.join(b, '.asn'))
  const c = tmp(); fs.mkdirSync(path.join(c, '.asn')); fs.symlinkSync(path.join(c, '.asn'), path.join(c, '.irori-relay'), 'junction')
  assert.equal(keyDir(c), path.join(c, '.asn'))
})

test('ASN_HOME（舊名 IRORI_HOME）與 ASN_CLOUD_KEY_DIR 覆寫；後者優先', () => {
  const a = tmp(); const x = path.join(a, 'x'); const y = path.join(a, 'y')
  assert.equal(keyDir(a, { ASN_HOME: x }), x)
  assert.equal(keyDir(a, { IRORI_HOME: x }), x)
  assert.equal(keyDir(a, { ASN_HOME: x, ASN_CLOUD_KEY_DIR: y }), y)
})
