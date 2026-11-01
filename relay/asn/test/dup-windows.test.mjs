// 同一段對話開了兩個視窗（#584）：電腦端說明信的記號行換成「關掉第 N 個」按鈕，按了寄出關閉指令；
// 自己寄出的指令顯示白話；說明頁寫上「不要用 /resume」與暫時做法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DUP_SENT_TEXT, dupCloseLabel, dupCloseText, shownMine, splitDupMark } from '../ui/lib/dup-windows.mjs'
import { guideByKey } from '../ui/lib/guides.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8').replace(/\r\n/g, '\n')

const NOTICE = '「甲」同一段對話開了兩個視窗，這封信沒送出。\n請按下面的「關掉」關掉其中一個，剩一個時會自動重送。\n1. 約 3 小時前開的，ASN 開的，有遠端控制\n2. 剛剛開的，自己開的，沒有遠端控制\n〔重複視窗 1=1234 2=5678〕'

test('記號：只認最後一行整行，拆出每個視窗的編號與程序；內文不含記號', () => {
  const r = splitDupMark(NOTICE)
  assert.deepEqual(r.wins, [{ n: 1, pid: 1234 }, { n: 2, pid: 5678 }])
  assert.ok(!r.text.includes('〔重複視窗') && r.text.endsWith('沒有遠端控制'))
  assert.deepEqual(splitDupMark(`${NOTICE}\n\n`).wins.length, 2, '結尾空行不影響')
})

test('記號：中間出現、格式不對、只有一個視窗的都不算，原文照舊', () => {
  for (const s of ['〔重複視窗 1=1234 2=5678〕\n後面還有字', '前面〔重複視窗 1=1 2=2〕', '〔重複視窗 1=1234〕', '〔重複視窗 1=abc 2=5〕', '〔重複視窗 0=1 2=2〕', '一般的回覆', '', null]) {
    const r = splitDupMark(s)
    assert.deepEqual(r.wins, [], String(s))
    assert.equal(r.text, String(s ?? ''))
  }
})

test('按鈕字樣與寄出的指令；自己寄出的指令顯示白話，其他內文原樣', () => {
  assert.equal(dupCloseLabel(2), '關掉第 2 個')
  assert.ok(dupCloseLabel(12).length <= 20 && DUP_SENT_TEXT.length <= 20)
  assert.equal(dupCloseText(5678), '/asn-close-dup 5678')
  assert.equal(shownMine('/asn-close-dup 5678'), DUP_SENT_TEXT)
  assert.equal(shownMine('  /asn-close-dup 5678 \n'), DUP_SENT_TEXT)
  assert.equal(shownMine('/asn-close-dup 56 78'), '/asn-close-dup 56 78')
  assert.equal(shownMine('你好'), '你好')
  assert.equal(shownMine(undefined), '')
})

test('對話窗：只拆對方私信的記號、按鈕一直看得到、按一次就反灰、按了寄出關閉指令', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.match(pane, /const d = m\?\.k === 'them' && !isRoom\.value \? splitDupMark\(b\.text\)/, '群組不拆')
  assert.match(pane, /text: shownMine\(m\?\.text\)/, '自己寄出的指令顯示白話')
  assert.match(pane, /<div class="dup-act" v-if="shownBody\(m\)\.dup\.length"/)
  assert.match(pane, /class="dup-close" type="button" :disabled="dupPressed\(m, i\) \|\| displayOnly" @click="closeDup\(m, i, w\)"/)
  assert.match(pane, /emit\('send', dupCloseText\(w\.pid\)\)/)
  const css = read('ui', 'group.css')
  assert.match(css, /\.dup-act\{display:flex/)
  assert.ok(!/\.dup-act\{[^}]*opacity:0/.test(css), '不是滑過才出現')
})

test('說明頁：常見問題寫上不要用 /resume、按鈕怎麼用、自動重送與暫時做法', () => {
  const faq = guideByKey('faq').blocks
  assert.ok(faq.some(b => b.k === 'h' && b.t.includes('同一段對話開了兩個視窗')))
  const text = faq.map(b => b.t).join('\n')
  for (const w of ['/resume', '關掉第 N 個', '自動重送', '換班接手', '遠端控制']) assert.ok(text.includes(w), w)
})
