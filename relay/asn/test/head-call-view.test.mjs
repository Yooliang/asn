// #1866 ①：對話頁右上角通話／喚醒的共用判斷。輸入用真的 menuItems 的輸出（headCallView 內部直接呼叫它）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headCallView } from '../ui/lib/head-call.mjs'
import { CLOSED_REASONS, menuItems } from '../ui/lib/partner-ops.mjs'

const machine = (o = {}) => ({ online: true, launcher: true, ...o })
const ctxOf = (o = {}) => ({ loaded: true, signedIn: true, machines: { M1: machine() }, ...o })
const fr = (o = {}) => ({ id: 'M1/小牧', node: 'M1', agent: '小牧', engine: 'claude', status: 'online', ...o })
const off = (o = {}) => fr({ status: 'offline', ...o })
const kind = (f, c = ctxOf()) => headCallView(f, c).kind

test('#1866 在線：call', () => {
  assert.deepEqual(headCallView(fr(), ctxOf()), { kind: 'call' })
  assert.equal(kind(fr({ engine: 'pi' })), 'call')
})

test('#1866 離線可喚醒（claude、pi）：wake；與 menuItems 的 resume 一致', () => {
  for (const f of [off(), off({ engine: 'claude' }), off({ engine: 'pi' })]) {
    assert.equal(menuItems(f, ctxOf()).find(i => i.key === 'resume').ok, true)
    assert.deepEqual(headCallView(f, ctxOf()), { kind: 'wake' })
  }
})

test('#1866 對方是人：asis', () => {
  assert.equal(kind(fr({ person: true })), 'asis')
  assert.equal(kind(off({ person: true })), 'asis')
})

test('#1866 不支援喚醒的引擎離線：asis', () => {
  for (const engine of ['gemini', 'cloud', 'codex']) assert.equal(kind(off({ engine })), 'asis', engine)
})

test('#1866 那台電腦沒開：asis', () => {
  assert.equal(kind(off(), ctxOf({ machines: { M1: machine({ online: false }) } })), 'asis')
})

test('#1866 沒登入：asis', () => {
  assert.equal(kind(off(), ctxOf({ signedIn: false })), 'asis')
})

test('#1866 未查到電腦設定：asis', () => {
  assert.equal(kind(off(), ctxOf({ loaded: false, machines: {} })), 'asis')
})

test('#1866 沒開放遠端管理：asis', () => {
  const m = machine({ launcher: false, launch_closed_reason: CLOSED_REASONS.noConsent })
  assert.equal(kind(off(), ctxOf({ machines: { M1: m } })), 'asis')
  assert.equal(kind(off(), ctxOf({ machines: { M1: machine({ launcher: false }) } })), 'asis')
})
