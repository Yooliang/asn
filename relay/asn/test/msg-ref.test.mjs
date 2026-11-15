// 訊息裡的編號可以點（#1530）：判斷是群組訊息還是 GitHub 編號的純函式、把 #N 包成可點標記、點到的標記取回編號。
// GitHub 連結要設定「把 #編號 連到 ASN 的 GitHub 議題」打開才有（預設關，asn真 #3942）；群組訊息編號大家都有。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../ui/lib/markdown.mjs'
import { markMentions } from '../ui/lib/mention.mjs'
import fs from 'node:fs'
import { GH_REFS_LABEL, GH_REFS_NOTE, GITHUB_ISSUES, githubUrl, groupCue, linkRefs, refKind, refOf, refRange, refTip } from '../ui/lib/msg-ref.mjs'
import { DEFAULT_PREFS, normalizePrefs } from '../ui/lib/mobile.mjs'

const refs = html => [...String(html).matchAll(/<span class="msg-ref" role="link" tabindex="0" data-ref="(group|github)" data-n="(\d+)" title="([^"]*)">#(\d+)<\/span>/g)].map(m => ({ kind: m[1], n: Number(m[2]), title: m[3], text: m[4] }))
const room = { room: true, lo: 3880, hi: 3931, github: true }   // 開關打開的情況；關閉的另外測
const roomOff = { room: true, lo: 3880, hi: 3931 }
const render = (md, ctx) => linkRefs(renderMarkdown(md), ctx)

test('refKind（開關打開）：一對一一律 GitHub；群組裡範圍內＝群組、範圍外＝GitHub；有「回 #N」「#N 則」一律群組', () => {
  // 一對一：不管範圍、不管提示字
  assert.equal(refKind({ n: 3900, room: false, lo: 3880, hi: 3931, github: true }), 'github')
  assert.equal(refKind({ n: 3900, room: false, lo: 3880, hi: 3931, cue: true, github: true }), 'github')
  // 範圍內（含兩端）
  for (const n of [3880, 3900, 3931]) assert.equal(refKind({ n, ...room }), 'group', String(n))
  // 範圍外（比已載入最舊的還舊、比最新的還新）
  for (const n of [1512, 3879, 3932, 99999]) assert.equal(refKind({ n, ...room }), 'github', String(n))
  // 「回 #N」：範圍外也當群組
  assert.equal(refKind({ n: 1512, ...room, cue: true }), 'group')
  // 沒有載入任何一則＝沒有範圍
  assert.equal(refKind({ n: 5, room: true, lo: null, hi: null, github: true }), 'github')
  assert.equal(refKind({ n: 5, room: true, lo: null, hi: null, cue: true }), 'group')
})

test('refKind（開關關閉＝預設）：群組規則照樣算；其他都不是可點的編號', () => {
  assert.equal(refKind({ n: 2, room: false }), null, '一對一寫「第 #2 點」不連到議題')
  assert.equal(refKind({ n: 3900, room: false, lo: 3880, hi: 3931, cue: true }), null)
  assert.equal(refKind({ n: 3900, ...roomOff }), 'group')
  assert.equal(refKind({ n: 1512, ...roomOff }), null)
  assert.equal(refKind({ n: 1512, ...roomOff, cue: true }), 'group')
  assert.equal(refKind({ n: 1512, ...roomOff, github: 'yes' }), null, '只認 true')
})

