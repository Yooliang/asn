import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { authClass, authLabel, formatWindow, showInstall, showLogin } from '../ui/lib/usage.mjs'
import { AGENT_TOOLS, LAUNCH_TOOL_IDS, toolById } from '../../shared/agent-tools.mjs'

test('共用清單與 issue23 偵測順序', () => {
  assert.deepEqual(LAUNCH_TOOL_IDS, ['claude', 'codex', 'agy', 'grok', 'pi'])
  assert.equal(toolById('agy').binary, 'agy')
  assert.ok(!AGENT_TOOLS.some(t => t.id === 'gemini'))
})

test('用量 UI 邏輯：安裝與登入按鈕（沒有啟動按鈕）', () => {
  const base = { install_available: true, login_available: true, usage_supported: true, auth: 'not_installed' }
  assert.equal(showInstall(base), true)
  assert.equal(showLogin({ ...base, auth: 'not_installed' }), false)
  assert.equal(showLogin({ ...base, auth: 'not_logged_in' }), true)
  assert.equal(showInstall({ ...base, auth: 'logged_in' }), false)
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.ok(!html.includes('runLaunch') && !html.includes('>啟動<'), '不應有啟動 CLI 的按鈕')
  assert.ok(html.includes('runInstall') && html.includes('runLogin'))
})

test('authLabel 與 formatWindow', () => {
  assert.equal(authLabel('not_installed'), '未安裝')
  assert.equal(authClass('logged_in'), 'st-online')
  const t = formatWindow({ used_percent: 40, remaining_percent: 60, reset_at: '123', detail: null })
  assert.match(t, /40%/)
  assert.match(t, /剩 60%/)
})

test('Rust 端載入同一份 catalog.json', () => {
  const cat = fs.readFileSync(new URL('../../shared/agent-tools.catalog.json', import.meta.url), 'utf8')
  const rs = fs.readFileSync(new URL('../src-tauri/src/ai_usage/catalog.rs', import.meta.url), 'utf8')
  assert.ok(rs.includes('agent-tools.catalog.json'))
  const ids = JSON.parse(cat).tools.map(t => t.id)
  assert.deepEqual(ids, LAUNCH_TOOL_IDS)
})
