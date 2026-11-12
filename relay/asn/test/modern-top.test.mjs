// 現代外觀的電腦頂部與左欄（#1421 B）：「更多」選單的項目與順序、名牌、新節點在復古 Aero 下預設藏起來、現代下收起舊的分頁列與大按鈕區。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { barSlots, chatGroupItems, groupMenuItems, moreMenuItems, nameplateView } from '../ui/lib/actionbar.mjs'
import { manageItems } from '../ui/lib/archive.mjs'
import { phoneOpsRows } from '../ui/lib/mobile-ops.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const F = (node, agent, extra = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', engine: 'claude', device: `設備${node}`, ...extra })
const machines = { H: { node: 'H', online: true, launcher: { profiles: [{ id: 'claude' }] } } }
const ops = { machines, loaded: true, signedIn: true, nonWindowNodes: ['P'] }

function build(friend, extra = {}) {
  const ctx = { selfNode: 'H', api: true, callable: true, ops, subagents: true, tasks: true, manageCount: 5, ...extra }
  const slots = Object.fromEntries(barSlots(friend, ctx).map(s => [s.key, s]))
  return moreMenuItems(friend, { ops, selfNode: 'H', slots, term: Boolean(extra.term), subLabel: '子代理' })
}
const keys = items => items.map(i => i.key)

test('更多：前段與手機「⋯」同一份（phoneOpsRows 順序），再接邀請', () => {
  for (const f of [F('H', '小文'), F('H', '小離', { status: 'offline' })]) {
    const phone = phoneOpsRows(manageItems(f, ops), f).map(i => `p:${i.key}`)
    const items = build(f)
    assert.deepEqual(keys(items).slice(0, phone.length), phone, `${f.agent} 前段順序`)
    assert.equal(keys(items)[phone.length], 'invite', '接著是邀請別人加入（和手機 chatGroupItems 同一份）')
  }
  assert.equal(keys(build(F('H', '小文')))[0], 'p:model', '在線：切換模型排最前')
})

test('更多：離線有喚醒、在線沒有', () => {
  const off = build(F('H', '小離', { status: 'offline' }))
  assert.equal(keys(off)[0], 'p:resume')
  assert.ok(off.find(i => i.key === 'p:resume').ok, '離線的 Claude 視窗喚醒可按')
  assert.ok(!keys(build(F('H', '小文'))).includes('p:resume'))
  assert.ok(!keys(build(F('H', '小文'))).includes('p:console'), '前台／後台不在管理那段（手機也不列）')
})

test('更多：電腦獨有的項目都在分隔線之後（通話、前台／後台、子代理、工作項目、納入管理）', () => {
  const items = build(F('H', '小文'))
  const at = items.findIndex(i => i.sep)
  assert.ok(at > 0, '有分隔線')
  assert.deepEqual(keys(items).slice(at), ['call', 'window', 'subs', 'tasks', 'p:adopt'])
  assert.ok(items.slice(0, at).every(i => !['call', 'window', 'subs', 'tasks', 'p:adopt'].includes(i.key)), '分隔線之前沒有電腦獨有的')
  assert.equal(items.filter(i => i.sep).length, 1)
})

test('更多：有「終端」鈕時不再列前台／後台；離線時（第 2 格是喚醒）也不列', () => {
  const f = F('H', '小文')
  const withTerm = build(f, { term: true })
  assert.ok(!keys(withTerm).includes('window'))
  assert.ok(!keys(build(F('H', '小離', { status: 'offline' }))).includes('window'))
})

test('更多：群組只有群組那三項，不分隔、沒有通話等電腦項目', () => {
  const room = F('H', '正見群', { room: true, nick: '正見群' })
  const items = moreMenuItems(room, { ops, selfNode: 'H', slots: {} })
  assert.deepEqual(keys(items), ['invite', 'addai', 'manage'])
  assert.deepEqual(keys(items), groupMenuItems(room).map(i => i.key))
  assert.ok(items.every(i => i.ok && !i.sep))
  assert.deepEqual(chatGroupItems(room).map(i => i.key), ['invite', 'addai', 'manage'])
  assert.deepEqual(moreMenuItems(null), [])
})

test('名牌：名字、哪台電腦、狀態；離線寫「離線」；群組寫群組名', () => {
  const on = nameplateView(F('H', '小文', { device: '工作機' }))
  assert.equal(on.name, '小文'); assert.equal(on.sub, '工作機・在線'); assert.equal(on.offline, false)
  const off = nameplateView(F('H', '小離', { device: '工作機', status: 'offline' }))
  assert.equal(off.sub, '工作機・離線'); assert.equal(off.offline, true)
  const room = nameplateView({ room: true, nick: '正見群', id: 'room:1' })
  assert.equal(room.name, '正見群'); assert.equal(room.sub, '群組'); assert.equal(room.room, true)
})

test('新節點在復古 Aero 下預設藏起來（style.css）；現代下才顯示', () => {
  const css = read('ui', 'style.css')
  assert.match(css, /\.mbar,\.me-this,\.search-plus\{display:none\}/)
  const m = read('ui', 'modern.css')
  assert.match(m, /\/\* #1421 B：電腦頂部與左欄 \*\//)
  assert.match(m, /:root\[data-skin="modern"\] \.conv-main \.to-line,:root\[data-skin="modern"\] \.tabbar\{display:none\}/)
  assert.match(m, /:root\[data-skin="modern"\] \.actionbar \.abtn\{display:none\}/, '大按鈕區的按鈕收起來（區塊本身留著放下拉清單與封存結果）')
  assert.match(m, /:root\[data-skin="modern"\] \.actionbar\{position:static;display:block;height:0/)
  assert.match(m, /\.shell\.only-chat \.tabbar \.pane-back/, '窄視窗保留返回名單的入口')
  assert.match(m, /\.list-pane > \.me\{order:99/)
  assert.match(m, /\.me-this\{display:inline/)
  // 新規則放在檔尾的獨立區塊、且不碰 .me-dp 的偽元素（頭像區塊另有人負責）
  const block = m.slice(m.indexOf('/* #1421 B'))
  assert.doesNotMatch(block, /\.me-dp::(before|after)/)
  assert.equal(m.indexOf('/* #1421 B'), m.lastIndexOf('/* #1421 B'))
})

test('樣板：名牌列在 .actionbar 之外；list.html 新節點與選取態', () => {
  const ab = read('ui', 'lib', 'actionbar.mjs')
  assert.match(ab, /<\/div>\n<div class="mbar" v-if="showBar"/, '名牌列與 .actionbar 並列，終端開著（.conv 隱藏）時也在')
  assert.doesNotMatch(ab.slice(ab.indexOf('export const MoreMenuButton'), ab.indexOf('const CALL_TIP')), /class="abtn"/, '新按鈕不用 abtn')
  assert.ok(ab.slice(ab.indexOf('<div class="mbar"')).includes('class="mbtn"'))
  const html = read('ui', 'list.html')
  assert.match(html, /<span class="me-this">這台電腦<\/span>/)
  assert.equal([...html.matchAll(/class="search-plus"/g)].length, 2, '夥伴、對話兩個搜尋列各一顆「＋」')
  assert.match(html, /class="room-btn" :class="\{ on: ui\.mode === 'merged' && view === 'chat' && ui\.active === x\.room\.chatId \}"/)
  assert.ok([...html.matchAll(/on: ui\.mode === 'merged' && view === 'chat' && ui\.active === /g)].length >= 3)
  assert.match(html, /<div class="tabbar" role="tablist"/, '分頁列結構照舊（只在現代下用 CSS 收起）')
})
