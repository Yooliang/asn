// 只顯示的程序條目（kind＝process）：選單沒有「封存」；狀態寫「執行中」不寫「忙碌」。一般視窗不受影響。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manageItems } from '../ui/lib/archive.mjs'
import { buildFriends, statusOf } from '../ui/lib/roster.mjs'
import { statusNote } from '../ui/lib/tabs.mjs'

const members = [{ id: 'H', name: '家用機', agents: [
  { name: 'codex #1234（前景）', kind: 'process', receivable: false, status: 'running', engine: 'codex' },
  { name: '小文', status: 'running', engine: 'claude' },
  { name: '小武', status: 'idle', engine: 'claude' },
] }]
const by = () => Object.fromEntries(buildFriends(members).map(f => [f.agent, f]))

test('程序條目的選單沒有封存（不是反灰，是不出現）；一般 AI 夥伴仍有封存', () => {
  const f = by()
  const proc = manageItems(f['codex #1234（前景）'], {})
  assert.ok(!proc.some(i => i.key === 'archive' || i.key === 'unarchive'))
  assert.ok(proc.every(i => !i.ok), '其他管理項目維持反灰')
  assert.ok(manageItems(f['小文'], {}).some(i => i.key === 'archive'))
  assert.ok(manageItems(f['小武'], {}).some(i => i.key === 'archive'))
})

test('程序條目的狀態是「執行中」；一般 running 視窗仍是忙碌', () => {
  const f = by()
  assert.equal(f['codex #1234（前景）'].status, 'running')
  assert.equal(statusNote('running'), '(執行中)')
  assert.equal(f['小文'].status, 'busy')
  assert.equal(statusNote(f['小文'].status), '(忙碌)')
  assert.equal(f['小武'].status, 'online')
  assert.equal(statusOf('running'), 'busy')
  assert.equal(statusOf('idle', true), 'online')
})
