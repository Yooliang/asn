import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AGENT_TOOLS, LAUNCH_TOOL_IDS, installStateLabel, toolById } from '../../shared/agent-tools.mjs'

test('共用清單與 issue23 偵測順序', () => {
  assert.deepEqual(LAUNCH_TOOL_IDS, ['claude', 'codex', 'agy', 'grok', 'pi'])
  assert.equal(toolById('agy').binary, 'agy')
  assert.ok(!AGENT_TOOLS.some(t => t.id === 'gemini'))
})

test('installStateLabel', () => {
  assert.equal(installStateLabel(false), '未安裝')
  assert.equal(installStateLabel(true), '已安裝')
})

test('Rust 端載入同一份 catalog.json', () => {
  const cat = fs.readFileSync(new URL('../../shared/agent-tools.catalog.json', import.meta.url), 'utf8')
  const rs = fs.readFileSync(new URL('../src-tauri/src/agent_tools/catalog.rs', import.meta.url), 'utf8')
  assert.ok(rs.includes('agent-tools.catalog.json'))
  const ids = JSON.parse(cat).tools.map(t => t.id)
  assert.deepEqual(ids, LAUNCH_TOOL_IDS)
})
