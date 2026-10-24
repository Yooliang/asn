// 針對某則訊息回覆（#225）：回覆時帶引用（原作者＋摘要）並在群組自動 @ 原作者；引用顯示在訊息上方，點引用跳回原訊息。
// 舊版用戶端沒有引用功能：引用以固定格式的第一行寫進內文，看起來就是「↩ 回覆 某某：摘要」的文字，AI 收到的信也有明確的引用與標記。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QUOTE_PREFIX, composeReply, excerptOf, findQuoted, quoteLine, replyTarget, splitQuote } from '../ui/lib/reply-quote.mjs'
import { roomLog } from '../ui/lib/mobile-rooms.mjs'
import { createRoomHub } from '../ui/lib/room-hub.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const { compile } = require('@vue/compiler-dom')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const chatpane = read('ui', 'lib', 'chatpane.mjs')
const tpl = /template: `([\s\S]*?)`,?\n?\}/.exec(chatpane)[1]

test('摘要：去掉舊的引用行、空白壓成一個、超過 40 字加刪節號；空的回空字串', () => {
  assert.equal(excerptOf('  第一行\n第二行   好  '), '第一行 第二行 好')
  assert.equal(excerptOf(`${QUOTE_PREFIX}小良：原話\n真正的內容`), '真正的內容', '回覆的回覆只取新的內容')
  assert.equal(excerptOf('字'.repeat(60)), '字'.repeat(40) + '…')
  assert.equal(excerptOf(''), ''); assert.equal(excerptOf(null), '')
})

test('引用行與拆解：寫進內文的第一行，能原樣讀回；作者名裡的換行與括號引號被清掉；沒有引用行就原文', () => {
  assert.equal(quoteLine('小良', '請查報表\n謝謝'), '↩ 回覆 小良：請查報表 謝謝')
  assert.equal(quoteLine('財務（牧陽）', 'x'), '↩ 回覆 財務（牧陽）：x', '全形括號是標示的一部分，要保留')
  assert.equal(quoteLine('壞\n名「字」', 'x'), '↩ 回覆 壞名字：x')
  assert.deepEqual(splitQuote('↩ 回覆 小良：請查報表\n@小良 好的'), { quote: { author: '小良', excerpt: '請查報表' }, body: '@小良 好的' })
  assert.deepEqual(splitQuote('↩ 回覆 小良：只有引用'), { quote: { author: '小良', excerpt: '只有引用' }, body: '' })
  assert.deepEqual(splitQuote('沒有引用\n↩ 回覆 小良：在第二行不算'), { quote: null, body: '沒有引用\n↩ 回覆 小良：在第二行不算' })
  assert.deepEqual(splitQuote(null), { quote: null, body: '' })
})

test('回覆對象：群組裡回覆別人自動 @ 對方（只在對方是可點名的成員時）；回覆自己、個人聊天、系統訊息不 @', () => {
  const friend = { room: true, nick: '群', mentionable: [{ label: '小良', kind: 'human' }, { label: '報表（小良）', kind: 'ai' }] }
  const them = { k: 'them', who: '報表（小良）', text: '資料在這裡\n請看', seq: 7, id: 'room-7', av: 'x:1' }
  const t = replyTarget(them, { friend, meName: '牧陽', index: 3 })
  assert.deepEqual({ author: t.author, excerpt: t.excerpt, seq: t.seq, mention: t.mention }, { author: '報表（小良）', excerpt: '資料在這裡 請看', seq: 7, mention: '報表（小良）' })
  assert.equal(replyTarget({ k: 'me', text: '我說的', seq: 8 }, { friend, meName: '牧陽', index: 4 }).mention, '', '回覆自己不點自己')
  assert.equal(replyTarget({ k: 'me', text: '我說的', seq: 8 }, { friend, meName: '牧陽', index: 4 }).author, '牧陽')
  assert.equal(replyTarget({ k: 'them', who: '離開的人', text: 'x', seq: 1 }, { friend, meName: '牧陽', index: 0 }).mention, '', '不在可點名名單裡的不 @')
  const one = replyTarget({ k: 'them', text: '嗨', id: 'abc' }, { friend: { nick: '財務', room: false }, meName: '牧陽', index: 2 })
  assert.deepEqual({ author: one.author, mention: one.mention, seq: one.seq ?? null }, { author: '財務', mention: '', seq: null }, '個人聊天作者是對方名字，不 @')
  assert.equal(replyTarget({ k: 'sys', text: '加入' }, { friend, meName: '牧陽', index: 0 }), null)
  assert.equal(replyTarget({ k: 'them', text: '   ' }, { friend, meName: '牧陽', index: 0 }), null, '沒有文字的不能回覆')
  // 引用行裡不重複放被回覆者自己的引用：回覆「回覆」時摘要取新內容
  const rr = replyTarget({ k: 'them', who: '小良', text: '↩ 回覆 報表（小良）：資料\n@報表（小良） 收到', seq: 9 }, { friend, meName: '牧陽', index: 5 })
  assert.equal(rr.excerpt, '@報表（小良） 收到')
})

