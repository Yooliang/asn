// 雲端代理的手動夥伴名單：保留給系統通知的名字（ASN 通知、結尾「收發室」）不收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadManualAgentEntries } from '../config.mjs'

test('手動名單略過保留名字', () => {
  const cfg = { agentsFile: '/nonexistent/agents.json', agentsEnv: 'ASN 通知,ＡＳＮ通知,x收发室,甲收發室,小乙', engine: 'claude', cwdLabel: '' }
  assert.deepEqual(loadManualAgentEntries(cfg).map(a => a.name), ['小乙'])
})
