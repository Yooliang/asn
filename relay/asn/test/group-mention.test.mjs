// 群組 @ 點名（#226）：輸入 @ 的成員選單、選好寫回輸入框、訊息裡 @名字 變小標記；後台沿用從內文解析點名，不另送欄位。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMention, markMentions, mentionOptions, mentionQuery, mentionTargets } from '../ui/lib/mention.mjs'
import { renderMarkdown } from '../ui/lib/markdown.mjs'
import { roomItems, roomPseudoFriend } from '../ui/lib/mobile-rooms.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const { compile } = require('@vue/compiler-dom')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const chatpane = read('ui', 'lib', 'chatpane.mjs')
const tpl = /template: `([\s\S]*?)`,?\n?\}/.exec(chatpane)[1]

const MEMBERS = [
  { key: '~u:me', label: '牧陽', member_kind: 'human', mine: true },
  { key: 'T~財務', label: '財務（牧陽）', member_kind: 'ai', mine: true },
  { key: 'x:r1aaaaaa', label: '小良', member_kind: 'human', mine: false },
  { key: 'x:r2bbbbbb', label: '報表（小良）', member_kind: 'ai', mine: false },
  { key: 'x:r3cccccc', label: '小良', member_kind: 'human', mine: false },
]

test('可點名的成員：不含自己、同名只留一個、真人在前；只給標示與種類，不含鍵', () => {
  const t = mentionTargets(MEMBERS)
  assert.deepEqual(t, [{ label: '小良', kind: 'human' }, { label: '財務（牧陽）', kind: 'ai' }, { label: '報表（小良）', kind: 'ai' }])
  assert.deepEqual(mentionTargets(null), [])
  assert.deepEqual(mentionTargets([{ key: 'x:1', label: '' }, null, { label: 'a b@c', member_kind: 'ai' }]), [], '沒名字、名字含 @ 的不給點')
})

test('打 @ 的位置：行首或空白後才算；游標前有空白就結束；太長不算', () => {
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' })
  assert.deepEqual(mentionQuery('請 @小', 4), { start: 2, query: '小' })
  assert.deepEqual(mentionQuery('a\n@財', 4), { start: 2, query: '財' })
  assert.equal(mentionQuery('信箱a@b', 5), null, '前面不是空白＝不是點名')
  assert.equal(mentionQuery('@小良 你好', 7), null, '@名字 之後已經空白')
  assert.equal(mentionQuery('@' + 'x'.repeat(21), 22), null)
  assert.equal(mentionQuery('沒有', 2), null)
  assert.deepEqual(mentionQuery('hi @a', undefined), { start: 3, query: 'a' }, '沒給游標就看結尾')
})

test('選單選項：依打到的字篩選、開頭相符的排前面、帶徽章文字', () => {
  const t = mentionTargets(MEMBERS)
  assert.deepEqual(mentionOptions(t, '').map(o => o.label), ['小良', '財務（牧陽）', '報表（小良）'])
  assert.deepEqual(mentionOptions(t, '小良').map(o => o.label), ['小良', '報表（小良）'])
  assert.deepEqual(mentionOptions(t, '報').map(o => [o.label, o.badge]), [['報表（小良）', 'AI']])
  assert.deepEqual(mentionOptions(t, 'zzz'), [])
  assert.equal(mentionOptions(t, '')[0].badge, '真人')
})

test('選好一位：換成完整名字加空白，游標在空白後；後台解析 @名字 的格式就是這個', () => {
  const q = mentionQuery('請 @報 看', 4)
  const r = applyMention('請 @報 看', q, '報表（小良）')
  assert.equal(r.text, '請 @報表（小良） 看', '後面本來就有空白就不再多加')
  assert.equal(r.text.slice(0, r.caret), '請 @報表（小良） ')
  const e = applyMention('@', mentionQuery('@', 1), '小良')
  assert.deepEqual(e, { text: '@小良 ', caret: 4 })
})

test('訊息裡的 @名字 變小標記：長名字優先、名字後面要是結尾／空白／標點；程式碼與連結裡不動；內文照樣跳脫', () => {
  const labels = ['小良', '報表（小良）', '報表']
  const out = markMentions(renderMarkdown('@報表（小良） 請看，@小良：好嗎？ @小良們 與 `@小良` 與 a@小良'), labels)
  assert.match(out, /<span class="mention">@報表（小良）<\/span> 請看/)
  assert.match(out, /<span class="mention">@小良<\/span>：好嗎/)
  assert.doesNotMatch(out, /@小良<\/span>們/, '名字後面接中文字不算點名（後台也不算）')
  assert.match(out, /<code>@小良<\/code>/, '程式碼裡不加標記')
  assert.equal((out.match(/class="mention"/g) ?? []).length, 3, '最後的 a@小良 因為前面不是空白，後台不算；顯示也一致')
  // 跳脫：名字有特殊字元時標記裡仍是安全文字
  const evil = markMentions(renderMarkdown('@<b>x</b> 你好'), ['<b>x</b>'])
  assert.doesNotMatch(evil, /<b>/)
  assert.equal(markMentions('<p>沒有</p>', ['小良']), '<p>沒有</p>')
  assert.equal(markMentions('<p>@小良</p>', []), '<p>@小良</p>')
})

test('群組列與假夥伴帶著可點名的成員（對話畫面用來開選單）', () => {
  const rows = roomItems([{ id: 'g1', name: '群', members: MEMBERS, mine: [] }])
  assert.deepEqual(rows[0].mentionable.map(t => t.label), ['小良', '財務（牧陽）', '報表（小良）'])
  assert.deepEqual(roomPseudoFriend(rows[0]).mentionable.map(t => t.label), ['小良', '財務（牧陽）', '報表（小良）'])
  assert.deepEqual(roomPseudoFriend(roomItems([{ id: 'g2', name: '空' }])[0]).mentionable, [])
})

test('對話樣板：群組輸入框有 @ 選單，群組內文用標記後的內文；樣板能編譯；選單不顯示鍵', () => {
  const errs = []
  compile(tpl, { onError: e => errs.push(e.message) })
  assert.deepEqual(errs, [])
  assert.match(tpl, /<ul class="mention-menu"[^>]*v-if="mention"[^>]*role="listbox"/)
  assert.match(tpl, /v-for="\(o, i\) in mention\.options"/)
  assert.match(tpl, /@input="onDraftInput"/)
  assert.match(tpl, /v-html="bodyHtml\(shownBody\(m\)\.text\)"/)
  assert.match(chatpane, /markMentions\(renderMarkdown\(text\), props\.friend\?\.mentionable/)
  assert.doesNotMatch(tpl.slice(tpl.indexOf('mention-menu'), tpl.indexOf('mention-menu') + 600), /\.key|\.ref|member/)
  // 手機的 Enter 是換行；選單開著時 Enter 一律是選人，不是送出也不是換行
  assert.match(chatpane, /function onEnter\(ev\) \{\s*if \(mention\.value\) \{ ev\.preventDefault\(\); pickMention\(\); return \}/)
})

test('樣式：標記與選單在 group.css，電腦版與手機端都載入', () => {
  const css = read('ui', 'group.css')
  assert.match(css, /\.mention\{/)
  assert.match(css, /\.mention-menu\{/)
  assert.match(css, /\.mention-menu button\.on/)
})
