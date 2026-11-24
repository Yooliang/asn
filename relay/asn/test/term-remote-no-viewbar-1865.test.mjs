// #1865：看別台夥伴的終端時，打字框已經能送出（送出才向那台要打字權限），畫面不能再寫「只能看」，也不留那條藍色狀態列。
// 看的是哪台、哪位併進輸入框的提示字。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { REMOTE_TEXT, REMOTE_TIP, remoteBarState } from '../ui/lib/term-remote.mjs'
import { INPUT_TEXT } from '../ui/lib/term-remote-input.mjs'
import { composeRemoteHint } from '../ui/lib/compose.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const visible = src => src.split(/\r?\n/).map(l => l.replace(/\s\/\/.*$/, '').replace(/^\s*\/\/.*$/, '')).join('\n')   // 不看註解

test('看畫面的狀態列：沒有「正在看…（只能看）」，正在看時沒有任何狀態條', () => {
  assert.equal(REMOTE_TEXT.watching, undefined)
  const main = { waiting: REMOTE_TEXT.waiting, active: '' }
  assert.equal(remoteBarState({ phase: 'watching', soon: false, note: '', warn: '', main, danger: false }), null)
  // 快到期、等待、結束照舊
  assert.equal(remoteBarState({ phase: 'watching', soon: true, note: '', warn: '', main, danger: false }).text, REMOTE_TEXT.soon)
  assert.equal(remoteBarState({ phase: 'waiting', soon: false, note: '', warn: '', main, danger: false }).level, 'ask')
  assert.equal(remoteBarState({ phase: 'ended', soon: false, note: '時間到了', warn: '', main, danger: false }).text, '時間到了')
})

test('看畫面的畫面範本：沒有藍條那一行，也沒有「只能看」', () => {
  const src = read('../ui/lib/term-remote.mjs')
  const tpl = src.slice(src.indexOf('template: `'))
  assert.ok(!tpl.includes('term-remote-bar'), '範本裡沒有藍條')
  assert.ok(!tpl.includes('只能看'), '範本（含無障礙標籤）沒有「只能看」')
  assert.ok(!REMOTE_TIP.includes('只能看'), '終端分頁的提示沒有「只能看」')
})

test('打字框旁的按鈕與提示字：不寫「只能看」；原本藍條上的哪台、哪位在提示字裡', () => {
  assert.ok(!INPUT_TEXT.back.includes('只能看'))
  assert.equal(INPUT_TEXT.back, '只看畫面')
  const hint = composeRemoteHint('demo', '辦公室')
  assert.ok(hint.includes('辦公室') && hint.includes('demo'))
  assert.ok(!hint.includes('只能看') && !hint.includes('要打字權限'))
  assert.equal(hint, '看辦公室「demo」，送出即打字')
  assert.ok([...hint].length <= 16, '360 寬的手機也放得下（實測約 17 個字會被截）')
  // chatpane 要把那台的名字傳進去
  assert.match(read('../ui/lib/chatpane.mjs'), /composeRemoteHint\(termViewName\.value, props\.friend\?\.device/)
})

test('遠端終端相關檔案，畫面上的字都不再出現「只能看」', () => {
  for (const f of ['../ui/lib/term-remote.mjs', '../ui/lib/term-remote-input.mjs', '../ui/lib/compose.mjs']) {
    assert.ok(!visible(read(f)).includes('只能看'), `${f} 還有「只能看」`)
  }
})
