// 本機夥伴名單（grok-agents）與 roster 回報：有掃到就多位、掃不到退回預設一位
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReceiver } from '../recv.mjs'
import { listGrokAgents, listAll } from '../grok-agents.mjs'
import { rosterAgentsForReport } from '../config.mjs'
import { startFakeRelay } from './fake-relay.mjs'
import { apiFor, rm, tmpEnv } from './helpers.mjs'

const fakeClaude = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude-agents.mjs')
const UUID = '11111111-2222-3333-4444-555555555555'

function writeGrokProfile(agentsDir, id, name) {
  const d = path.join(agentsDir, id)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'profile.json'), JSON.stringify({ name }))
}

test('listGrokAgents：只讀 profile.json、略過非 uuid 目錄、依 name 排序', () => {
  const { root, env } = tmpEnv('http://127.0.0.1:1')
  const dir = path.join(root, 'grok-agents')
  env.GROK_AGENTS_DIR = dir
  try {
    fs.mkdirSync(path.join(dir, 'not-a-uuid'), { recursive: true })
    writeGrokProfile(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '牧陽')
    writeGrokProfile(dir, UUID, '小真')
    const prev = process.env.GROK_AGENTS_DIR
    process.env.GROK_AGENTS_DIR = dir
    try {
      assert.deepEqual(listGrokAgents().map(a => a.name), ['小真', '牧陽'])
    } finally { process.env.GROK_AGENTS_DIR = prev }
  } finally { rm(root) }
})

test('listAll：Grok 夥伴＋ Claude 視窗（排除收發室）', () => {
  const { root, env } = tmpEnv('http://127.0.0.1:1')
  const dir = path.join(root, 'grok-agents')
  env.GROK_AGENTS_DIR = dir
  env.IRORI_CLAUDE_BIN = fakeClaude
  env.FAKE_CLAUDE_AGENTS_JSON = JSON.stringify([
    { name: 'W-政策', kind: 'interactive', entrypoint: 'cli', status: 'busy', cwd: '/home/proj/policy' },
    { name: 'W-收發室', kind: 'interactive', entrypoint: 'cli', cwd: '/x' },
    { name: 'batch-only', kind: 'batch', entrypoint: 'cli' },
  ])
  writeGrokProfile(dir, UUID, '島作')
  const prevDir = process.env.GROK_AGENTS_DIR
  const prevBin = process.env.IRORI_CLAUDE_BIN
  const prevJson = process.env.FAKE_CLAUDE_AGENTS_JSON
  try {
    process.env.GROK_AGENTS_DIR = dir
    process.env.IRORI_CLAUDE_BIN = fakeClaude
    process.env.FAKE_CLAUDE_AGENTS_JSON = env.FAKE_CLAUDE_AGENTS_JSON
    const all = listAll()
    assert.deepEqual(all.map(a => a.name), ['島作', 'W-政策'])
    assert.equal(all[0].engine, 'grok')
    assert.equal(all[1].engine, 'claude')
    assert.equal(all[1].cwd_label, 'policy')
  } finally {
    process.env.GROK_AGENTS_DIR = prevDir
    process.env.IRORI_CLAUDE_BIN = prevBin
    process.env.FAKE_CLAUDE_AGENTS_JSON = prevJson
  }
})

test('roster：掃到夥伴時回報多位', async () => {
  const st = await startFakeRelay()
  const { root, cfg, env } = tmpEnv(st.url)
  const agentsDir = path.join(root, 'grok-agents')
  env.GROK_AGENTS_DIR = agentsDir
  env.IRORI_CLAUDE_BIN = fakeClaude
  env.FAKE_CLAUDE_AGENTS_JSON = '[]'
  writeGrokProfile(agentsDir, UUID, '小真')
  writeGrokProfile(agentsDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '正見')
  const scanEnv = { ...process.env, ...env }
  try {
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {}, env: scanEnv })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => x.name), ['小真', '正見'])
    assert.ok(st.rosters[0].agents.every(x => x.engine === 'grok' && x.cwd_label === 'grok-cloud'))
  } finally { await st.close(); rm(root) }
})

test('roster：掃不到夥伴時退回只有預設 Grok 一位', async () => {
  const st = await startFakeRelay()
  const { root, cfg, env } = tmpEnv(st.url, { IRORI_CLOUD_ROSTER_NAME: 'Grok-2' })
  env.GROK_AGENTS_DIR = path.join(root, 'empty-agents')
  env.IRORI_CLAUDE_BIN = fakeClaude
  env.FAKE_CLAUDE_AGENTS_JSON = '[]'
  const scanEnv = { ...process.env, ...env }
  try {
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {}, env: scanEnv })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents, [{ name: 'Grok-2', status: 'idle', engine: 'grok', cwd_label: 'grok-cloud' }])
  } finally { await st.close(); rm(root) }
})

test('IRORI_CLOUD_ROSTER_AUTO=0：不掃描，沿用 agents.json／IRORI_CLOUD_AGENTS', async () => {
  const st = await startFakeRelay()
  const { root, cfg, env } = tmpEnv(st.url, { IRORI_CLOUD_AGENTS: 'Grok,手動名單', IRORI_CLOUD_ROSTER_AUTO: '0' })
  const agentsDir = path.join(root, 'grok-agents')
  env.GROK_AGENTS_DIR = agentsDir
  writeGrokProfile(agentsDir, UUID, '掃描才會出現')
  const scanEnv = { ...process.env, ...env }
  try {
    const agents = await rosterAgentsForReport(cfg, scanEnv)
    assert.deepEqual(agents.map(x => x.name), ['Grok', '手動名單'])
    const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {}, env: scanEnv })
    await rx.rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => x.name), ['Grok', '手動名單'])
  } finally { await st.close(); rm(root) }
})
