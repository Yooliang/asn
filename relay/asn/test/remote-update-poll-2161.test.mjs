// #2161 F1：node_update_status 輪詢降頻（有遠端更新進行中 15 秒、平時 5 分鐘、隱藏且沒進行中就暫停）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { ACTIVE_POLL_MS, IDLE_POLL_MS, POLL_MS, nextPollMs } from '../ui/lib/remote-update.mjs'

const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
const NOW = 10_000_000

test('常數：進行中 15000、平時 300000、POLL_MS 仍匯出且等於進行中', () => {
  assert.equal(ACTIVE_POLL_MS, 15000)
  assert.equal(IDLE_POLL_MS, 300000)
  assert.equal(POLL_MS, ACTIVE_POLL_MS)
})

test('nextPollMs：沒有進行中的更新 → 300000（含 failed、null、空物件、undefined）', () => {
  assert.equal(nextPollMs({ a: null, b: null }, { now: NOW }), 300000)
  assert.equal(nextPollMs({ a: { state: 'failed', detail: 'x' } }, { now: NOW }), 300000)
  assert.equal(nextPollMs({}, { now: NOW }), 300000)
  assert.equal(nextPollMs(undefined, { now: NOW }), 300000)
  assert.equal(nextPollMs(undefined), 300000)
})

test('nextPollMs：pending 或 taken → 15000', () => {
  assert.equal(nextPollMs({ a: null, b: { state: 'pending', detail: '' } }, { now: NOW }), 15000)
  assert.equal(nextPollMs({ a: { state: 'taken', detail: '' } }, { now: NOW }), 15000)
})

test('nextPollMs：剛按下更新（120 秒內）→ 15000，超過 → 300000', () => {
  assert.equal(nextPollMs({}, { requestedAt: NOW - 119_000, now: NOW }), 15000)
  assert.equal(nextPollMs({}, { requestedAt: NOW - 120_000, now: NOW }), 300000)
  assert.equal(nextPollMs({}, { requestedAt: NOW - 500_000, now: NOW }), 300000)
})

test('nextPollMs：隱藏且沒進行中 → null；隱藏但有進行中 → 15000', () => {
  assert.equal(nextPollMs({ a: null }, { hidden: true, now: NOW }), null)
  assert.equal(nextPollMs({ a: { state: 'failed' } }, { hidden: true, now: NOW }), null)
  assert.equal(nextPollMs({ a: { state: 'taken' } }, { hidden: true, now: NOW }), 15000)
  assert.equal(nextPollMs({}, { hidden: true, requestedAt: NOW - 1000, now: NOW }), 15000)
})

test('list.js 守門：不再 setInterval 打 refreshRemoteUpd；用 nextPollMs、visibilitychange、clearTimeout', () => {
  assert.ok(!/setInterval\(\s*\(\)\s*=>\s*void refreshRemoteUpd/.test(js), '不得退回固定 setInterval')
  assert.ok(js.includes('nextPollMs('))
  assert.ok(js.includes('visibilitychange'))
  assert.ok(js.includes('clearTimeout(remoteTimer)'))
})
