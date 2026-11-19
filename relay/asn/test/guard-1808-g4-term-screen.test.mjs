// #1808 第 4 組守門：遠端看畫面／打字——等待畫面黑掉、疊字、控制碼印成字（復發單號：#1647 #1696 #1697 #1699 #1761 #1784）
//
// 一直被弄壞的那條規則：終端畫面文字有兩種用途，不能混用——
//   1) 「顯示」（等待底圖）：寫畫面原文給 xterm，帶顏色、列數不變（frameToWrite），不經 stripAnsi／joinWrapped；
//   2) 「複製、找網址、判斷要不要人確認」：才去跳脫序列＋接回折行（stripAnsi／joinWrapped）；而且去序列要吃乾淨，不留殘字。
// 歷次：#1697 只修冒號全彩碼的去除；#1761 發現等待底圖拿了給複製用的 joinWrapped（折行黏成一長列）、stripAnsi 還漏 DCS／ESC 7 等；
//       #1784 又把底圖改回帶顏色的原文。樣本都用真的：test/fixtures/term-cursor 是真實 WezTerm 取樣，CC 是真的 Claude Code 新版冒號全彩寫法。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripAnsi, joinWrapped } from '../ui/lib/term-keys.mjs'
import { frameToWrite } from '../ui/lib/term-view.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fixture = name => fs.readFileSync(new URL(`./fixtures/term-cursor/${name}`, import.meta.url), 'utf8')

// 真的 Claude Code 新版畫面：冒號子參數的全彩（38:2::r:g:b／48:2:r:g:b／58:2::r:g:b）、字元集 ESC(B、游標下移 ESC[B
const CC = [
  '\x1b[38:2::153:153:153m╭──────────────╮\x1b[39m',
  '\x1b[38:2::255:255:255m\x1b[48:2::55:55:55m 你好 \x1b[39m\x1b[49m\x1b(B\x1b[0;1m粗\x1b[0m',
  '\x1b[38:2:215:119:87m\x1b[58:2::255:0:0m\x1b[4:3m底線\x1b[59m\x1b[24m\x1b[B\x1b[0;1m完',
].join('\n')

// 真的 WezTerm 取樣 E：40 欄×120 的全形字整列寫滿、每列折行，行首帶 ESC(B ESC[0m
const E = fixture('E.escapes.txt')
const EMETA = JSON.parse(fixture('E.json'))

test('#1697 #1696 看別台終端的畫面文字去序列：冒號全彩碼不再印成字（真的 Claude Code 畫面）', () => {
  const plain = stripAnsi(CC)
  assert.equal(plain, ['╭──────────────╮', ' 你好 粗', '底線完'].join('\n'))
  assert.doesNotMatch(plain, /\x1b|\[[0-9;:]*[A-Za-z]|38:2|48:2|58:2|\(B/, '不留序列殘字')
})

test('#1697 #1761 去序列吃乾淨：真實 WezTerm 取樣、DCS／APC／OSC／ESC 7／SI SO 都不留殘字', () => {
  // 真實樣本：只剩字，沒有 ESC 也沒有 (B／[0m 殘字
  const plainE = stripAnsi(E)
  assert.doesNotMatch(plainE, /\x1b|\(B|\[0m/)
  assert.ok(plainE.includes('全'.repeat(10)) || plainE.includes('冘'.repeat(10)) || /[^\s]{20}/.test(plainE), '字還在')
  // 終端常見的其他序列（Claude Code／WezTerm 實際會吐的）
  const noisy = '\x1b[?2026h\x1b]0;claude\x07\x1b7\x1bP1$r0m\x1b\\a\x1b_Gi=1;OK\x1b\\b\x1b8\x0e\x0fc\x1b[?2026l'
  assert.equal(stripAnsi(noisy), 'abc')
})

test('#1761 #1784 等待底圖寫畫面原文：真實折行畫面的列數不變、顏色碼還在（不經 joinWrapped／stripAnsi）', () => {
  const rows = E.replace(/(\r?\n)+$/, '').split(/\r?\n/).length
  const w = frameToWrite({ text: E })
  // frameToWrite 前面一段是清畫面、後面一段是游標定位；中間每一列用 \r\n 隔
  const body = w.slice('\x1b[0m\x1b[H\x1b[2J'.length, w.lastIndexOf('\x1b[0m\x1b['))
  assert.equal(body.split('\r\n').length, rows, '列數與原畫面相同（不把折行黏成一長列）')
  assert.ok(body.includes('\x1b[0m'), '顏色／重置碼還在，沒被轉成純文字')
  // 對照：給「複製」用的 joinWrapped 會把寫滿的列接起來——這正是 #1761 拿錯函式的後果
  assert.ok(joinWrapped(E, EMETA.size.cols).split('\n').length < rows, '對照：joinWrapped 會減少列數，不能拿來畫底圖')
  // 帶彩色的 Claude Code 畫面也一樣：顏色不能被拿掉（#1784）
  const wc = frameToWrite({ text: CC })
  assert.ok(wc.includes('\x1b[38:2::153:153:153m') && wc.includes('\x1b[0;1m'), '冒號全彩碼與粗體碼原樣保留')
})

test('#1647 #1699 #1761 #1784 接線：chatpane 的等待底圖那一行不能經過去顏色／接折行的函式', () => {
  const pane = read('ui/lib/chatpane.mjs')
  const line = pane.split('\n').find(l => l.includes('const waitSnap = computed('))
  assert.ok(line, '有 waitSnap')
  const code = line.split('//')[0]
  assert.ok(!/joinWrapped|screenPlain|plainRows|stripAnsi/.test(code), `waitSnap 不能去顏色或接折行：${code}`)
  assert.match(code, /remoteScreen\.value\.text/, '直接用最後一幅畫面的原文')
  // 打字元件把底圖寫進 xterm，不是用 <pre> 純文字墊圖
  const input = read('ui/lib/term-remote-input.mjs')
  assert.match(input, /term\.write\(frameToWrite\(\{ text: props\.snap \}\)\)/)
  assert.ok(!/<pre/.test(input))
})
