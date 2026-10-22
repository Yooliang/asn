// #14 R5 字串改名的相容測試：新名為主、舊名仍可用（D10）。
// 執行：node --test relay/machine/test/compat-names.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasMark } from '../engines/codex.mjs'
import { registerNode, checkNode } from '../register.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('Codex 信件標記：寫入用 asn-mail:，讀取新舊兩種都認', () => {
  assert.ok(hasMark('請看一下\n\n（asn-mail:abc｜說明）', 'abc'), '新標記')
  assert.ok(hasMark('請看一下\n\n（irori-mail:abc）', 'abc'), '舊版橋寫的標記仍要認得')
  assert.ok(!hasMark('（asn-mail:abd）', 'abc'), '別封信的編號不能誤認')
  assert.ok(!hasMark('沒有標記', 'abc'))
})

test('安裝小幫手的使用者代理字串是 asn-installer/1', async () => {
  const seen = []
  const fetchImpl = async (url, opts) => { seen.push(opts.headers['user-agent']); return { status: 401, json: async () => ({}) } }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-compat-'))
  await registerNode({ baseUrl: 'http://127.0.0.1:1', invite: 'x', id: 'T', name: 'T', machine: 'T', home, fetchImpl }).catch(() => {})
  await checkNode({ baseUrl: 'http://127.0.0.1:1', id: 'T', home, fetchImpl }).catch(() => {})
  assert.ok(seen.length >= 1, '至少打了一次請求')
  for (const ua of seen) assert.equal(ua, 'asn-installer/1')
})
