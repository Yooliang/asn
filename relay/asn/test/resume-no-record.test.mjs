// 喚醒找不到對話紀錄（#1614，#1907 改）：狀態列只有一行字、不放按鈕，所以 progressView 不再給 action、手機橫幅與電腦提示列都沒有「開新夥伴」鈕；
// 操作對話框（partner-op-dialog）原本的「開新夥伴」不受影響。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NO_RECORD_TEXT, progressView } from '../ui/lib/partner-ops.mjs'
import { runPartnerOp } from '../ui/lib/partner-ops-ui.mjs'
import { runBanner } from '../ui/lib/mobile-ops.mjs'

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('喚醒找不到對話紀錄（電腦端原句或後台代號）：view 只有一行字（含找不到紀錄的白話），沒有 action', () => {
  for (const detail of [NO_RECORD_TEXT, 'no_session', ' ' + NO_RECORD_TEXT + ' ']) {
    const v = progressView({ status: 'failed', detail }, { op: 'resume' })
    assert.deepEqual(v, { phase: 'failed', done: true, text: '沒有成功：' + NO_RECORD_TEXT, noRetry: true }, detail)
    assert.equal(v.action, undefined, detail)
    assert.match(v.text, new RegExp(NO_RECORD_TEXT))
  }
})

test('其他失敗、其他動作也都沒有 action（一律只有一行字）', () => {
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

test('送出時後台就回 no_session：失敗畫面是對話紀錄白話、沒有 action；其他錯誤也沒有', async () => {
  const api = msg => ({ partnerOp: async () => { throw new Error(msg) }, partnerOps: async () => ({ ops: [] }) })
  const f = { id: 'H/A', node: 'H', agent: 'A', nick: 'A', engine: 'claude', status: 'offline' }
  const v = await runPartnerOp(api('partner_op HTTP 409 no_session'), f, 'resume', {}, { onUpdate: () => {} })
  assert.equal(v.phase, 'failed')
  assert.match(v.text, /對話紀錄/)
  assert.doesNotMatch(v.text, /no_session|HTTP|409/, '畫面不放原文')
  assert.equal(v.action, undefined)
  assert.equal(v.noRetry, true)
  assert.doesNotMatch(runBanner({ op: 'resume', view: v }).text, /再按一次/, '沒有對話紀錄時狀態列不接重試句')
  const w = await runPartnerOp(api('partner_op HTTP 409 busy'), f, 'resume', {}, { onUpdate: () => {} })
  assert.equal(w.action, undefined)
})

test('手機橫幅：只有 phase／done／text／hideMs，沒有 action', () => {
  const v = progressView({ status: 'failed', detail: NO_RECORD_TEXT }, { op: 'resume' })
  const b = runBanner({ op: 'resume', view: v })
  assert.equal(b.action, undefined)
  assert.deepEqual(Object.keys(b).sort(), ['done', 'hideMs', 'phase', 'text'])
  assert.equal(b.text, '沒有成功：' + NO_RECORD_TEXT)
})

test('模板：電腦提示列與手機橫幅沒有開新夥伴鈕、沒有 launch-new 接線；對話框的開新夥伴照舊', () => {
  const ui = read('ui/lib/partner-ops-ui.mjs')
  // 狀態列（提示列／手機橫幅）：沒有
  assert.doesNotMatch(ui, /v-if="it\.b\.action/, '提示列沒有開新夥伴鈕')
  assert.doesNotMatch(ui, /launchNew\(it\.id\)/)
  assert.doesNotMatch(read('ui/list.html'), /@launch-new="launchNewFromRun"/)
  assert.doesNotMatch(read('ui/list.js'), /launchNewFromRun/)
  assert.doesNotMatch(read('ui/lib/actionbar.mjs'), /<partner-op-strip [^>]*@launch-new/)
  // #2177：手機的進度改顯示在對話最下面那條狀態列（chat-pane 的 .typing），不再有獨立橫幅；那一行沒有按鈕
  const typing = read('ui/lib/chatpane.mjs').match(/<div class="typing"[\s\S]*?<template v-else-if="opLine">([^<]*)<\/template>/)?.[1] ?? ''
  assert.ok(typing.includes('opLine.text'))
  assert.doesNotMatch(typing, /launchNewFromBanner|開新夥伴|<button/)
  assert.doesNotMatch(read('ui/m.html'), /launchNewFromBanner/)
  assert.doesNotMatch(read('ui/m.js'), /launchNewFromBanner/)
  // 對話框：原本的鈕與接線仍在
  assert.match(ui, /v-if="st\.view && st\.view\.action && st\.view\.action\.kind === 'launch-new'" @click="launchNew">\{\{ T\.launchNew \}\}</)
  assert.match(ui, /emits: \['close', 'done', 'launch-new', 'run'\]/)
  assert.match(read('ui/list.html'), /@launch-new="launchNewFromOp"/)
  assert.match(read('ui/list.js'), /function launchNewFromOp\(e\) \{ closeOpDlg\(\); openPartnerDlg\(e\?\.node \|\| ''\) \}/)
})
