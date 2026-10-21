// env.mjs 與 preflight.mjs（只用暫存目錄與假後端）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backendHostCode, cloudToolPaths, pathsShellLines, main as envMain } from '../env.mjs'
import { runPreflight } from '../preflight.mjs'
import { startFakeRelay, FAKE_KEY } from './fake-relay.mjs'
import { childEnv, rm, tmpEnv } from './helpers.mjs'

test('backendHostCode：只回 Supabase 專案代號，不含路徑', () => {
  assert.equal(backendHostCode('https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay'), 'etccgmkrosbzpltudlgt')
  assert.equal(backendHostCode('https://hwtahctsgjcemtwzlvnq.supabase.co/functions/v1/irori-relay'), 'hwtahctsgjcemtwzlvnq')
  assert.equal(backendHostCode('http://127.0.0.1:9/x'), '127-0-0-1')
})

test('cloudToolPaths：依 ASN_CLOUD_HOME 指到暫存目錄', () => {
  const st = { url: 'http://127.0.0.1/relay' }
  const { root, env } = tmpEnv(st.url)
  const app = path.join(root, 'my-app')
  try {
    const p = cloudToolPaths(childEnv({ ...env, ASN_CLOUD_APP: app }))
    assert.equal(p.home, root)
    assert.equal(p.app, app)
    assert.equal(p.recv, path.join(app, 'relay/cloud-agent/recv.mjs'))
    assert.match(pathsShellLines(p), /ASN_CLOUD_HOME=/)
    assert.ok(!pathsShellLines(p).includes('ASN_RELAY_KEY'))
  } finally { rm(root) }
})

test('preflight：whoami + list，輸出不含金鑰', async () => {
  const st = await startFakeRelay({
    node: 'grok',
    members: [
      { id: 'H', name: '家用', online: true, presence: 'live', agents: [] },
      { id: 'grok', name: 'Grok', online: false, presence: 'idle', agents: [] },
    ],
  })
  const { root, env } = tmpEnv(st.url, { ASN_RELAY_KEY: FAKE_KEY })
  try {
    const r = await runPreflight(childEnv(env), { json: true })
    assert.equal(r.code, 0)
    assert.equal(r.data.backendHostCode, '127-0-0-1')
    assert.equal(r.data.node, 'grok')
    assert.equal(r.data.onlineCount, 1)
    const text = JSON.stringify(r.data)
    assert.ok(!text.includes(FAKE_KEY))
  } finally { await st.close(); rm(root) }
})

test('preflight：舊名 IRORI_RELAY_KEY 仍可用', async () => {
  const st = await startFakeRelay({ node: 'grok' })
  const { root, env } = tmpEnv(st.url, { IRORI_RELAY_KEY: FAKE_KEY })
  try {
    const r = await runPreflight(childEnv(env), { json: true })
    assert.equal(r.code, 0)
  } finally { await st.close(); rm(root) }
})

test('preflight：沒金鑰回 2', async () => {
  const st = await startFakeRelay()
  const { root, env } = tmpEnv(st.url)
  try {
    const r = await runPreflight(childEnv(env))
    assert.equal(r.code, 2)
  } finally { await st.close(); rm(root) }
})

test('env.mjs CLI：print recv', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-cli-'))
  const app = path.join(root, 'my-app')
  const env = childEnv({
    ASN_CLOUD_HOME: root,
    ASN_CLOUD_APP: app,
    ASN_RELAY_URL: 'http://127.0.0.1:1/r',
  })
  try {
    const prev = process.env
    process.env = env
    assert.equal(envMain(['print', 'recv']), 0)
    process.env = prev
  } finally { rm(root) }
})
