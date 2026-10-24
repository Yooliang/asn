// 群組發言者頭像（10-25）：AI 頭像右下角放廠商小圖、拿掉「AI」小標籤；離線的 AI 頭像灰階淡化。
// 狀態來源是後台成員清單多帶的 online／engine（migration 20261025000000）；舊後台沒有欄位＝當在線、廠商不明（通用圖）。
// 渲染測試：用真的 ChatPane 做伺服器端渲染，看輸出的 HTML。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { roomItems, roomLog, roomPseudoFriend, speakerStates } from '../ui/lib/mobile-rooms.mjs'
import { vendorIconSvg } from '../ui/lib/vendor-icons.mjs'

globalThis.Vue = Vue
const { ChatPane } = await import('../ui/lib/chatpane.mjs')
const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sig = k => vendorIconSvg(k).slice(0, 120)

const members = [
  { key: '~u:me', name: '我', member_kind: 'human', kind: 'owner', mine: true },
  { key: 'H~財務', name: '財務', member_kind: 'ai', kind: 'window', mine: true, engine: 'claude', online: true },
  { key: 'H~審稿', name: '審稿', member_kind: 'ai', kind: 'window', mine: true, engine: 'gemini', online: false },
  { key: 'x:r1aaaaaa', name: '小良', member_kind: 'human', kind: 'human', mine: false },
  { key: 'x:r2bbbbbb', name: '報表', member_kind: 'ai', kind: 'ai', mine: false, engine: 'zzz-unknown', online: false },
]
const msgs = [
  { seq: 1, from: 'H~財務', relation: 'mine_ai', from_kind: 'ai', from_label: '財務（我）', body: 'a', at: '2026-10-25T10:00:00Z' },
  { seq: 2, from: 'H~審稿', relation: 'mine_ai', from_kind: 'ai', from_label: '審稿（我）', body: 'b', at: '2026-10-25T10:01:00Z' },
  { seq: 3, from: 'x:r1aaaaaa', relation: 'other', from_kind: 'human', from_label: '小良', body: 'c', at: '2026-10-25T10:02:00Z' },
  { seq: 4, from: 'x:r2bbbbbb', relation: 'other', from_kind: 'ai', from_label: '報表（小良）', body: 'd', at: '2026-10-25T10:03:00Z' },
]
const room = mem => ({ id: 'g1', name: '群', members: mem, mine: [{ member: '~u:me', unread: 0 }], last_seq: 4 })
const friendOf = mem => roomPseudoFriend(roomItems([room(mem)])[0])
async function renderHtml(mem) {
  const friend = friendOf(mem)
  const log = roomLog(msgs, ['~u:me'], mem)
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(ChatPane, { friend, log, dpMode: 'inline', meAv: 'data:image/png;base64,AAAA' }) }))
}
// 每則訊息的頭像欄（到 m-body 之前）
async function render(mem) {
  const html = await renderHtml(mem)
  return html.split('<div data-i=').slice(1).map(s => s.split('m-body')[0])
}

test('AI 發言有廠商小圖、沒有「AI」小標籤；真人沒有小圖', async () => {
  const rows = await render(members)
  assert.equal(rows.length, 4)
  assert.ok(rows[0].includes('class="spk-vendor"') && rows[0].includes(sig('claude')), 'claude 的圖')
  assert.ok(rows[1].includes(sig('gemini')), 'gemini 的圖')
  assert.ok(!rows[2].includes('spk-vendor'), '真人沒有小圖')
  assert.ok(rows[3].includes(sig('other')), '不認得的引擎用通用圖')
  for (const r of rows) assert.ok(!r.includes('av-tag') && !r.includes('>AI<'), '拿掉 AI 小標籤')
})

test('離線的 AI 頭像帶離線樣式；在線與真人不帶', async () => {
  const rows = await render(members)
  assert.ok(!rows[0].includes('is-off') && !rows[0].includes('st-offline'), '在線不灰')
  assert.ok(rows[1].includes('is-off') && rows[1].includes('st-offline'), '離線的自己 AI 變灰')
  assert.ok(!rows[2].includes('is-off'), '真人不灰')
  assert.ok(rows[3].includes('is-off'), '離線的外部 AI 也變灰')
})

test('舊後台沒有 online／engine 欄位：不離線；AI 仍有通用圖', async () => {
  const old = members.map(({ online, engine, ...m }) => m)
  const rows = await render(old)
  for (const r of rows) assert.ok(!r.includes('is-off') && !r.includes('st-offline'), '沒欄位＝在線')
  assert.ok(rows[0].includes('class="spk-vendor"') && rows[0].includes(sig('other')))
  assert.ok(!rows[2].includes('spk-vendor'))
  assert.deepEqual(speakerStates(undefined), {})
  assert.deepEqual(speakerStates(old)['H~財務'], { vendor: '', off: false })
})

test('不壞既有功能：@ 標記資料、操作列、真人標籤仍在', async () => {
  assert.ok(friendOf(members).mentionable.length > 0)
  const html = await renderHtml(members)
  assert.match(html, /m-act/)
  assert.match(html, /真人/, '真人標籤保持原狀')
})

test('樣式：小圖定位在頭像欄右下角、離線灰階、深色模式有處理', () => {
  const css = read('group.css')
  assert.match(css, /\.m-av-spk\{[^}]*position:relative/)
  assert.match(css, /\.spk-vendor\{[^}]*position:absolute[^}]*right:-4px[^}]*bottom:-4px/)
  assert.match(css, /\.m-av-spk\.is-off \.dp img\{[^}]*grayscale/)
  assert.match(css, /prefers-color-scheme:dark\)\{[^@]*\.spk-vendor/)
})
