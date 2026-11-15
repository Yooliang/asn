// 夥伴選單收成一份（#1559）：四個入口都從 buildPartnerMenu 組，畫面行為跟合併前一模一樣
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SELF, cases, row, slotsOf } from './partner-menu-cases.mjs'
import { managePanelItems, moreMenuItems, opsMenuItems, partnerMenuItems, chatGroupItems, briefWhy as briefFromBar, WHY_MAX as whyMaxFromBar } from '../ui/lib/actionbar.mjs'
import { MENU_SURFACES, WHY_MAX, briefWhy, buildPartnerMenu } from '../ui/lib/partner-menu.mjs'

const MATRIX = JSON.parse(fs.readFileSync(new URL('./fixtures/partner-menu-matrix.json', import.meta.url), 'utf8'))

// 重構後的四個入口：右鍵、Aero「管理」、「更多」照舊呼叫 actionbar 的函式（內部改由 buildPartnerMenu 組）；手機直接呼叫 buildPartnerMenu（m.js 的 opsRows）
const surfacesAfter = (friend, ctx) => ({
  context: partnerMenuItems(friend, ctx, SELF).map(row),
  panel: managePanelItems(friend, ctx, opsMenuItems(friend), { selfNode: SELF }).map(row),
  more: moreMenuItems(friend, { ops: ctx, selfNode: SELF, slots: slotsOf(friend, ctx), term: false, subLabel: '' }).map(row),
  phone: [...buildPartnerMenu(friend, ctx, 'phone'), ...chatGroupItems(friend)].map(row),
})

test('對照表：夥伴種類 × 狀態 × 電腦 × 登入／設定 × 四個入口，跟合併前（main 8a5d8034）的輸出逐格相同', () => {
  const all = cases()
  assert.equal(all.length, Object.keys(MATRIX).length, '情境數跟對照表一樣')
  let diffs = []
  for (const c of all) {
    const want = MATRIX[c.name]
    assert.ok(want, `對照表少了 ${c.name}`)
    const got = surfacesAfter(c.friend, c.ctx)
    for (const s of MENU_SURFACES) if (JSON.stringify(got[s]) !== JSON.stringify(want[s])) diffs.push(`${c.name} ${s}\n  前：${JSON.stringify(want[s])}\n  後：${JSON.stringify(got[s])}`)
  }
  assert.deepEqual(diffs.slice(0, 5), [], `共 ${diffs.length} 格不同`)
})

test('對照表涵蓋得夠：每個入口都有亮的、灰的，右鍵與「管理」有空的情況，而且四個入口彼此不同', () => {
  for (const s of MENU_SURFACES) {
    const rows = Object.values(MATRIX).map(v => v[s])
    if (s === 'context' || s === 'panel') assert.ok(rows.some(r => r.length === 0), `${s}：有空選單（不是 AI 夥伴）`)
    assert.ok(rows.some(r => r.some(x => x.split('|')[2] === 'ok')), `${s}：有可以按的`)
    assert.ok(rows.some(r => r.some(x => x.split('|')[2] === 'no')), `${s}：有變灰的`)
  }
  const one = MATRIX['claude|idle|P|ok']
  assert.equal(new Set(MENU_SURFACES.map(s => JSON.stringify(one[s]))).size, 4)
})

test('共用清單不放「納入管理」：只有電腦版的入口在後面另外附加', () => {
  for (const c of cases()) {
    for (const s of MENU_SURFACES) {
      const keys = buildPartnerMenu(c.friend, c.ctx, s, { slots: slotsOf(c.friend, c.ctx) }).map(i => i.key)
      assert.ok(!keys.includes('p:adopt') && !keys.includes('adopt'), `${c.name} ${s}`)
    }
  }
  const f = { node: SELF, agent: 'c', nick: 'c', status: 'idle' }
  const ctx = { machines: { P: { online: true, launcher: {} } }, loaded: true, signedIn: true }
  assert.ok(partnerMenuItems(f, ctx, SELF).some(i => i.key === 'p:adopt'), '名單右鍵照舊有')
  assert.ok(managePanelItems(f, ctx, [], { selfNode: SELF }).some(i => i.key === 'p:adopt'), 'Aero「管理」照舊有')
  assert.ok(moreMenuItems(f, { ops: ctx, selfNode: SELF, slots: slotsOf(f, ctx) }).some(i => i.key === 'p:adopt'), '「更多」照舊有')
})

test('入口寫錯就報錯；反灰原因縮短搬家後 actionbar 照舊轉出同一個函式', () => {
  assert.throws(() => buildPartnerMenu({ node: SELF, agent: 'c' }, {}, 'menu'), /不認得的選單入口：menu/)
  assert.equal(briefFromBar, briefWhy)
  assert.equal(whyMaxFromBar, WHY_MAX)
})

test('四個入口只負責畫出來：手機 m.js 用 buildPartnerMenu，不再自己組', () => {
  const m = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(m, /buildPartnerMenu\(chatFriend\.value, opsCtx\.value, 'phone'\)/)
  assert.doesNotMatch(m, /phoneOpsRows\(/)
  const bar = fs.readFileSync(new URL('../ui/lib/actionbar.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(bar, /phoneOpsRows\(|manageItems\(/, 'actionbar 不再直接組管理段')
})
