// 金鑰處理：有 IRORI_RELAY_KEY 就不碰金鑰檔；各種錯誤、log、輸出都不含金鑰字串
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { readKey } from '../config.mjs'
import { startFakeRelay, FAKE_KEY, U } from './fake-relay.mjs'
import { rm, run, script, sleep, tmpEnv } from './helpers.mjs'

test('有 IRORI_RELAY_KEY：完全不讀金鑰檔（檔案不存在／是資料夾／內容不同都無關）、不寫檔', async () => {
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url, { IRORI_RELAY_KEY: FAKE_KEY })
  try {
    fs.mkdirSync(cfg.keyDir, { recursive: true })
    fs.mkdirSync(cfg.keyFile)   // 真的去讀會丟 EISDIR；環境變數有值就不該碰
    assert.equal(readKey(cfg, { IRORI_RELAY_KEY: FAKE_KEY }), FAKE_KEY)
    const r = await run('send.mjs', ['--to', 'W', '--body', 'x', '--no-reply'], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(st.reqs.at(-1).key, FAKE_KEY)
    assert.deepEqual(fs.readdirSync(cfg.keyDir), ['grok.key'], '沒有多寫任何檔')
    assert.ok(fs.statSync(cfg.keyFile).isDirectory())
  } finally { await st.close(); rm(root) }
})

test('沒有任何金鑰：recv／send 只說「沒有設定 IRORI_RELAY_KEY」', async () => {
  const st = await startFakeRelay()
  const { root, env } = tmpEnv(st.url)
  try {
    const s = await run('send.mjs', ['--to', 'W', '--body', 'x', '--no-reply'], { env })
    assert.equal(s.code, 2); assert.match(s.stderr, /沒有設定 IRORI_RELAY_KEY/)
    const r = await run('recv.mjs', [], { env })
    assert.equal(r.code, 2); assert.match(r.stderr, /沒有設定 IRORI_RELAY_KEY/)
    assert.equal(st.reqs.length, 0)
  } finally { await st.close(); rm(root) }
})

test('用假金鑰掃輸出：壞金鑰被拒、後端回 401、常駐 log、--help、inbox 輸出，都不含金鑰字串或片段', async () => {
  const SECRET = 'SECRET-sk-abcdef0123456789-zyx'
  const st = await startFakeRelay()
  const { root, env, cfg } = tmpEnv(st.url, { IRORI_RELAY_KEY: SECRET, IRORI_RECV_POLL_MS: '150', IRORI_ROSTER_MS: '150' })
  const leaks = text => ['SECRET-sk', 'abcdef0123', 'zyx'].some(p => text.includes(p))
  try {
    const outs = []
    for (const [f, a] of [['send.mjs', ['--to', 'W', '--body', 'x', '--no-reply']], ['send.mjs', ['--help']], ['inbox.mjs', ['--help']], ['inbox.mjs', ['--all']], ['register.mjs', ['--check']]]) {
      const r = await run(f, a, { env }); outs.push(r.stdout + r.stderr)
    }
    // 常駐：壞金鑰 → whoami 一直 401，看 log／輸出
    const c = spawn(process.execPath, [script('recv.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } })
    let out = ''; c.stdout.on('data', d => (out += d)); c.stderr.on('data', d => (out += d))
    await sleep(1200)
    const closed = new Promise(r => c.on('close', r)); c.kill(); await closed
    outs.push(out)
    outs.push(fs.existsSync(cfg.logFile) ? fs.readFileSync(cfg.logFile, 'utf8') : '')
    assert.ok(outs[outs.length - 1].includes('whoami failed'), '確實走過錯誤路徑')
    for (const o of outs) assert.equal(leaks(o), false, o.slice(0, 200))
    assert.ok(!JSON.stringify(st.reqs.map(q => q.body)).includes('SECRET'), '金鑰不在請求內容裡')
  } finally { await st.close(); rm(root) }
})
