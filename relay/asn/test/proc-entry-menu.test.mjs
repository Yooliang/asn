// 只顯示的程序條目（kind＝process）：選單沒有「封存」；狀態寫「執行中・僅顯示」、灰點，不寫「忙碌」也不用綠點。一般視窗不受影響。
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

test('程序條目的狀態是「執行中・僅顯示」；一般 running 視窗仍是忙碌', () => {
  const f = by()
  assert.equal(f['codex #1234（前景）'].status, 'running')
  assert.equal(statusNote('running'), '(執行中・僅顯示)')
  assert.equal(f['小文'].status, 'busy')
  assert.equal(statusNote(f['小文'].status), '(忙碌)')
  assert.equal(f['小武'].status, 'online')
  assert.equal(statusOf('running'), 'busy')
  assert.equal(statusOf('idle', true), 'running', '程序條目不分狀態都不是線上（綠點代表可寄信）')
})

test('程序條目用灰點，不用代表可寄信的綠點（電腦版與手機版）', async () => {
  const { readFile } = await import('node:fs/promises')
  const css = await readFile(new URL('../ui/style.css', import.meta.url), 'utf8')
  const online = css.match(/([^{}]*)\{--frame:var\(--online\)\}/)[1]
  assert.ok(!online.includes('st-running'), online)
  assert.match(css, /\.dot\.st-running[^{}]*\{--frame:var\(--offline\)\}/)
  const mcss = await readFile(new URL('../ui/mobile.css', import.meta.url), 'utf8')
  assert.match(mcss, /\.m-pic\.st-running\{--frame:var\(--offline\)\}/)
})
