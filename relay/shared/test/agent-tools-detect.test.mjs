import assert from 'node:assert/strict'
import test from 'node:test'
import { detectAgentTools } from '../agent-tools-detect.mjs'
import { buildDefaultProfiles } from '../launcher-profiles.mjs'
import { loadConfig } from '../../machine/launcher.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('agent-tools-detect：可 mock 查詢結果', async () => {
  const tools = await detectAgentTools({
    execLookup: async id => (id === 'claude' ? '/usr/bin/claude' : null),
    execFile: async () => ({ stdout: 'claude 9.9.9\n' }),
  })
  assert.equal(tools.claude.cmd, '/usr/bin/claude')
  assert.match(tools.claude.version, /9\.9\.9/)
  assert.equal(tools.codex.cmd, null)
  assert.ok(tools.codex.installHint.length > 0)
})

test('自動 profile：有 claude 就產生 claude profile', async () => {
  const tools = await detectAgentTools({ execLookup: async id => (id === 'claude' ? 'claude' : null), execFile: async () => ({ stdout: '1\n' }) })
  const profiles = buildDefaultProfiles(tools)
  assert.ok(profiles.claude)
  assert.equal(profiles.claude.mode, 'window')
})

test('loadConfig：沒有 launcher.json 時用 bootstrap', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-launch-'))
  const file = path.join(d, 'missing.json')
  const bootstrap = {
    profiles: { claude: { label: 'C', mode: 'window', command: 'claude', args: ['-n', '{name}'], engine: 'claude' } },
    cwd_allow: [d],
    max_per_hour: 3,
  }
  const { config } = loadConfig(file, bootstrap)
  assert.equal(config.max_per_hour, 3)
  assert.equal(config.profiles.claude.command, 'claude')
})
