// 夥伴卡住的本機提醒（todo-next-162）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPartnerNoticePoller, nextNotices, noticeStillFor, noticeText, permissionView } from '../ui/lib/partner-notice.mjs'

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

test('權限詢問開確認框，不跳一般提醒', async () => {
  const shown = [], items = []
  const p = createPartnerNoticePoller({ fetch: async () => [{ code: 'permission', name: '甲' }, { code: 'login', name: '乙' }], show: t => shown.push(t), onItem: i => items.push(i), setTimer: () => 0 })
  await p.tick()
  await p.tick()
  assert.equal(shown.length, 1)
  assert.deepEqual(items, [{ code: 'permission', name: '甲' }], '只開一次')
})

test('提示不完整就不給允許', () => {
  assert.deepEqual(permissionView({ text: 'mkdir a', complete: true }), { text: 'mkdir a', canAllow: true, canDeny: true, hint: '' })
  const cut = permissionView({ text: '只看到一部分', complete: false })
  assert.equal(cut.canAllow, false)
  assert.equal(cut.canDeny, true)
  assert.ok(cut.hint)
  assert.equal(permissionView({ text: '', complete: true }).canAllow, false)
  assert.equal(permissionView(null).canAllow, false)
})

test('守門：確認框的文字只用純文字顯示', () => {
  const html = fs.readFileSync(path.join(here, '..', 'ui', 'list.html'), 'utf8')
  const i = html.indexOf('v-if="permissionDlg.open"')
  assert.ok(i > 0)
  const block = html.slice(i, html.indexOf('</asn-dialog>', i))
  assert.ok(!block.includes('v-html'), block)
  assert.match(block, /permission-text"><template v-for="\(g, i\) in ruleSegs\(permissionDlgView\.text\)"[^>]*><hr [^>]*v-if="g\.rule"><template v-else>\{\{ g\.text \}\}<\/template>/)
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

test('夥伴回答了：開著的提醒要收掉，別的提醒不動', async () => {
  const a = { code: 'attention', name: '甲' }, b = { code: 'attention', name: '乙' }
  let r = nextNotices([a, b])
  assert.deepEqual(r.gone, [])
  r = nextNotices([b], r.seen)
  assert.deepEqual(r.gone, [a])
  assert.equal(noticeStillFor(a, noticeText(a).body), true)
  assert.equal(noticeStillFor(a, noticeText(b).body), false, '別的夥伴的提醒不動')
  assert.equal(noticeStillFor(a, '開不了終端畫面'), false, '別種提醒不動')
  let list = [a]
  const gone = []
  const p = createPartnerNoticePoller({ fetch: async () => list, show: () => {}, onGone: i => gone.push(i), setTimer: () => 0 })
  await p.tick()
  list = []
  await p.tick()
  assert.deepEqual(gone, [a])
  await p.tick()
  assert.equal(gone.length, 1, '只通知一次')
})

test('畫面開著時：同意框這次先不跳，下一輪再問；畫面關了才跳', async () => {
  const { createPartnerNoticePoller } = await import('../ui/lib/partner-notice.mjs')
  let open = true
  const shown = []
  const p = createPartnerNoticePoller({ fetch: async () => [{ code: 'permission', name: '甲' }], show: () => {}, onItem: async i => { if (open) return false; shown.push(i.name) }, setTimer: () => 0 })
  await p.tick(); await p.tick()
  assert.deepEqual(shown, [], '開著就不跳')
  open = false
  await p.tick()
  assert.deepEqual(shown, ['甲'], '關了下一輪就跳')
  await p.tick()
  assert.deepEqual(shown, ['甲'], '跳過的不再跳')
})

test('畫面上的提示：只對這位夥伴、只有要回答的代號；沒有畫面內容', async () => {
  const { viewHint } = await import('../ui/lib/partner-notice.mjs')
  assert.match(viewHint([{ code: 'permission', name: '甲' }], '甲'), /直接在下面的畫面按數字鍵回答/)
  assert.equal(viewHint([{ code: 'permission', name: '乙' }], '甲'), '')
  assert.equal(viewHint([{ code: 'login', name: '甲' }], '甲'), '', '登入、額度不是在畫面回答的')
  assert.equal(viewHint(null, '甲'), '')
})

test('守門：同意框跳之前先問畫面有沒有開著；畫面元件會顯示提示', () => {
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const fn = list.slice(list.indexOf('async function openPermissionDlg'), list.indexOf('async function answerPermission'))
  assert.match(fn, /invoke\('term_view_active', \{ name: item\.name \}\)\.catch\(\(\) => false\)\) return false/)
  const view = fs.readFileSync(new URL('../ui/lib/term-view.mjs', import.meta.url), 'utf8')
  assert.ok(view.includes('term-view-ask') && view.includes('viewHint('))
})