test('linkRefs（開關關閉）：一對一的 #N 維持普通文字；群組裡只有符合群組規則的可點', () => {
  assert.equal(render('第 #2 點跟 #1512', { room: false }), renderMarkdown('第 #2 點跟 #1512'))
  const got = refs(render('看 #3923 跟 #1512；回 #1200 說的', roomOff))
  assert.deepEqual(got.map(r => [r.kind, r.n]), [['group', 3923], ['group', 1200]])
  assert.match(render('看 #3923 跟 #1512', roomOff), /跟 #1512/)
})

test('設定：預設關；電腦存在 me.ghRefs、手機存在 mobilePrefs.ghRefs；整合、分開、手機的對話都吃這個開關；文字白話', () => {
  assert.equal(DEFAULT_PREFS.ghRefs, false)
  assert.equal(normalizePrefs({}).ghRefs, false); assert.equal(normalizePrefs({ ghRefs: true }).ghRefs, true); assert.equal(normalizePrefs({ ghRefs: 1 }).ghRefs, false)
  const rd = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
  const list = rd('list.js')
  assert.match(list, /const ghRefs = ref\(savedMe\.ghRefs === true\)/)
  assert.match(list, /ghRefs: ghRefs\.value, tabDim:/, '存檔')
  assert.match(list, /case 'gh-refs': ghRefs\.value = value === true; break/)
  assert.match(list, /collapsed: ui\.collapsed, ghRefs: ghRefs\.value \} \}\)/, '分開模式的對話視窗經 asn:state 拿到')
  assert.match(rd('list.html'), /<chat-pane [^>]*:gh-refs="ghRefs"/)
  assert.match(rd('chat.js'), /const ghRefs = computed\(\(\) => snap\.value\?\.ui\?\.ghRefs === true\)/)
  assert.match(rd('chat.html'), /<chat-pane [^>]*:gh-refs="ghRefs"/)
  assert.match(rd('m.html'), /<chat-pane [^>]*:gh-refs="prefs\.ghRefs"/)
  assert.match(rd('m.html'), /<input type="checkbox" v-model="prefs\.ghRefs"> \{\{ GH_REFS_LABEL \}\}/)
  assert.match(rd('lib/settings-panel.mjs'), /:checked="st\.ghRefs === true" @change="act\('gh-refs', \$event\.target\.checked\)"/)
  assert.match(rd('lib/chatpane.mjs'), /ghRefs: \{ type: Boolean, default: false \}/)
  assert.equal(GH_REFS_LABEL, '把訊息裡的 #編號 連到 ASN 的 GitHub 議題')
  assert.match(GH_REFS_NOTE, /一般不用開/)
})

test('長按只算手指；空白鍵跟 Enter 一樣能開', () => {
  const pane = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.match(pane, /if \(!r \|\| ev\.pointerType !== 'touch'\) return/)
  assert.equal((pane.match(/@keydown\.enter="onRefKey" @keydown\.space="onRefKey"/g) || []).length, 2)
})

test('groupCue：「回 #N」「回覆 #N」「#N 則」才算', () => {
  assert.equal(groupCue('回 ', ''), true)
  assert.equal(groupCue('回', ''), true)
  assert.equal(groupCue('請看回覆 ', ''), true)
  assert.equal(groupCue('', ' 則'), true)
  assert.equal(groupCue('', '則提到的'), true)
  assert.equal(groupCue('回來看 ', ''), false)
  assert.equal(groupCue('修 ', ' 的問題'), false)
  assert.equal(groupCue('', ''), false)
})

test('refRange：下限＝已載入最舊那則、上限＝群組最新序號（比已載入的新才用）；沒有序號的列不算', () => {
  const log = [{ k: 'sys', text: 'x' }, { seq: 3881 }, { seq: 3880 }, { seq: 3925 }, { seq: 'x' }]
  assert.deepEqual(refRange(log, 3931), { lo: 3880, hi: 3931 })
  assert.deepEqual(refRange(log, 3900), { lo: 3880, hi: 3925 })
  assert.deepEqual(refRange(log, undefined), { lo: 3880, hi: 3925 })
  assert.deepEqual(refRange([], 3931), { lo: null, hi: null })
  assert.deepEqual(refRange(null, 3931), { lo: null, hi: null })
})

test('linkRefs：範圍內、範圍外、「回 #N」、「#N 則」在群組裡的結果與提示', () => {
  const got = refs(render('看 #3923 跟 #1512；回 #1200 說的，還有 #1100 則', room))
  assert.deepEqual(got.map(r => [r.kind, r.n, r.title]), [
    ['group', 3923, '跳到群組第 3923 則'],
    ['github', 1512, '開啟 GitHub #1512'],
    ['group', 1200, '跳到群組第 1200 則'],
    ['group', 1100, '跳到群組第 1100 則'],
  ])
  assert.ok(got.every(r => r.text === String(r.n)))
})