test('組出要送的內文：引用行＋自動 @ 對方＋使用者打的字；對方已經被使用者自己 @ 就不重複；沒打字不能送', () => {
  const t = { author: '報表（小良）', excerpt: '資料在這裡', mention: '報表（小良）' }
  assert.equal(composeReply(t, '收到，謝謝'), '↩ 回覆 報表（小良）：資料在這裡\n@報表（小良） 收到，謝謝')
  assert.equal(composeReply(t, '@報表（小良） 收到'), '↩ 回覆 報表（小良）：資料在這裡\n@報表（小良） 收到', '使用者自己已經 @ 就不重複')
  assert.equal(composeReply({ ...t, mention: '' }, '好'), '↩ 回覆 報表（小良）：資料在這裡\n好')
  assert.equal(composeReply(t, '   '), '')
  assert.equal(composeReply(null, '一般訊息'), '一般訊息')
})

test('找回原訊息：有序號用序號；沒有就在它之前找作者相符、內文以摘要開頭的最近一則；找不到回 -1', () => {
  const log = [
    { k: 'them', who: '財務', text: '報表做好了，請看', seq: 3 },
    { k: 'me', text: '好', seq: 4 },
    { k: 'them', who: '財務', text: '報表做好了，請看（第二版）', seq: 5 },
    { k: 'me', text: '↩ 回覆 財務：報表做好了，請看\n收到', seq: 6 },
  ]
  assert.equal(findQuoted(log, 3, { seq: 3 }), 0, '序號優先')
  assert.equal(findQuoted(log, 3, { author: '財務', excerpt: '報表做好了，請看' }), 2, '同樣開頭時取離這則最近的前一則')
  assert.equal(findQuoted(log, 1, { author: '財務', excerpt: '報表做好了，請看' }), 0)
  assert.equal(findQuoted(log, 3, { author: '別人', excerpt: '報表做好了' }), -1)
  assert.equal(findQuoted(log, 3, { seq: 99 }), -1, '序號不在已載入的紀錄裡')
  assert.equal(findQuoted(log, 3, { author: '我', excerpt: '好' }, { meName: '我' }), 1, '自己說的作者是自己的名字')
  assert.equal(findQuoted(log, 3, null), -1)
  const long = [{ k: 'them', who: 'a', text: '字'.repeat(60) }, { k: 'me', text: 'x' }]
  assert.equal(findQuoted(long, 1, { author: 'a', excerpt: '字'.repeat(40) + '…' }), 0, '被截斷的摘要（尾巴是刪節號）也對得到')
})

test('群組訊息帶引用：後台給的 reply_to 轉成對話記錄的 reply（作者用同一套標示、摘要一行），沒有就是 null；不含任何鍵', () => {
  const members = [{ key: '~u:me', label: '牧陽', member_kind: 'human', mine: true }, { key: 'x:r2bbbbbb', label: '報表（小良）', member_kind: 'ai' }]
  const log = roomLog([
    { seq: 1, from: 'x:r2bbbbbb', relation: 'other', from_kind: 'ai', from_label: '報表（小良）', body: '資料', at: '2026-10-24T10:00:00Z', reply_to: null },
    { seq: 2, from: '~u:me', relation: 'mine', from_kind: 'human', from_label: '牧陽', body: '↩ 回覆 報表（小良）：資料\n@報表（小良） 好', at: '2026-10-24T10:01:00Z',
      reply_to: { seq: 1, from: 'x:r2bbbbbb', from_kind: 'ai', from_label: '報表（小良）', excerpt: '資料' } },
  ], ['~u:me'], members)
  assert.equal(log[0].reply, null)
  assert.deepEqual(log[1].reply, { seq: 1, author: '報表（小良）', excerpt: '資料' })
  assert.doesNotMatch(JSON.stringify(log[1].reply), /x:|~u:/)
  const old = roomLog([{ seq: 1, from: 'T~a', body: 'x' }], [], [])
  assert.equal(old[0].reply ?? null, null, '舊後台沒有 reply_to 欄位照常')
})

