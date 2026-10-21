import assert from 'node:assert/strict'
import test from 'node:test'
import { queryConsole, resolveClaudePidByName } from '../partner-console.mjs'

test('非 Windows：查詢回報不可切換', () => {
  if (process.platform === 'win32') return
  const r = queryConsole({ engine: 'claude', name: 'Test' })
  assert.equal(r.canToggle, false)
  assert.match(r.reason, /Windows/)
})

test('resolveClaudePidByName：沒有 CLI 時回 null', () => {
  const r = resolveClaudePidByName('不存在的夥伴', { CLAUDE_BIN: '/no/such/claude' })
  assert.equal(r, null)
})
