// #1799 守門：不再有「夥伴需要你看一下（停在一個選單）」提醒框；判斷結果只寫進 ui.log。
// 擁有者 11-23：「如果選項跳得出來，也不需要這個通知；有通知卻沒有選項，也不需要。這通知用處不大。」
// 權限確認轉手機（bridge-perm-phone）與夥伴自己的確認畫面走別的路，這張不能連帶拿掉它們。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nextNotices, noticeText, viewHint } from '../ui/lib/partner-notice.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'vendor' || e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]))

test('#1799 前端沒有任何路徑會顯示「停在一個選單」提醒（電腦與手機）', () => {
  const item = { code: 'attention', name: '甲' }
  assert.equal(noticeText(item), null, '代號 attention 沒有提醒文字')
  const r = nextNotices([item])
  assert.deepEqual([r.fresh, r.freshItems], [[], []], '輪詢不會產生提醒')
  assert.equal(viewHint([item], '甲'), '', '終端畫面也沒有這句提示')
  for (const f of walk(path.join(root, 'ui')).filter(f => /\.(mjs|js|html)$/.test(f))) {
    const s = fs.readFileSync(f, 'utf8')
    assert.ok(!s.includes('夥伴需要你看一下') && !s.includes('停在一個選單'), `${path.relative(root, f)} 不能有這個提醒的字`)
  }
})

test('#1799 後端不把「認不得的選單」放進提醒清單，只寫 ui.log', () => {
  const term = read('src-tauri/src/launch/term.rs')
  const body = term.split('pub fn start_screen_watch(')[1].split('pub fn live(')[0]
  assert.match(body, /notice_for\(name, code\)/, '提醒清單要經過 notice_for（attention 回 None）')
  assert.ok(!body.includes('PartnerNotice { name: name.clone(), code }'), '不能繞過 notice_for')
  assert.match(body, /attention_log_line\(name\)/, '判斷結果要寫 ui.log')
  assert.match(term, /pub fn notice_for\([^)]*\) -> Option<PartnerNotice> \{\n\s+\(code != ATTENTION_CODE\)/)
})

test('#1799 這張不影響權限確認轉手機與夥伴自己的確認畫面', () => {
  // 前端：權限、提問、信任等提醒與同意框照舊
  for (const code of ['permission', 'trust', 'bypass_warning', 'login', 'usage_limit', 'usage_menu', 'question', 'held_message']) {
    assert.ok(noticeText({ code, name: '甲' }), `${code} 的提醒還在`)
  }
  assert.deepEqual(nextNotices([{ code: 'permission', name: '甲' }]).freshItems, [{ code: 'permission', name: '甲' }], '本機同意框照舊')
  // 後端：手機與本機確認走的函式不讀提醒清單
  const term = read('src-tauri/src/launch/term.rs')
  for (const f of ['pub fn partner_phone_offer(', 'pub fn partner_phone_answer(', 'pub fn partner_permission_prompt(', 'pub fn partner_permission_answer(', 'pub fn partner_permission_choose(']) {
    const b = term.split(f)[1].split('\n}\n')[0]
    assert.ok(!/PARTNER_NOTICES|notice_for/.test(b), f)
  }
  // 手機端沒有輪詢這份提醒，權限轉手機走 perm_remote
  assert.ok(!read('ui/m.js').includes('partnerNotices'))
  assert.match(read('src-tauri/src/perm_remote.rs'), /partner_phone_offer/)
})
