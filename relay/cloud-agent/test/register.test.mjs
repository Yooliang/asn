// register.mjs：金鑰寫檔與權限、不印金鑰、錯誤不留檔、不重複註冊、--check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startFakeRelay, INVITE, ISSUED_KEY } from './fake-relay.mjs'
import { run, rm, tmpEnv } from './helpers.mjs'

const posix = process.platform !== 'win32'   // Windows 沒有 unix 權限位元

test('註冊成功：金鑰寫到 <金鑰目錄>/grok.key、權限 700/600、stdout/stderr 不含金鑰、送出的欄位正確', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    const r = await run('register.mjs', [], { env: { ...env, IRORI_INVITE: INVITE } })
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout.trim())
    assert.equal(out.ok, true); assert.equal(out.id, 'grok'); assert.equal(out.verified, true)
    assert.equal(fs.readFileSync(cfg.keyFile, 'utf8'), ISSUED_KEY)
    assert.equal(cfg.keyFile, path.join(root, '.irori-relay', 'grok.key'))
    if (posix) {
      assert.equal(fs.statSync(cfg.keyDir).mode & 0o777, 0o700)
      assert.equal(fs.statSync(cfg.keyFile).mode & 0o777, 0o600)
    }
    assert.ok(!(r.stdout + r.stderr).includes(ISSUED_KEY), '金鑰不可出現在輸出')
    assert.ok(!(r.stdout + r.stderr).includes(INVITE), '邀請碼也不印')
    assert.deepEqual(fs.readdirSync(cfg.keyDir), ['grok.key'], '不留暫存檔')
    assert.deepEqual({ id: st.registerBody.id, name: st.registerBody.name, kind: st.registerBody.kind, machine: st.registerBody.machine },
      { id: 'grok', name: 'Grok 雲端', kind: 'grok', machine: 'grok-cloud' })
  } finally { await st.close(); rm(root) }
})

test('邀請碼錯／代號被占用：不寫金鑰檔、exit 1、訊息白話', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    const bad = await run('register.mjs', [], { env: { ...env, IRORI_INVITE: 'wrong' } })
    assert.equal(bad.code, 1)
    assert.equal(JSON.parse(bad.stdout).error, 'invalid_invite')
    const taken = await run('register.mjs', ['--id', 'taken'], { env: { ...env, IRORI_INVITE: INVITE } })
    assert.equal(taken.code, 1)
    assert.equal(JSON.parse(taken.stdout).error, 'id_taken')
    assert.equal(fs.existsSync(cfg.keyDir), false)
  } finally { await st.close(); rm(root) }
})

test('沒給邀請碼不連線；已有金鑰檔不重複註冊（不消耗邀請碼）', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    const none = await run('register.mjs', [], { env })
    assert.equal(none.code, 1); assert.equal(st.reqs.length, 0)
    fs.mkdirSync(cfg.keyDir, { recursive: true }); fs.writeFileSync(cfg.keyFile, 'old')
    const again = await run('register.mjs', [], { env: { ...env, IRORI_INVITE: INVITE } })
    assert.equal(again.code, 1); assert.equal(JSON.parse(again.stdout).error, 'already_registered')
    assert.equal(st.reqs.length, 0); assert.equal(fs.readFileSync(cfg.keyFile, 'utf8'), 'old')
  } finally { await st.close(); rm(root) }
})

test('--check：IRORI_RELAY_KEY 優先於金鑰檔；沒金鑰就說沒有', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url)
  try {
    assert.equal(JSON.parse((await run('register.mjs', ['--check'], { env })).stdout).error, 'no_key')
    const viaEnv = await run('register.mjs', ['--check'], { env: { ...env, IRORI_RELAY_KEY: ISSUED_KEY } })
    assert.deepEqual(JSON.parse(viaEnv.stdout), { ok: true, node: 'grok' })
    fs.mkdirSync(cfg.keyDir, { recursive: true }); fs.writeFileSync(cfg.keyFile, ISSUED_KEY)
    assert.equal(JSON.parse((await run('register.mjs', ['--check'], { env })).stdout).ok, true)
    assert.equal(JSON.parse((await run('register.mjs', ['--check'], { env: { ...env, IRORI_RELAY_KEY: 'bad' } })).stdout).ok, false)
  } finally { await st.close(); rm(root) }
})
