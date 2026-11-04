// 夥伴卡住的本機提醒（todo-next-162）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPartnerNoticePoller, nextNotices, noticeText } from '../ui/lib/partner-notice.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('每個代號都有固定的字，不認得的代號或內容不顯示', () => {
  for (const code of ['permission', 'trust', 'bypass_warning', 'login', 'usage_limit', 'attention']) {
    const t = noticeText({ code, name: '甲' })
    assert.ok(t.title && t.body.includes('「甲」'), code)
  }
  for (const bad of [{ code: 'rm -rf /', name: '甲' }, { code: 'constructor', name: '甲' }, { code: 'login' }, { code: 'login', name: 7 }, null, {}]) {
    assert.equal(noticeText(bad), null, JSON.stringify(bad))
  }
})

test('多帶的欄位不會顯示', () => {
  const t = noticeText({ code: 'permission', name: '甲', text: '畫面內容', detail: '指令內容' })
  assert.ok(!JSON.stringify(t).includes('畫面內容') && !JSON.stringify(t).includes('指令內容'))
})

test('同一個提示只提醒一次，消失後再出現才再提醒', () => {
  const item = { code: 'login', name: '甲' }
  let r = nextNotices([item])
  assert.equal(r.fresh.length, 1)
  r = nextNotices([item], r.seen)
  assert.equal(r.fresh.length, 0, '還在，不重複跳')
  r = nextNotices([], r.seen)
  assert.equal(r.fresh.length, 0)
  r = nextNotices([item], r.seen)
  assert.equal(r.fresh.length, 1, '消失後再出現')
  r = nextNotices([item, { code: 'login', name: '乙' }], r.seen)
  assert.equal(r.fresh.length, 1, '另一扇各算各的')
  assert.equal(nextNotices('不是清單').fresh.length, 0)
})

test('查失敗不影響下一輪，不會誤跳', async () => {
  const shown = []
  let fail = true
  const p = createPartnerNoticePoller({ fetch: async () => { if (fail) throw new Error('沒有這個命令'); return [{ code: 'login', name: '甲' }] }, show: t => shown.push(t), setTimer: () => 0 })
  await p.tick()
  assert.equal(shown.length, 0)
  fail = false
  await p.tick()
  assert.equal(shown.length, 1)
})

test('守門：命令只接在本機畫面，截圖模式不輪詢', () => {
  const list = fs.readFileSync(path.join(here, '..', 'ui', 'list.js'), 'utf8')
  assert.match(list, /if \(!info\.shot\) createPartnerNoticePoller/)
  const mobile = fs.readFileSync(path.join(here, '..', 'ui', 'm.js'), 'utf8')
  assert.ok(!mobile.includes('partner-notice') && !mobile.includes('partnerNotices'))
})
