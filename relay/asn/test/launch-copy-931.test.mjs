// #931 開新夥伴「運行」的名稱與畫面文案：手機與電腦版共用同一份目錄；畫面上的字不放議題編號、版本號與開發者自白。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_CATALOG, RUN_OPTION_LABEL, customRunOptions, runOptions } from '../ui/lib/model-catalog.mjs'
import { PI_ONLY_CHANNELS, PI_REMOTE_NO_LIST, PI_REMOTE_NO_PI, PI_REMOTE_VERSION_NOTE, launchRun } from '../ui/lib/mobile-launch.mjs'

const DEV_WORDS = [/#\d+/, /\d+\.\d+\.\d+/, /真機/, /帳務風險/, /沒實測|還沒有實際用過|刻意不做/]

function screenTexts() {
  const out = []
  for (const m of MODEL_CATALOG) {
    out.push([`${m.id}.modeLabel`, m.modeLabel])
    for (const [k, c] of Object.entries(m.channels ?? {})) out.push([`${m.id}.channels.${k}.why`, c.why])
    for (const ctx of [{ local: true, piInstalled: true, piReady: true }, { local: false, piInstalled: false }, { local: true, piInstalled: true, piReady: false }]) {
      for (const o of runOptions(m, ctx).options) out.push([`${m.id}.${o.key}`, `${o.label}｜${o.why}｜${o.note}`])
    }
    for (const o of launchRun(m, null).options) out.push([`遠端 ${m.id}.${o.key}`, `${o.label}｜${o.why}｜${o.note}`])
  }
  for (const mode of ['window', 'background']) for (const o of customRunOptions({ mode }).options) out.push([`自訂 ${mode}.${o.key}`, `${o.label}｜${o.why}`])
  for (const [k, c] of Object.entries(PI_ONLY_CHANNELS)) out.push([`只能經 pi.${k}`, c.why])
  out.push(['PI_REMOTE_NO_LIST', PI_REMOTE_NO_LIST], ['PI_REMOTE_NO_PI', PI_REMOTE_NO_PI], ['PI_REMOTE_VERSION_NOTE', PI_REMOTE_VERSION_NOTE])
  return out
}

test('運行四個選項的名稱照小良哥 11/06 定案（手機與電腦版同一份）', () => {
  assert.deepEqual(RUN_OPTION_LABEL, { acp: 'acp通道（無介面）', pi: 'asn終端（pi shell）', term: 'asn終端（原生 cli）', self: '原始 cli 視窗' })
})

test('畫面上的開新夥伴文案不放議題編號、版本號、「真機」「帳務風險」這類開發者用語', () => {
  for (const [where, text] of screenTexts()) {
    for (const re of DEV_WORDS) assert.doesNotMatch(String(text ?? ''), re, `${where}：${text}`)
  }
})

test('限制照樣寫給使用者看：Grok／Gemini 的終端收不到信、只能在那台開；原始 cli 視窗不能從這裡開', () => {
  const grok = MODEL_CATALOG.find(m => m.id === 'grok')
  const local = runOptions(grok, { local: true }).options.find(o => o.key === 'term')
  assert.ok(local.ok); assert.match(local.note, /收不到信/); assert.match(local.note, /只能看畫面、送字/); assert.match(local.note, /只能在這台電腦上開/)
  const remote = runOptions(grok, { local: false }).options.find(o => o.key === 'term')
  assert.equal(remote.ok, false); assert.match(remote.why, /只能在那台電腦上開/)
  const self = runOptions(MODEL_CATALOG.find(m => m.id === 'claude')).options.find(o => o.key === 'self')
  assert.equal(self.ok, false); assert.match(self.note, /自己開 claude/); assert.match(self.why, /不能從這裡開/)
})