test('linkRefs：一對一對話（開關打開）一律 GitHub（含「回 #N」）', () => {
  const got = refs(render('回 #3923，另外 #1512', { room: false, lo: 3880, hi: 3931, github: true }))
  assert.deepEqual(got.map(r => [r.kind, r.n]), [['github', 3923], ['github', 1512]])
  assert.equal(refTip('github', 1512), '開啟 GitHub #1512')
})

test('linkRefs：程式碼區塊、行內程式碼、網址、Markdown 連結裡的 # 不處理', () => {
  const md = [
    '```',
    'git log #3923 #1512',
    '```',
    '行內 `#3900` 不動',
    'https://github.com/Yooliang/asn/issues/1#issuecomment-3923',
    'https://example.com/page#3923',
    '[看 #3923](https://example.com/#3923)',
    '<https://example.com/x#1512>',
    '外面的 #3901 要處理',
  ].join('\n')
  const out = render(md, room)
  assert.deepEqual(refs(out).map(r => r.n), [3901])
  assert.match(out, /<pre class="md-code"><code>git log #3923 #1512<\/code><\/pre>/)
  assert.match(out, /<code>#3900<\/code>/)
})

test('linkRefs：不是編號的 # 不處理（HTML 實體、字中間、##、0 開頭、太長、後面接字母、標題）', () => {
  const cases = ["it's", '&#39;', 'C#12', 'abc#12', '##12', '#012', '#12345678', '#12abc', '#12_x', 'a/#12', '#']
  for (const c of cases) assert.deepEqual(refs(render(c, room)), [], c)
  assert.deepEqual(refs(render('&#3900', room)), [], '原文的 &#N 不是編號')
  // 「# 標題」是 Markdown 標題，不是編號；「#12」開頭的行是編號
  assert.deepEqual(refs(render('# 3900 標題', room)), [])
  assert.deepEqual(refs(render('#3900 開頭', room)).map(r => r.n), [3900])
  // 中文、標點、括號後面接的照樣處理
  assert.deepEqual(refs(render('（#3900）、#3901。見#3902', room)).map(r => r.n), [3900, 3901, 3902])
})

test('linkRefs：跟 @ 點名標記並存；markMentions 之後再跑也不壞', () => {
  const html = linkRefs(markMentions(renderMarkdown('@asn真 回 #3923'), ['asn真']), room)
  assert.match(html, /<span class="mention">@asn真<\/span>/)
  assert.deepEqual(refs(html).map(r => [r.kind, r.n]), [['group', 3923]])
})

test('linkRefs：沒有 # 原樣回傳；輸出沒有原文帶進來的屬性', () => {
  assert.equal(linkRefs('<p>abc</p>', room), '<p>abc</p>')
  const out = render('#3900 <img src=x onerror=alert(1)> "#3901"', room)
  assert.doesNotMatch(out, /<img/)
  assert.deepEqual(refs(out).map(r => r.n), [3900, 3901])
})

test('refOf：只認標記上的 data-ref 與數字；網址由編號組，固定 Yooliang/asn', () => {
  const el = (attrs, hit = true) => ({ closest: sel => (hit && sel === '.msg-ref[data-ref]' ? { getAttribute: k => attrs[k] ?? null } : null) })
  assert.deepEqual(refOf(el({ 'data-ref': 'github', 'data-n': '1512' })), { kind: 'github', n: 1512 })
  assert.deepEqual(refOf(el({ 'data-ref': 'group', 'data-n': '3923' })), { kind: 'group', n: 3923 })
  assert.equal(refOf(el({ 'data-ref': 'evil', 'data-n': '1' })), null)
  assert.equal(refOf(el({ 'data-ref': 'github', 'data-n': '1/../x' })), null)
  assert.equal(refOf(el({ 'data-ref': 'github', 'data-n': '0' })), null)
  assert.equal(refOf(el({}, false)), null)
  assert.equal(refOf(null), null)
  assert.equal(githubUrl(1512), 'https://github.com/Yooliang/asn/issues/1512')
  assert.equal(GITHUB_ISSUES, 'https://github.com/Yooliang/asn/issues/')
})
