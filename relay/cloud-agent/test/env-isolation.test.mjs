// shell 已 export 生產用 IRORI_* 時，測試仍只認 tmpEnv／childEnv 的值（絕不印金鑰）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { startFakeRelay, FAKE_KEY } from './fake-relay.mjs'
import { childEnv, rm, run, script, tmpEnv, withoutIroriEnv } from './helpers.mjs'

const POLLUTION = {
  IRORI_RELAY_KEY: 'pollution-key-must-not-leak-to-relay-or-logs',
  ASN_RELAY_KEY: 'asn-pollution-key-must-not-leak',
  IRORI_CLOUD_HOME: '/pollution/home',
  ASN_CLOUD_HOME: '/pollution/asn-home',
  IRORI_CLOUD_MAIL_DIR: '/pollution/mail',
  ASN_CLOUD_MAIL_DIR: '/pollution/asn-mail',
  IRORI_RELAY_ID: 'pollution-node',
  ASN_RELAY_ID: 'pollution-asn-node',
  IRORI_CLOUD_APP: 'pollution-app',
  ASN_CLOUD_APP: 'pollution-asn-app',
}

function savePollution() {
  const prev = {}
  for (const k of Object.keys(POLLUTION)) {
    prev[k] = process.env[k]
    process.env[k] = POLLUTION[k]
  }
  return prev
}

function restorePollution(prev) {
  for (const k of Object.keys(POLLUTION)) {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  }
}

test('childEnv：剔除 process.env 的 IRORI_*／ASN_* 後才套用測試覆寫', () => {
  const prev = savePollution()
  try {
    const bare = childEnv({ ASN_RELAY_KEY: '' })
    assert.equal(bare.ASN_RELAY_KEY, '')
    assert.equal(bare.IRORI_RELAY_KEY, undefined)
    assert.equal(bare.ASN_RELAY_KEY, '')
    assert.equal(bare.ASN_CLOUD_HOME, undefined)
    assert.equal(bare.IRORI_CLOUD_HOME, undefined)
    assert.ok(process.env.PATH, '非 IRORI_ 的變數仍保留')
    // Windows 的環境變數名稱不分大小寫，展開成一般物件後鍵名可能是 Path
    const pathKey = o => Object.keys(o).find(n => n.toUpperCase() === 'PATH')
    assert.ok(pathKey(bare), 'childEnv 仍保留 PATH')
    assert.ok(pathKey(withoutIroriEnv(process.env)), 'withoutIroriEnv 仍保留 PATH')
  } finally { restorePollution(prev) }
})

test('process.env 帶生產 IRORI_* 時 send／tmpEnv 行為仍正確', async () => {
  const st = await startFakeRelay()
  const prev = savePollution()
  let root = null
  let root2 = null
  let env = null
  let env2 = null
  try {
    ;({ root, env } = tmpEnv(st.url))
    assert.equal((await run('send.mjs', ['--to', 'W', '--body', 'x', '--no-reply'], { env })).code, 2)
    ;({ root: root2, env: env2 } = tmpEnv(st.url, { ASN_RELAY_KEY: FAKE_KEY }))
    const ok = await run('send.mjs', ['--to', 'W', '--body', 'x', '--no-reply'], { env: env2 })
    assert.equal(ok.code, 0, ok.stderr)
    assert.equal(st.reqs.at(-1).key, FAKE_KEY)
    assert.ok(!ok.stdout.includes('pollution-key'))
    assert.ok(!ok.stderr.includes('pollution-key'))
  } finally {
    restorePollution(prev)
    if (root) rm(root)
    if (root2) rm(root2)
    await st.close()
  }
})

test('process.env 帶生產 IRORI_* 時 spawn recv 只用 childEnv（不連正式後端）', async () => {
  const st = await startFakeRelay()
  const prev = savePollution()
  let root = null
  let env = null
  try {
    ;({ root, env } = tmpEnv(st.url, { ASN_RELAY_KEY: FAKE_KEY, ASN_RECV_POLL_MS: '500', ASN_ROSTER_MS: '500' }))
    const c = spawn(process.execPath, [script('recv.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv(env) })
    let out = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (out += d))
    await new Promise(r => setTimeout(r, 400))
    c.kill()
    await new Promise(r => c.on('close', r))
    assert.ok(st.reqs.some(q => q.key === FAKE_KEY), '應連假後端')
    assert.ok(!out.includes('pollution-key'))
    assert.ok(!out.includes('asn-pollution-key'))
  } finally {
    restorePollution(prev)
    if (root) rm(root)
    await st.close()
  }
})
