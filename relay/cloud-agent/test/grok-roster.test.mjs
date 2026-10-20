// 本機夥伴名單（grok-agents）與 roster 回報：有掃到就多位、掃不到退回預設一位；與真實 /home/box 隔離
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createReceiver } from '../recv.mjs'
import { listGrokAgents, listAll } from '../grok-agents.mjs'
import { rosterAgentsForReport } from '../config.mjs'
import { startFakeRelay } from './fake-relay.mjs'
import { apiFor, fakeClaudeBin, rm, tmpEnv } from './helpers.mjs'

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

test('listAll：Grok 夥伴＋ Claude 視窗（排除收發室）', () => {
  const { root } = tmpEnv('http://127.0.0.1:1')
  const dir = path.join(root, 'grok-custom')
  try {
    writeGrokProfile(dir, UUID, '島作')
    const scanEnv = {
      GROK_AGENTS_DIR: dir,
      IRORI_CLAUDE_BIN: fakeClaudeBin,
      FAKE_CLAUDE_AGENTS_JSON: JSON.stringify([
        { name: 'W-政策', kind: 'interactive', entrypoint: 'cli', status: 'busy', cwd: '/home/proj/policy' },
        { name: 'W-收發室', kind: 'interactive', entrypoint: 'cli', cwd: '/x' },
        { name: 'batch-only', kind: 'batch', entrypoint: 'cli' },
      ]),
    }
    const all = listAll(scanEnv)
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
    const agents = await rosterAgentsForReport(cfg)
    assert.deepEqual(agents.map(x => x.name), ['Grok', '手動名單'])
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {} })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => x.name), ['Grok', '手動名單'])
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
