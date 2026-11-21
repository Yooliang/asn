// #1866 ①：對話頁右上角通話／喚醒的共用判斷。輸入用真的 menuItems 輸出（headCallView 內部直接呼叫它），ctx／run 用真實形狀
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headCallView } from '../ui/lib/head-call.mjs'
import { CLOSED_REASONS, NO_RECORD_TEXT, REASON, menuItems, progressView } from '../ui/lib/partner-ops.mjs'

const machine = (o = {}) => ({ online: true, launcher: true, ...o })
const ctxOf = (o = {}) => ({ loaded: true, signedIn: true, machines: { M1: machine() }, ...o })
const fr = (o = {}) => ({ id: 'M1/小牧', node: 'M1', agent: '小牧', engine: 'claude', status: 'online', ...o })
const off = (o = {}) => fr({ status: 'offline', ...o })
const run = (view, op = 'resume') => ({ op, name: '小牧', view })
const NO_CODE = /[A-Za-z_]{4,}_[A-Za-z_]+|HTTP|launcher|resume|no_session/

test('在線：call', () => {
  assert.deepEqual(headCallView(fr(), ctxOf()), { kind: 'call', reason: '' })
  assert.deepEqual(headCallView(fr({ engine: 'pi' }), ctxOf()), { kind: 'call', reason: '' })
})

test('離線可喚醒（claude、pi）：wake；與 menuItems 的 resume 一致', () => {
  for (const f of [off(), off({ engine: 'claude' }), off({ engine: 'pi' })]) {
    assert.equal(menuItems(f, ctxOf()).find(i => i.key === 'resume').ok, true)
    assert.deepEqual(headCallView(f, ctxOf()), { kind: 'wake', reason: '' })
  }
})

test('喚醒中：working 與剛成功（名單還沒變在線）都是 waking', () => {
  assert.equal(headCallView(off(), ctxOf(), run(progressView({ status: 'taken' }, { op: 'resume' }))).kind, 'waking')
  assert.equal(headCallView(off(), ctxOf(), run(progressView(null, { op: 'resume' }))).kind, 'waking')
  assert.equal(headCallView(off(), ctxOf(), run(progressView({ status: 'ok' }, { op: 'resume' }))).kind, 'waking')
})

test('失敗可重試：retry，原因不含「沒有成功：」前綴與程式代號', () => {
  const v = headCallView(off(), ctxOf(), run(progressView({ status: 'failed', detail: '視窗開不起來' }, { op: 'resume' })))
  assert.equal(v.kind, 'retry')
  assert.equal(v.reason, '視窗開不起來')
  assert.doesNotMatch(v.reason, NO_CODE)
  assert.equal(headCallView(off(), ctxOf(), run({ phase: 'unconfirmed', done: true, text: 'x' })).kind, 'retry')
})

test('找不到對話紀錄：重試沒用，callgrey', () => {
  const v = headCallView(off(), ctxOf(), run(progressView({ status: 'failed', detail: NO_RECORD_TEXT }, { op: 'resume' })))
  assert.equal(v.kind, 'callgrey')
  assert.match(v.reason, /只能開新的夥伴/)
  assert.equal(headCallView(off(), ctxOf(), run({ phase: 'failed', done: true, text: `沒有成功：${NO_RECORD_TEXT}`, noRetry: true })).kind, 'callgrey')
})

test('別的操作的進度不影響喚醒鈕', () => {
  assert.equal(headCallView(off(), ctxOf(), run({ phase: 'working', done: false, text: '' }, 'rename')).kind, 'wake')
})

test('對方是人：callgrey', () => {
  const v = headCallView(fr({ person: true }), ctxOf())
  assert.equal(v.kind, 'callgrey')
  assert.ok(v.reason)
})

test('ACP、雲端、其他引擎離線：callgrey，原因照 menuItems 的 resume', () => {
  for (const engine of ['gemini', 'cloud', 'codex']) {
    const f = off({ engine })
    const why = menuItems(f, ctxOf()).find(i => i.key === 'resume').reason
    assert.ok(why, engine)
    assert.deepEqual(headCallView(f, ctxOf()), { kind: 'callgrey', reason: why })
  }
})

test('那台電腦沒開：callgrey', () => {
  assert.deepEqual(headCallView(off(), ctxOf({ machines: { M1: machine({ online: false }) } })), { kind: 'callgrey', reason: REASON.deviceOffline })
})

test('沒登入：callgrey', () => {
  assert.deepEqual(headCallView(off(), ctxOf({ signedIn: false })), { kind: 'callgrey', reason: REASON.needLogin })
})

test('未查到電腦設定：callgrey', () => {
  const v = headCallView(off(), ctxOf({ loaded: false, machines: {} }))
  assert.equal(v.kind, 'callgrey')
  assert.ok(v.reason)
})

test('沒開放遠端管理：callgrey，原因照那台寫的', () => {
  const m = machine({ launcher: false, launch_closed_reason: CLOSED_REASONS.noConsent })
  assert.deepEqual(headCallView(off(), ctxOf({ machines: { M1: m } })), { kind: 'callgrey', reason: CLOSED_REASONS.noConsent })
  assert.equal(headCallView(off(), ctxOf({ machines: { M1: machine({ launcher: false }) } })).reason, REASON.closed)
})

test('條件不符時，舊的失敗進度不能蓋過原因（電腦後來關了）', () => {
  const r = run(progressView({ status: 'failed', detail: '視窗開不起來' }, { op: 'resume' }))
  assert.equal(headCallView(off(), ctxOf({ machines: { M1: machine({ online: false }) } }), r).kind, 'callgrey')
})
