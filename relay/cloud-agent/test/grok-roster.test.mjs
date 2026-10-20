// 本機夥伴名單（grok-agents）與 roster 回報：有掃到就多位、掃不到退回預設一位；與真實 /home/box 隔離
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createReceiver } from '../recv.mjs'
import { listGrokAgents, listAll } from '../grok-agents.mjs'
import { resolveCloudAgents } from '../config.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { apiFor, fakeClaudeBin, rm, run, tmpEnv } from './helpers.mjs'

const KEY = { IRORI_RELAY_KEY: 'fake-grok-node-key' }
const UUID = '11111111-2222-3333-4444-555555555555'

function writeGrokProfile(agentsDir, id, name) {
  const d = path.join(agentsDir, id)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'profile.json'), JSON.stringify({ name }))
}

test('listGrokAgents：只讀 profile.json、略過非 uuid 目錄、依 name 排序', () => {
  const { root, cfg } = tmpEnv('http://127.0.0.1:1')
  const dir = path.join(root, 'grok-custom')
  try {
    fs.mkdirSync(path.join(dir, 'not-a-uuid'), { recursive: true })
    writeGrokProfile(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '牧陽')
    writeGrokProfile(dir, UUID, '小真')
    assert.deepEqual(listGrokAgents({ GROK_AGENTS_DIR: dir }).map(a => a.name), ['小真', '牧陽'])
    assert.equal(cfg.rosterAuto, false)
  } finally { rm(root) }
})

test('listAll：IRORI_CLOUD_ROSTER_CLAUDE=1 時才列 Claude 視窗（排除收發室）', async () => {
  const { root } = tmpEnv('http://127.0.0.1:1')
  const dir = path.join(root, 'grok-custom')
  try {
    writeGrokProfile(dir, UUID, '島作')
    const scanEnv = {
      GROK_AGENTS_DIR: dir,
      IRORI_CLAUDE_BIN: process.execPath,
      IRORI_CLAUDE_SCRIPT: fakeClaudeBin,
      IRORI_CLOUD_ROSTER_CLAUDE: '1',
      FAKE_CLAUDE_AGENTS_JSON: JSON.stringify([
        { name: 'W-政策', kind: 'interactive', entrypoint: 'cli', status: 'busy', cwd: '/home/proj/policy' },
        { name: 'W-收發室', kind: 'interactive', entrypoint: 'cli', cwd: '/x' },
        { name: 'batch-only', kind: 'batch', entrypoint: 'cli' },
      ]),
    }
    assert.deepEqual((await listAll({ ...scanEnv, IRORI_CLOUD_ROSTER_CLAUDE: '0' })).map(a => a.name), ['島作'])
    const all = await listAll(scanEnv)
    assert.deepEqual(all.map(a => a.name), ['島作', 'W-政策'])
    assert.equal(all[0].engine, 'grok')
    assert.equal(all[1].engine, 'claude')
    assert.equal(all[1].cwd_label, 'policy')
  } finally { rm(root) }
})

test('roster：掃到夥伴時回報多位', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url, { IRORI_CLOUD_ROSTER_AUTO: '1' })
  try {
    writeGrokProfile(cfg.grokAgentsDir, UUID, '小真')
    writeGrokProfile(cfg.grokAgentsDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '正見')
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => x.name), ['小真', '正見'])
    assert.ok(st.rosters[0].agents.every(x => x.engine === 'grok' && x.cwd_label === 'grok-cloud'))
  } finally { await st.close(); rm(root) }
})

test('roster：掃不到夥伴時退回只有預設 Grok 一位', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url, { IRORI_CLOUD_ROSTER_AUTO: '1', IRORI_CLOUD_ROSTER_NAME: 'Grok-2' })
  try {
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents, [{ name: 'Grok-2', status: 'idle', engine: 'grok', cwd_label: 'grok-cloud' }])
  } finally { await st.close(); rm(root) }
})

test('IRORI_CLOUD_ROSTER_AUTO=0：不掃描，沿用 agents.json／IRORI_CLOUD_AGENTS', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url, { IRORI_CLOUD_AGENTS: 'Grok,手動名單', IRORI_CLOUD_ROSTER_AUTO: '0' })
  try {
    writeGrokProfile(cfg.grokAgentsDir, UUID, '掃描才會出現')
    const agents = await resolveCloudAgents(cfg)
    assert.deepEqual(agents.map(x => x.name), ['Grok', '手動名單'])
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => x.name), ['Grok', '手動名單'])
  } finally { await st.close(); rm(root) }
})

