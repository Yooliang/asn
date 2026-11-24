// 訊息裡的編號可以點（#1530、#1776）：GitHub 通用寫法「擁有者/repo#N」＋單獨 #N（依夥伴 repo）＋群組訊息編號。
// 沒有 ASN 專用規則、沒有設定勾選；單獨的 #N 只在知道這位夥伴的 repo 時才連，不知道就是普通文字（不會連錯 repo）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { renderMarkdown } from '../ui/lib/markdown.mjs'
import { markMentions } from '../ui/lib/mention.mjs'
import { githubUrl, groupCue, linkRefs, parseRepo, refKind, refOf, refRange, refTip, validOwner, validRepo } from '../ui/lib/msg-ref.mjs'
import { DEFAULT_PREFS, normalizePrefs } from '../ui/lib/mobile.mjs'
import { SETTING_KEYS, lookOptions } from '../ui/lib/settings-cats.mjs'

const refs = html => [...String(html).matchAll(/<span class="msg-ref" role="link" tabindex="0" data-ref="(group|github)" data-n="(\d+)"(?: data-repo="([^"]*)")? title="([^"]*)">([^<]*)<\/span>/g)].map(m => ({ kind: m[1], n: Number(m[2]), repo: m[3] ?? '', title: m[4], text: m[5] }))
const room = { room: true, lo: 3880, hi: 3931 }
const one = { room: false, repo: 'Yooliang/asn' }
const oneNoRepo = { room: false }
const render = (md, ctx) => linkRefs(renderMarkdown(md), ctx)
const rd = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')

test('全名「擁有者/repo#N」：顯示成「repo#N」，連到 github.com/擁有者/repo/issues/N；一對一、群組、沒有 repo 資訊都一樣', () => {
  for (const ctx of [one, oneNoRepo, room, { room: true }]) {
    const got = refs(render('看 Yooliang/asn#1751 說的', ctx))
    assert.deepEqual(got, [{ kind: 'github', n: 1751, repo: 'Yooliang/asn', title: '開啟 GitHub Yooliang/asn#1751', text: 'asn#1751' }], JSON.stringify(ctx))
  }
  assert.equal(githubUrl('Yooliang/asn', 1751), 'https://github.com/Yooliang/asn/issues/1751')
  assert.equal(refTip('github', 7, 'a/b'), '開啟 GitHub a/b#7')
  // 中文、標點、括號貼著；一行多個；repo 名有 . _ -
  const got = refs(render('見Yooliang/asn#1、（foo-bar/my_repo.js#22）與 a/b#3。', oneNoRepo))
  assert.deepEqual(got.map(r => [r.repo, r.n, r.text]), [['Yooliang/asn', 1, 'asn#1'], ['foo-bar/my_repo.js', 22, 'my_repo.js#22'], ['a/b', 3, 'b#3']])
})

test('全名：擁有者／repo 名不合 GitHub 規則就不轉', () => {
  const bad = ['-a/b#1', 'a-/b#1', 'a--b/c#1', `${'a'.repeat(40)}/b#1`, `a/${'b'.repeat(101)}#1`, 'a/../#1', 'a/b/c#1', 'a/b#0', 'a/b#12345678', 'a/b#1x']
  for (const c of bad) assert.deepEqual(refs(render(c, oneNoRepo)), [], c)
  assert.equal(validOwner('Yooliang'), true); assert.equal(validOwner('a_b'), false); assert.equal(validOwner('a b'), false); assert.equal(validOwner(''), false)
  assert.equal(validRepo('asn'), true); assert.equal(validRepo('..'), false); assert.equal(validRepo('a/b'), false); assert.equal(validRepo('a b'), false)
  assert.deepEqual(parseRepo('Yooliang/asn'), { owner: 'Yooliang', repo: 'asn' })
  for (const x of ['', 'asn', 'a/', '/b', 'a/b/c', null, undefined, 5, 'a/b c', '../x', 'a/..']) assert.equal(parseRepo(x), null, String(x))
  assert.equal(githubUrl('a/b/../c', 1), null); assert.equal(githubUrl('a/b', 0), null); assert.equal(githubUrl('a/b', 1.5), null); assert.equal(githubUrl(null, 1), null)
})

test('單獨 #N（一對一）：知道夥伴的 repo 才連到那個 repo；不知道就是普通文字', () => {
  assert.equal(render('第 #2 點跟 #1512', oneNoRepo), renderMarkdown('第 #2 點跟 #1512'), '沒有 repo＝原樣')
  assert.equal(render('第 #2 點', { room: false, repo: '' }), renderMarkdown('第 #2 點'))
  for (const bad of ['evil', 'a/b/c', '../x', 'a/..', null]) assert.equal(render('#2', { room: false, repo: bad }), renderMarkdown('#2'), `repo 不合規則（${bad}）不連`)
  const got = refs(render('看 #1512 與 #3', one))
  assert.deepEqual(got.map(r => [r.kind, r.n, r.repo, r.text, r.title]), [
    ['github', 1512, 'Yooliang/asn', '#1512', '開啟 GitHub Yooliang/asn#1512'],
    ['github', 3, 'Yooliang/asn', '#3', '開啟 GitHub Yooliang/asn#3'],
  ])
  assert.equal(refKind({ n: 5, room: false, repo: 'Yooliang/asn' }), 'github')
  assert.equal(refKind({ n: 5, room: false }), null)
  // 全名跟單獨混用：全名連它自己的 repo，單獨的連夥伴的 repo
  assert.deepEqual(refs(render('x/y#1 與 #2', one)).map(r => [r.repo, r.n]), [['x/y', 1], ['Yooliang/asn', 2]])
})

test('群組：單獨 #N 照舊是群組訊息編號（範圍內、「回 #N」、「#N 則」）；範圍外的單獨 #N 不連 GitHub；全名照樣連', () => {
  assert.equal(refKind({ n: 3900, ...room }), 'group')
  assert.equal(refKind({ n: 3880, ...room }), 'group'); assert.equal(refKind({ n: 3931, ...room }), 'group')
  assert.equal(refKind({ n: 1512, ...room }), null, '範圍外不連 GitHub（群組裡要連 GitHub 一律寫全名）')
  assert.equal(refKind({ n: 1512, ...room, cue: true }), 'group')
  assert.equal(refKind({ n: 5, room: true, lo: null, hi: null }), null)
  assert.equal(refKind({ n: 5, room: true, lo: null, hi: null, cue: true }), 'group')
  assert.equal(refKind({ n: 3900, ...room, repo: 'Yooliang/asn' }), 'group', '群組有 repo 資訊也不影響')
  assert.equal(refKind({ n: 1512, ...room, repo: 'Yooliang/asn' }), null, '群組裡就算帶了 repo，範圍外的單獨 # 也不連')
  const got = refs(render('看 #3923 跟 #1512；回 #1200 說的，還有 #1100 則；全名 Yooliang/asn#1751', room))
  assert.deepEqual(got.map(r => [r.kind, r.n, r.repo, r.title]), [
    ['group', 3923, '', '跳到群組第 3923 則'],
    ['group', 1200, '', '跳到群組第 1200 則'],
    ['group', 1100, '', '跳到群組第 1100 則'],
    ['github', 1751, 'Yooliang/asn', '開啟 GitHub Yooliang/asn#1751'],
  ])
  assert.match(render('看 #3923 跟 #1512', room), /跟 #1512/, '範圍外的 #1512 維持普通文字')
})

test('一對一：「回 #N」等群組提示字不影響（一對一沒有群組訊息編號）', () => {
  assert.deepEqual(refs(render('回 #3923', oneNoRepo)), [])
  assert.deepEqual(refs(render('回 #3923', one)).map(r => [r.kind, r.n]), [['github', 3923]])
})

test('程式碼區塊、行內程式碼、網址、Markdown 連結裡的 # 與全名都不轉', () => {
  const md = [
    '```',
    'git log #3923 Yooliang/asn#1512',
    '```',
    '行內 `#3900` 與 `Yooliang/asn#9` 不動',
    'https://github.com/Yooliang/asn/issues/1#issuecomment-3923',
    'https://github.com/Yooliang/asn#1512',
    'https://example.com/page#3923',
    'example.com/foo/bar#77',
    '[看 #3923](https://example.com/#3923)',
    '[Yooliang/asn#5](https://example.com/x)',
    '<https://example.com/x#1512>',
    '外面的 #3901 與 Yooliang/asn#4 要處理',
  ].join('\n')
  for (const ctx of [one, { ...room, repo: 'Yooliang/asn' }]) {
    const out = render(md, ctx)
    assert.deepEqual(refs(out).map(r => r.n), [3901, 4]   /* 群組：3901 在範圍內＝群組編號；一對一：連夥伴的 repo。兩邊都有 */, JSON.stringify(ctx))
  }
  const out = render(md, one)
  assert.match(out, /<pre class="md-code"><code>git log #3923 Yooliang\/asn#1512<\/code><\/pre>/)
  assert.match(out, /<code>#3900<\/code>/)
  assert.match(out, /<code>Yooliang\/asn#9<\/code>/)
})

test('非 github 網域：只會產生 github.com 連結；別人的網域寫法一律不轉', () => {
  const out = render('https://gitlab.com/Yooliang/asn/-/issues/5 gitlab.com/o/r#5 evil.com/o/r#6 user@evil.com/o/r#7', oneNoRepo)
  assert.deepEqual(refs(out), [])
  const all = refs(render('a/b#1 和 #2 與 c-d/e_f#3', one))
  assert.ok(all.length === 3)
  for (const r of all) assert.match(githubUrl(r.repo, r.n), /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/\d+$/)
})

test('前面緊貼英數字、底線的不轉（a#1、C#12、abc#12、foo_a/b#1 的 foo_ 部分）', () => {
  const cases = ["it's", '&#39;', 'C#12', 'abc#12', '##12', '#012', '#12345678', '#12abc', '#12_x', 'a/#12', '#', 'a.b/c#1', 'x:a/b#1', 'u@a/b#1']
  for (const c of cases) for (const ctx of [one, room]) assert.deepEqual(refs(render(c, ctx)), [], `${c} ${JSON.stringify(ctx)}`)
  assert.deepEqual(refs(render('&#3900', one)), [], '原文的 &#N 不是編號')
  assert.deepEqual(refs(render('# 3900 標題', one)), [], '「# 標題」是 Markdown 標題')
  assert.deepEqual(refs(render('#3900 開頭', one)).map(r => r.n), [3900])
  assert.deepEqual(refs(render('（#3900）、#3901。見#3902', one)).map(r => r.n), [3900, 3901, 3902])
})

test('跟 @ 點名標記並存；沒有 # 原樣回傳；輸出沒有原文帶進來的屬性', () => {
  const html = linkRefs(markMentions(renderMarkdown('@asn真 回 #3923 與 a/b#1'), ['asn真']), room)
  assert.match(html, /<span class="mention">@asn真<\/span>/)
  assert.deepEqual(refs(html).map(r => [r.kind, r.n]), [['group', 3923], ['github', 1]])
  assert.equal(linkRefs('<p>abc</p>', room), '<p>abc</p>')
  const out = render('#3900 <img src=x onerror=alert(1)> "#3901" "a/b#2"', one)
  assert.doesNotMatch(out, /<img/)
  assert.deepEqual(refs(out).map(r => r.n), [3900, 3901, 2])
})

test('refOf：只認標記上的 data-ref／data-n／data-repo；data-repo 被改成怪的就不開', () => {
  const el = (attrs, hit = true) => ({ closest: sel => (hit && sel === '.msg-ref[data-ref]' ? { getAttribute: k => attrs[k] ?? null } : null) })
  assert.deepEqual(refOf(el({ 'data-ref': 'github', 'data-n': '1512', 'data-repo': 'Yooliang/asn' })), { kind: 'github', n: 1512, repo: 'Yooliang/asn' })
  assert.deepEqual(refOf(el({ 'data-ref': 'group', 'data-n': '3923' })), { kind: 'group', n: 3923 })
  assert.equal(refOf(el({ 'data-ref': 'github', 'data-n': '1512' })), null, 'github 沒有 repo')
  assert.equal(refOf(el({ 'data-ref': 'github', 'data-n': '1', 'data-repo': 'a/b/../c' })), null)
  assert.equal(refOf(el({ 'data-ref': 'github', 'data-n': '1', 'data-repo': 'evil.com/x?y' })), null)
  assert.equal(refOf(el({ 'data-ref': 'evil', 'data-n': '1' })), null)
  assert.equal(refOf(el({ 'data-ref': 'github', 'data-n': '1/../x', 'data-repo': 'a/b' })), null)
  assert.equal(refOf(el({ 'data-ref': 'group', 'data-n': '0' })), null)
  assert.equal(refOf(el({}, false)), null)
  assert.equal(refOf(null), null)
})

test('設定勾選已拿掉（#1776）：沒有 ghRefs／gh-refs／GH_REFS 的任何殘留；舊存檔有 ghRefs 讀到忽略不報錯', () => {
  assert.equal('ghRefs' in DEFAULT_PREFS, false)
  assert.equal('ghRefs' in normalizePrefs({ ghRefs: true }), false, '舊存檔的值不帶進來')
  assert.doesNotThrow(() => normalizePrefs({ ghRefs: 'x', vibrateMsg: true }))
  assert.equal(normalizePrefs({ ghRefs: true, vibrateMsg: true }).vibrateMsg, true, '其他欄位照讀')
  assert.ok(!lookOptions('aero').includes('ghRefs')); assert.ok(!SETTING_KEYS.includes('gh-refs'))
  for (const f of ['list.js', 'list.html', 'chat.js', 'chat.html', 'm.js', 'm.html', 'lib/settings-panel.mjs', 'lib/settings-cats.mjs', 'lib/chatpane.mjs', 'lib/mobile.mjs', 'lib/msg-ref.mjs']) {
    assert.doesNotMatch(rd(f).replace(/舊存檔裡的 ghRefs[^\n]*/, ''), /ghRefs|gh-refs|GH_REFS/, f)
  }
  assert.doesNotMatch(rd('lib/chatpane.mjs'), /ghRefs/)
})

test('夥伴的 repo：只有電腦版的一對一、本機視窗才去查；查到的要驗過才用；手機不查', () => {
  const pane = rd('lib/chatpane.mjs')
  assert.match(pane, /typeof props\.agentApi\?\.partnerRepo !== 'function'/, '手機沒有這個指令＝不查')
  assert.match(pane, /f\.node !== props\.selfNode/, '只查這台電腦上的視窗')
  assert.match(pane, /f\.room === true/, '群組不查')
  assert.match(pane, /partnerRepo\.value = parseRepo\(r\) \? r : ''/, '查到的要驗過')
  assert.match(pane, /const refCtx = computed\(\(\) => \(isRoom\.value \? \{ room: true, \.\.\.refRange\(props\.log, props\.friend\?\.lastSeq\) \} : \{ room: false, repo: partnerRepo\.value \}\)\)/)
  assert.match(pane, /const url = githubUrl\(ref\.repo, ref\.n\)/, '點的時候再驗一次才開')
  assert.match(rd('lib/tauri.mjs'), /partnerRepo: name => invoke\('partner_repo', \{ name \}\)/)
  assert.doesNotMatch(rd('m.js'), /partner_repo|partnerRepo/)
})

test('長按只算手指；空白鍵跟 Enter 一樣能開', () => {
  const pane = rd('lib/chatpane.mjs')
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

test('長字串不會讓編號辨識卡住：5 萬字接 #1、5 萬字 a/b 重複、混合長字串各自在 200ms 內完成', () => {
  const cases = {
    '5 萬個 a 接 #1': 'a'.repeat(50000) + '#1',
    '5 萬字 a/b 重複': 'a/b'.repeat(16700) + '#1',
    '混合長字串': ('x-y.z/' + 'ab'.repeat(20) + ' 中文 #' + '1'.repeat(3) + ' ').repeat(900) + 'c'.repeat(20000) + '#5',
    '5 萬個 - 接 #1': '-'.repeat(50000) + '#1',
  }
  for (const [name, text] of Object.entries(cases)) {
    const t0 = performance.now()
    const out = linkRefs(text, one)
    const ms = performance.now() - t0
    assert.ok(ms < 200, `${name} 花了 ${ms.toFixed(0)}ms`)
    assert.equal(typeof out, 'string')
  }
  // 行為不變：長字串後面接的正常編號照樣認得
  assert.deepEqual(refs(linkRefs('a'.repeat(50000) + ' Yooliang/asn#9', oneNoRepo)).map(r => r.repo), ['Yooliang/asn'])
})
