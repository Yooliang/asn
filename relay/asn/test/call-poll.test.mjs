import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CALL_POLL_MS, startCallPoll } from '../ui/lib/call-poll.mjs'

function rig(initial = false) {
  const r = { call: initial, pulls: [], fn: null, ms: 0, cleared: 0, live: 0 }
  r.h = startCallPoll({
    anyCall: () => r.call, pull: why => { r.pulls.push(why); return Promise.resolve() },
    setTick: (f, ms) => { r.fn = f; r.ms = ms; r.live++; return 7 },
    clearTick: () => { r.cleared++; r.live-- },
  })
  return r
}

test('通話中每 2 秒收一次信，沒通話不收，結束後恢復不收', () => {
  const r = rig()
  assert.equal(r.ms, 2000)
  assert.equal(CALL_POLL_MS, 2000)
  r.fn(); assert.deepEqual(r.pulls, [])
  r.call = true; r.fn(); r.fn(); assert.deepEqual(r.pulls, ['call', 'call'])
  r.call = false; r.fn(); assert.equal(r.pulls.length, 2)
})

test('stop 清掉計時器、可重複呼叫、不殘留', () => {
  const r = rig(true)
  r.h.stop(); r.h.stop()
  assert.equal(r.cleared, 1); assert.equal(r.live, 0)
})

test('收信丟錯或判斷通話丟錯都不會讓計時器掛掉', () => {
  let fn
  startCallPoll({ anyCall: () => { throw new Error('x') }, pull: () => { throw new Error('y') }, setTick: f => { fn = f; return 1 } })
  assert.doesNotThrow(() => fn())
  startCallPoll({ anyCall: () => true, pull: () => { throw new Error('y') }, setTick: f => { fn = f; return 1 } })
  assert.doesNotThrow(() => fn())
  startCallPoll({ anyCall: () => true, pull: () => Promise.reject(new Error('z')), setTick: f => { fn = f; return 1 } })
  assert.doesNotThrow(() => fn())
})

test('守門：名單視窗接上快速輪詢，且用通話判斷當開關', () => {
  const s = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(s, /^startCallPoll\(\{ anyCall: \(\) => callBeats\.anyCall\(\)/m)
})