test('合併：掃描為主、agents.json 補人；同名 status／cwd_label 以 agents.json 為準', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url, { IRORI_CLOUD_ROSTER_AUTO: '1' })
  try {
    writeGrokProfile(cfg.grokAgentsDir, UUID, '小真')
    writeGrokProfile(cfg.grokAgentsDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '正見')
    fs.mkdirSync(cfg.mailDir, { recursive: true })
    fs.writeFileSync(cfg.agentsFile, JSON.stringify([
      { name: '正見', status: 'busy', cwd_label: 'policy' },
      { name: '牧陽' },
    ]))
    const agents = await resolveCloudAgents(cfg)
    assert.deepEqual(agents.map(x => x.name), ['小真', '正見', '牧陽'])
    const zheng = agents.find(x => x.name === '正見')
    assert.equal(zheng.status, 'busy')
    assert.equal(zheng.cwd_label, 'policy')
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.rosterOnce()
    assert.equal(st.rosters[0].agents.find(x => x.name === '正見').status, 'busy')
  } finally { await st.close(); rm(root) }
})

test('自動掃到的名字可以 send --from、inbox --agent（不必寫進 agents.json）', async () => {
  const st = await startFakeRelay()
  const { root, cfg, env } = tmpEnv(st.url, { ...KEY, IRORI_CLOUD_ROSTER_AUTO: '1' })
  try {
    writeGrokProfile(cfg.grokAgentsDir, UUID, '正見')
    fs.mkdirSync(cfg.mailDir, { recursive: true })
    const m = (id, to) => JSON.stringify({ id: U(id), from_node: 'w02', from_agent: '工作機', to_agent: to, body: `信${id}`, expects_reply: true })
    fs.writeFileSync(cfg.inboxFile, [m(1, '正見'), m(2, null)].join('\n') + '\n')
    const sendOk = await run('send.mjs', ['--to', 'w02/工作機', '--body', '收到', '--no-reply', '--from', '正見', '--reply-to', U(1)], { env })
    assert.equal(sendOk.code, 0, sendOk.stderr)
    assert.equal(st.sent[0].from_agent, '正見')
    const inboxOut = await run('inbox.mjs', ['--json', '--agent', '正見'], { env })
    const ids = inboxOut.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id)
    assert.deepEqual(ids, [U(1)])
  } finally { await st.close(); rm(root) }
})

test('tmpEnv 不受 process.env 真實 GROK_AGENTS_DIR 影響（模擬 Grok 雲端本機夥伴）', async () => {
  const st = await startFakeRelay()
  const simulatedBox = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-box-agents-'))
  writeGrokProfile(simulatedBox, '22222222-3333-4444-5555-666666666666', '小真')
  writeGrokProfile(simulatedBox, '33333333-4444-5555-6666-777777777777', '正見')
  const prev = process.env.GROK_AGENTS_DIR
  const prevClaude = process.env.IRORI_CLAUDE_BIN
  process.env.GROK_AGENTS_DIR = simulatedBox
  process.env.IRORI_CLAUDE_BIN = '/home/box/.local/bin/claude'
  let root = null
  let root2 = null
  let cfg = null
  let cfg2 = null
  try {
    ;({ root, cfg } = tmpEnv(st.url))
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => x.name), ['Grok'], '預設關掃描且隔離目錄，不應讀到模擬的本機夥伴')
    ;({ root: root2, cfg: cfg2 } = tmpEnv(st.url, { IRORI_CLOUD_ROSTER_AUTO: '1' }))
    const rx2 = createReceiver({ api: apiFor(cfg2), cfg: cfg2, log: () => {} })
    await rx2.rosterOnce()
    assert.deepEqual(st.rosters[1].agents.map(x => x.name), ['Grok'], '自動掃描也只用 cfg 的暫存目錄，不是 process.env 的模擬 box')
  } finally {
    process.env.GROK_AGENTS_DIR = prev
    process.env.IRORI_CLAUDE_BIN = prevClaude
    if (root) rm(root)
    if (root2) rm(root2)
    await st.close()
    rm(simulatedBox)
  }
})
