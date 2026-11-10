// 外來訊息確認框：電腦與手機的提示框（只有本人按了才放行）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HELD_HINT, HELD_LABELS, heldTitle, isHeldOptions } from '../ui/lib/held.mjs'
import { createPartnerNoticePoller, nextNotices, noticeText, permissionView, viewHint } from '../ui/lib/partner-notice.mjs'

const read = f => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('電腦提示框：外來訊息的標題、提醒、兩顆按鈕；沒有「以後都放行」', () => {
  const v = permissionView({ kind: 'held_message', text: '對方自稱：小乙\n要讓這則外來訊息進到這位夥伴嗎？', complete: true }, '甲')
  assert.equal(v.held, true)
  assert.equal(v.title, '要讓這則外來訊息進到「甲」嗎？')
  assert.equal(v.hint, '對方自稱的名字不一定是真的。放行後，整封會送進這位夥伴。')
  assert.deepEqual([v.denyLabel, v.allowLabel], ['不放行', '放行這一則'])
  assert.equal(v.canAllow, true)
  assert.equal(v.canDeny, true)
  assert.ok(!JSON.stringify(v).includes('以後'))
  assert.equal(permissionView({ kind: 'held_message', text: '', complete: true }, '甲').canAllow, false, '沒有內容不給放行')
  // 一般權限框不變
  assert.equal(permissionView({ kind: 'permission', text: 'mkdir a', complete: true }).held, undefined)
  assert.deepEqual(permissionView({ text: 'mkdir a', complete: true }), { text: 'mkdir a', canAllow: true, canDeny: true, hint: '' })
})

test('外來訊息：提醒有固定字、開確認框而不是一般提醒、提示消失會收掉', async () => {
  assert.match(noticeText({ code: 'held_message', name: '甲' }).body, /外來訊息/)
  const r = nextNotices([{ code: 'held_message', name: '甲' }])
  assert.equal(r.fresh.length, 0)
  assert.deepEqual(r.freshItems, [{ code: 'held_message', name: '甲' }])
  const gone = []
  let list = [{ code: 'held_message', name: '甲' }]
  const p = createPartnerNoticePoller({ fetch: async () => list, show: () => {}, onGone: i => gone.push(i), setTimer: () => 0 })
  await p.tick()
  list = []
  await p.tick()
  assert.deepEqual(gone, [{ code: 'held_message', name: '甲' }])
  assert.match(viewHint([{ code: 'held_message', name: '甲' }], '甲'), /外來訊息/)
})

test('守門：電腦的確認框只用文字節點、收掉提示時也收這個框、按鈕呼叫既有的回答命令', () => {
  const list = read('../ui/list.js')
  assert.match(list, /\(item\.code === 'permission' \|\| item\.code === 'held_message'\) && permissionDlg\.open/)
  assert.match(list, /permissionView\(permissionDlg\.prompt, permissionDlg\.name\)/)
  const html = read('../ui/list.html')
  assert.ok(!/v-html/.test(html.slice(html.indexOf('permissionDlg.open'), html.indexOf('launchNotice.open'))))
  assert.match(html, /permissionDlgView\.held \? permissionDlgView\.denyLabel/)
  assert.match(html, /@click="answerPermission\(false\)"/)
  assert.match(html, /@click="answerPermission\(true\)"/)
})

test('手機：選項剛好是「不放行」「放行這一則」才算外來訊息框', () => {
  assert.deepEqual([...HELD_LABELS], ['不放行', '放行這一則'])
  assert.equal(isHeldOptions([{ n: 1, label: '不放行' }, { n: 2, label: '放行這一則' }]), true)
  assert.equal(isHeldOptions([{ n: 1, label: '只有這一次' }, { n: 3, label: '拒絕' }]), false)
  assert.equal(isHeldOptions([{ n: 2, label: '不放行' }, { n: 1, label: '放行這一則' }]), false, '編號對不上')
  assert.equal(isHeldOptions([{ n: 1, label: '不放行' }]), false)
  assert.equal(isHeldOptions([]), false, '只能看的時候沒有按鈕')
  assert.equal(isHeldOptions(undefined), false)
  assert.equal(heldTitle('乙'), '要讓這則外來訊息進到「乙」嗎？')
  assert.equal(heldTitle(''), '要讓這則外來訊息進到這位夥伴嗎？')
  assert.equal(HELD_HINT, '對方自稱的名字不一定是真的。放行後，整封會送進這位夥伴。')
})

test('守門：手機的請求單改標題與提醒，文字節點顯示、不走 v-html', () => {
  const js = read('../ui/m.js')
  assert.match(js, /const permHeld = computed\(\(\) => isHeldOptions\(pq\.cur\?\.options\)\)/)
  assert.match(js, /permShownTitle = computed\(\(\) => permHeld\.value \? heldTitle\(pq\.cur\?\.window\)/)
  assert.match(js, /permShownTitle, permHeld, HELD_HINT/)
  const html = read('../ui/m.html')
  const sheet = html.slice(html.indexOf("nav.sheet === 'permreq'"), html.indexOf('<group-sheet'))
  assert.match(sheet, /\{\{ permShownTitle \}\}/)
  assert.match(sheet, /v-if="permHeld">\{\{ HELD_HINT \}\}/)
  assert.ok(!sheet.includes('v-html'))
})
