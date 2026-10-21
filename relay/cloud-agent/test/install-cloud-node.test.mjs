// install-cloud-node.sh：暫存目錄煙霧測試（不碰 /workspace/asn-relay）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const installSh = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install-cloud-node.sh')
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function runInstall(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn('bash', [installSh, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', d => { stdout += d })
    c.stderr.on('data', d => { stderr += d })
    c.on('error', reject)
    c.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function rmDir(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

function seedNode22(home) {
  const nodeDir = path.join(home, '.node')
  const bin = path.join(nodeDir, 'bin', 'node')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 })
  return nodeDir
}

test('install --use-checkout：複製 relay/machine 全部 .mjs（含 anon.mjs）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-home-'))
  const app = path.join(home, 'asn-relay')
  seedNode22(home)
  try {
    const r = await runInstall([
      '--home', home,
      '--app', app,
      '--use-checkout',
      '--skip-preflight',
    ])
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`)
    assert.ok(fs.existsSync(path.join(app, 'relay/machine/anon.mjs')), 'anon.mjs 應已複製')
    assert.ok(fs.existsSync(path.join(app, 'relay/machine/relay-core.mjs')))
  } finally { rmDir(home) }
})

test('install --migrate-from：只 grep 信件目錄、不 source relay.env；同目錄略過 cp', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-migrate-'))
  const app = path.join(home, 'asn-relay')
  const mail = path.join(home, 'relay')
  const old = path.join(home, 'old-app')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'relay.env'), [
    'ASN_RELAY_KEY=must-not-appear-in-child-env',
    'IRORI_RELAY_KEY=also-secret',
    `ASN_CLOUD_MAIL_DIR=${mail}`,
  ].join('\n'))
  fs.mkdirSync(mail, { recursive: true })
  fs.writeFileSync(path.join(mail, 'inbox.jsonl'), '{"id":"keep-me"}\n')
  seedNode22(home)
  try {
    const r = await runInstall([
      '--home', home,
      '--app', app,
      '--use-checkout',
      '--migrate-from', old,
      '--skip-preflight',
    ], { env: { ASN_RELAY_KEY: '', IRORI_RELAY_KEY: '' } })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes('遷移略過複製'), r.stdout)
    assert.equal(fs.readFileSync(path.join(mail, 'inbox.jsonl'), 'utf8'), '{"id":"keep-me"}\n')
    assert.ok(!r.stdout.includes('must-not-appear'))
    assert.ok(!r.stderr.includes('must-not-appear'))
  } finally { rmDir(home) }
})

test('install --migrate-from：不同 MAIL_DIR 時複製 inbox', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-migrate2-'))
  const app = path.join(home, 'asn-relay')
  const mail = path.join(home, 'relay-new')
  const oldMail = path.join(home, 'relay-old')
  const old = path.join(home, 'old-app')
  fs.mkdirSync(oldMail, { recursive: true })
  fs.writeFileSync(path.join(oldMail, 'inbox.jsonl'), '{"id":"from-old"}\n')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'relay.env'), `ASN_CLOUD_MAIL_DIR=${oldMail}\n`)
  seedNode22(home)
  try {
    const r = await runInstall([
      '--home', home,
      '--app', app,
      '--use-checkout',
      '--migrate-from', old,
      '--skip-preflight',
    ], { env: { ASN_CLOUD_MAIL_DIR: mail } })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(fs.readFileSync(path.join(mail, 'inbox.jsonl'), 'utf8'), '{"id":"from-old"}\n')
  } finally { rmDir(home) }
})

test('install --hook-boot：追加 bash 子行程而非 source', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hook-'))
  const app = path.join(home, 'asn-relay')
  const boot = path.join(home, 'boot.sh')
  fs.writeFileSync(boot, '#!/usr/bin/env bash\nset -e\n')
  seedNode22(home)
  try {
    const r = await runInstall([
      '--home', home,
      '--app', app,
      '--use-checkout',
      '--hook-boot', boot,
      '--skip-preflight',
    ])
    assert.equal(r.code, 0, r.stderr)
    const text = fs.readFileSync(boot, 'utf8')
    assert.match(text, /bash ".*start\.sh"/)
    assert.ok(!text.includes('. "$START_SH"') && !text.match(/\. .*start\.sh/))
  } finally { rmDir(home) }
})

test('install：拒絕刪除 HOME 外的 NODE_DIR（不真的下載 Node）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-safe-'))
  const app = path.join(home, 'asn-relay')
  const evilNode = '/tmp/asn-install-evil-node-' + process.pid
  fs.mkdirSync(evilNode, { recursive: true })
  fs.writeFileSync(path.join(evilNode, 'marker'), 'x')
  seedNode22(home)
  try {
    const r = await runInstall([
      '--home', home,
      '--app', app,
      '--use-checkout',
      '--skip-preflight',
    ], { env: { ASN_NODE_DIR: evilNode } })
    assert.notEqual(r.code, 0)
    assert.match(r.stderr + r.stdout, /拒絕刪除/)
    assert.equal(fs.readFileSync(path.join(evilNode, 'marker'), 'utf8'), 'x')
  } finally {
    rmDir(home)
    rmDir(evilNode)
  }
})

test('install 腳本路徑存在於 repo', () => {
  assert.ok(fs.existsSync(installSh))
  assert.ok(fs.existsSync(path.join(repoRoot, 'relay/machine/anon.mjs')))
})
