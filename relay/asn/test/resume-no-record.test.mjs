// 喚醒找不到對話紀錄時附「開新夥伴」（#1614）：progressView 給 action，電腦版對話框與手機橫幅各多一顆按鈕
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NO_RECORD_TEXT, progressView } from '../ui/lib/partner-ops.mjs'
import { runPartnerOp } from '../ui/lib/partner-ops-ui.mjs'
import { runBanner } from '../ui/lib/mobile-ops.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('喚醒找不到對話紀錄（電腦端原句或後台代號）：附開新夥伴動作', () => {
  for (const detail of [NO_RECORD_TEXT, 'no_session', ` ${NO_RECORD_TEXT} `]) {
    const v = progressView({ status: 'failed', detail }, { op: 'resume' })
    assert.deepEqual(v.action, { kind: 'launch-new' }, detail)
    assert.equal(v.text, `沒有成功：${NO_RECORD_TEXT}`)
    assert.equal(v.phase, 'failed')
  }
})

test('其他失敗、其他動作都不附開新夥伴', () => {
  assert.equal(progressView({ status: 'failed', detail: '這位夥伴已經在線上' }, { op: 'resume' }).action, undefined)
  assert.equal(progressView({ status: 'failed', detail: 'expired' }, { op: 'resume' }).action, undefined)
  assert.equal(progressView({ status: 'failed', detail: NO_RECORD_TEXT }, { op: 'handover' }).action, undefined)
  assert.equal(progressView({ status: 'ok' }, { op: 'resume' }).action, undefined)
})

test('常數和 Rust 的 NO_RECORD 逐字相同', () => {
  const rs = read('src-tauri/src/bridge/partner_ops.rs')
  const m = /const NO_RECORD: &str = "([^"]+)";/.exec(rs)
  assert.ok(m, '找得到 Rust 常數')
  assert.equal(m[1], NO_RECORD_TEXT)
})

test('送出時後台就回 no_session：失敗畫面也附動作；其他錯誤不附', async () => {
  const api = msg => ({ partnerOp: async () => { throw new Error(msg) }, partnerOps: async () => ({ ops: [] }) })
  const f = { id: 'H/A', node: 'H', agent: 'A', nick: 'A', engine: 'claude', status: 'offline' }
  const v = await runPartnerOp(api('partner_op HTTP 409 no_session'), f, 'resume', {}, { onUpdate: () => {} })
  assert.deepEqual(v.action, { kind: 'launch-new' })
  const w = await runPartnerOp(api('partner_op HTTP 409 busy'), f, 'resume', {}, { onUpdate: () => {} })
  assert.equal(w.action, undefined)
})

test('手機橫幅帶出 action', () => {
  const v = progressView({ status: 'failed', detail: NO_RECORD_TEXT }, { op: 'resume' })
  assert.deepEqual(runBanner({ op: 'resume', view: v }).action, { kind: 'launch-new' })
  assert.equal(runBanner({ op: 'close', view: { phase: 'done', done: true, text: 'x' } }).action, null)
})

test('模板：電腦版對話框與手機橫幅有開新夥伴鈕並接到既有入口', () => {
  const ui = read('ui/lib/partner-ops-ui.mjs')
  assert.match(ui, /v-if="st\.view && st\.view\.action && st\.view\.action\.kind === 'launch-new'" @click="launchNew">開新夥伴</)
  assert.match(ui, /emits: \['close', 'done', 'launch-new'\]/)
  assert.match(read('ui/list.html'), /@launch-new="launchNewFromOp"/)
  assert.match(read('ui/list.js'), /function launchNewFromOp\(e\) \{ closeOpDlg\(\); openPartnerDlg\(e\?\.node \|\| ''\) \}/)
  assert.match(read('ui/m.html'), /v-if="opsBanner\.action && opsBanner\.action\.kind === 'launch-new'" @click="launchNewFromBanner">開新夥伴</)
  assert.match(read('ui/m.js'), /const node = chatFriend\.value\?\.node \|\| ''; dismissRun\(\); openLaunch\(node\)/)
})
