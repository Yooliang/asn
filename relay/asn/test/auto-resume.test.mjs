import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { autoResumeNotice, createAutoResumePoller } from '../ui/lib/auto-resume.mjs'

test('接回完成：顯示位數，說明權限相同、收到信才工作、會用額度', () => {
  const n = autoResumeNotice({ state: 'done', resumed: ['甲', '乙'], failed: [] })
  assert.equal(n.title, '已自動接回 2 位夥伴')
  assert.match(n.body, /權限和原本相同/)
  assert.match(n.body, /收到信就會繼續工作/)
  assert.doesNotMatch(n.body, /重新開始工作/, '接回時沒有第一句話，不會自己開始做事')
  assert.match(n.body, /額度/)
})

test('設定頁的說明也寫實際行為：收到信才工作，不寫重新開始工作', () => {
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(panel, /接回原本的對話。權限和原本相同，收到信就會繼續工作，也會用到額度。/)
  assert.doesNotMatch(panel, /重新開始工作/)
})

test('接不回來的一定列出名字與原因', () => {
  const n = autoResumeNotice({ state: 'done', resumed: ['甲'], failed: [{ name: '乙', reason: '卡住了' }] })
  assert.match(n.body, /「乙」：卡住了/)
  assert.match(n.body, /12 小時/)
  const all = autoResumeNotice({ state: 'done', resumed: [], failed: [{ name: '乙', reason: '卡住了' }] })
  assert.equal(all.title, '夥伴沒有接回來')
  const many = autoResumeNotice({ state: 'done', resumed: [], failed: Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, reason: 'x' })) })
  assert.match(many.body, /還有 2 位沒列出/)
})

test('等登入、記憶體不足要講原因；進行中與沒有結果不跳', () => {
  assert.match(autoResumeNotice({ state: 'waiting_login' }).body, /重新登入/)
  assert.match(autoResumeNotice({ state: 'paused_memory' }).body, /3 GB/)
  for (const s of [null, undefined, 'x', {}, { state: 'running' }, { state: '怪' }, { state: 'done', resumed: [], failed: [] }]) assert.equal(autoResumeNotice(s), null)
})

test('同一階段只跳一次，換階段才再跳；查失敗不中斷', async () => {
  const shown = []
  const replies = [{ state: 'waiting_login' }, { state: 'waiting_login' }, { state: 'running' }, new Error('舊版'), { state: 'done', resumed: ['甲'], failed: [] }, { state: 'done', resumed: ['甲'], failed: [] }]
  const p = createAutoResumePoller({ fetch: async () => { const r = replies.shift(); if (r instanceof Error) throw r; return r }, show: x => shown.push(x.title) })
  for (let i = 0; i < 6; i++) await p.tick()
  assert.deepEqual(shown, ['夥伴還沒接回來', '已自動接回 1 位夥伴'])
})

test('接回的名字也列出來（最多 10 位，其餘寫還有幾位）；沒接回的不列接回行', () => {
  const n = autoResumeNotice({ state: 'done', resumed: ['asn西川', '家用正見'], failed: [] })
  assert.match(n.body, /接回的是：「asn西川」、「家用正見」/)
  const many = autoResumeNotice({ state: 'done', resumed: Array.from({ length: 12 }, (_, i) => `p${i}`), failed: [] })
  assert.match(many.body, /「p9」，還有 2 位/)
  assert.doesNotMatch(many.body, /p10/)
  const none = autoResumeNotice({ state: 'done', resumed: [], failed: [{ name: '乙', reason: 'x' }] })
  assert.doesNotMatch(none.body, /接回的是/)
  // 名字不是字串的丟掉，不當成空白行
  const odd = autoResumeNotice({ state: 'done', resumed: ['甲', 7, '', null], failed: [] })
  assert.match(odd.body, /接回的是：「甲」/)
})