test('發言帶上引用的序號：群組中樞把 reply_to 放進送給 Rust 的發言內容；沒引用就不帶（舊後台相容）', async () => {
  const calls = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'relay_rooms') return { rooms: [{ id: 'g1', name: '群', members: [], mine: [{ member: '~u:me', unread: 0 }], last_seq: 0 }] }
    return { messages: [], last_seq: 1 }
  }
  const hub = createRoomHub({ invoke, groupApi: {}, selfNode: 'P', windowName: '手機' })
  await hub.refresh()
  await hub.post('g1', '↩ 回覆 a：b\n好', { replySeq: 7 })
  await hub.post('g1', '一般')
  await hub.post('g1', '壞的引用', { replySeq: -1 })
  const posts = calls.filter(c => c[0] === 'relay_room_post').map(c => c[1].body)
  assert.deepEqual(posts.map(b => b.reply_to), [7, undefined, undefined])
  assert.deepEqual(Object.keys(posts[1]).sort(), ['body', 'room'])
})

test('對話樣板：每則訊息有「回覆」鈕、輸入框上方有回覆列、引用顯示在內文上方並可點；樣板能編譯；連結 aria 文字都是純中文', () => {
  const errs = []
  compile(tpl, { onError: e => errs.push(e.message) })
  assert.deepEqual(errs, [])
  const btn = cls => (tpl.match(/<button[^>]*>/g) ?? []).find(t => t.includes(`class="${cls}"`)) ?? ''
  for (const [cls, attrs] of [['reply-btn', ['v-if="canReply(m)"', '@click="startReply(m, i)"']], ['quote', ['v-if="msgQuote(m)"', '@click="jumpTo(m, i)"']], ['reply-bar-x', ['@click="cancelReply"']]]) {
    for (const a of attrs) assert.ok(btn(cls).includes(a), `${cls} 要有 ${a}`)
  }
  assert.match(tpl, /<div class="reply-bar" v-if="replying"/)
  assert.match(tpl, /<div v-else class="msg" :data-i="i"/, '訊息要有序位標記才能捲過去')
  assert.match(chatpane, /emit\('send', text, \{ replySeq: rep\.seq \}\)/)
  assert.match(chatpane, /import \{[^}]*composeReply[^}]*\} from '\.\/reply-quote\.mjs'/)
  // 畫面上的文字都是純中文
  for (const t of ['>回覆</button>', 'aria-label="回覆這則訊息"', 'aria-label="取消回覆"', "'跳到原訊息：'"]) assert.ok(tpl.includes(t), t)
  assert.match(chatpane, /找不到原訊息，可能在更早的紀錄。/)
})

test('樣式：回覆鈕平時淡、滑過或觸控裝置才明顯；引用列與跳回後的閃一下都在 group.css', () => {
  const css = read('ui', 'group.css')
  for (const re of [/\.reply-btn\{/, /\.reply-bar\{/, /\.quote\{/, /\.msg\.flash/, /@media \(hover:none\)\{[^}]*\.reply-btn/]) assert.match(css, re)
})

test('三個送出入口都把引用序號接到群組發言：電腦版分頁、電腦版分開視窗、手機', () => {
  const list = read('ui', 'list.js'), chat = read('ui', 'chat.js'), mobile = read('ui', 'm.js')
  assert.match(list, /hub\.post\(roomIdOf\(id\), text, \{ replySeq: opts\?\.replySeq \}\)/)
  assert.match(list, /hub\.post\(roomIdOf\(c\.id\), c\.text, \{ replySeq: c\.replySeq \}\)/)
  assert.match(chat, /send: \(text, opts\) => emit\('asn:cmd', \{ op: 'send', id, text, voice: opts\?\.voice === true, replySeq: opts\?\.replySeq \}\)/)
  assert.match(mobile, /postRoom\(id, text, opts\)|hub\.post\(roomIdOf\(id\), text, \{ replySeq: opts\?\.replySeq \}\)/)
})
