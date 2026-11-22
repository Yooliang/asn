// 手機看終端的按鍵列、複製畫面文字、登入網址（#1512 B）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_KEYS, KEYS_TEXT, LOGIN_HOSTS, joinWrapped, stripAnsi, findLoginUrls, droppedGrew } from '../ui/lib/term-keys.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('按鍵列：1、2、3、上、下、Esc、Enter，送的是固定的按鍵', () => {
  assert.deepEqual(TERM_KEYS.map(k => k.label), ['1', '2', '3', '↑', '↓', 'Esc', 'Enter'])
  assert.deepEqual(TERM_KEYS.map(k => k.seq), ['1', '2', '3', '\x1b[A', '\x1b[B', '\x1b', '\r'])
  for (const k of TERM_KEYS) assert.ok(k.aria && !/[A-Za-z]{4,}/.test(k.aria.replace(/Esc|Enter/g, '')), k.aria)
})

test('折行接回：寫滿一列的接下一列；分隔線不算；每列尾空白和最後的空行拿掉', () => {
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz'
  const rows = [url.slice(0, 30), url.slice(30, 60), url.slice(60), '', '─'.repeat(30), '下一行   ', '', '']
  assert.equal(joinWrapped(rows.join('\n'), 30), [url, '', '─'.repeat(30), '下一行'].join('\n'))
  // 全形字：10 個字＝20 格，寫滿
  assert.equal(joinWrapped('一二三四五六七八九十\n接著', 20), '一二三四五六七八九十接著')
  assert.equal(joinWrapped('一二三\n不接', 20), '一二三\n不接')
  // 欄數不明：不接
  assert.equal(joinWrapped('a'.repeat(20) + '\nb', 0), 'a'.repeat(20) + '\nb')
  assert.equal(joinWrapped('x\r\ny', 80), 'x\ny')
})

test('登入網址：只收 https、官方網域、沒有帳密；結尾標點拿掉；重複的只留一個；最多兩個', () => {
  const ok = 'https://claude.ai/oauth/authorize?code=true&client_id=abc'
  assert.deepEqual(findLoginUrls(`請開 ${ok}。`), [{ url: ok, host: 'claude.ai' }])
  assert.deepEqual(findLoginUrls(`(${ok}) 再一次 ${ok}`).map(u => u.url), [ok])
  for (const bad of [
    'http://claude.ai/oauth/authorize',
    'https://claude.ai.evil.com/oauth',
    'https://evil.com/?r=https//claude.ai',
    'https://user:pw@claude.ai/oauth',
    'https://sub.claude.ai/oauth',
    'https://xn--claude-ai.com/',
  ]) assert.deepEqual(findLoginUrls(bad), [], bad)
  const many = LOGIN_HOSTS.map(h => `https://${h}/login`).join(' ')
  assert.equal(findLoginUrls(many).length, 2)
  assert.deepEqual(findLoginUrls(''), [])
  assert.deepEqual(findLoginUrls(null), [])
})

test('那台回報拿掉按鍵的次數：變大才算', () => {
  assert.equal(droppedGrew(0, 1), true)
  assert.equal(droppedGrew(1, 1), false)
  assert.equal(droppedGrew(1, 2), true)
  assert.equal(droppedGrew(2, undefined), false)
  assert.equal(droppedGrew(0, null), false)
  assert.ok(KEYS_TEXT.dropped.includes('沒有送出'))
})

test('守門：按鍵列只走打字的同一條路（remoteInputApi.send 經 RemoteInput.send），不另開入口', () => {
  const chat = fs.readFileSync(path.join(root, 'ui/lib/chatpane.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const press = chat.split('const pressKey = k => {')[1].split('\n    }\n')[0]
  assert.match(press, /rinEl\.value\?\.sendKey\?\.\(k\.seq\)/)
  assert.doesNotMatch(press, /invoke|api\.send/, '不直接呼叫後端')
  const rin = fs.readFileSync(path.join(root, 'ui/lib/term-remote-input.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const sk = rin.split('const sendKey = seq => {')[1].split('\n    }\n')[0]
  assert.match(sk, /chainKey\(seq\)/, '按鍵串成一條送')
  assert.doesNotMatch(sk, /void send\(/, '不直接連發')
  assert.match(rin, /const keyChain = createKeyChain\(seq => send\(seq, false\)\)/, '按鍵一律當打字（不走貼上）')
  assert.match(rin, /const flushKeys = \(\) => \{ const ks = keyQueue; keyQueue = \[\]; ks\.forEach\(chainKey\) \}/, '排著的也串成一條')
  // 登入網址只用 open_link 開，開之前再比一次網域
  const open = chat.split('const openLogin = u => {')[1].split('\n')[0]
  assert.match(open, /findLoginUrls\(u\?\.url\)\.length/)
  assert.match(open, /openLink\(u\.url\)/)   // 開連結只走出口的 openLink（#2106）
  assert.match(fs.readFileSync(path.join(root, 'ui/lib/tauri.mjs'), 'utf8'), /openLink = url => .*invoke\('open_link', \{ url \}\)/)
})

test('按鍵串成一條：前一顆確認回來才送下一顆，順序不看誰先回（#1561 必修①）', async () => {
  const { createKeyChain } = await import('../ui/lib/term-keys.mjs')
  const started = [], done = []
  // 第一顆回得最慢、第二顆最快：還是要照按的順序一顆一顆送
  const delays = { down: 40, enter: 1, one: 5 }
  const chain = createKeyChain(seq => { started.push(seq); return new Promise(r => setTimeout(() => { done.push(seq); r(true) }, delays[seq])) })
  chain.push('down'); chain.push('enter')
  await chain.push('one')
  assert.deepEqual(started, ['down', 'enter', 'one'])
  assert.deepEqual(done, ['down', 'enter', 'one'], '前一顆沒回來，下一顆不會開始')
})

test('按鍵串成一條：有一顆沒送出（或出錯），後面排著的都不送；之後新按的照常', async () => {
  const { createKeyChain } = await import('../ui/lib/term-keys.mjs')
  const sent = []
  const chain = createKeyChain(async seq => { sent.push(seq); if (seq === 'bad') return false; if (seq === 'boom') throw new Error('x'); return true })
  chain.push('a'); chain.push('bad'); chain.push('enter')
  await chain.push('more')
  assert.deepEqual(sent, ['a', 'bad'], '「bad」沒送出：後面的 Enter 不送')
  await chain.push('next')
  assert.deepEqual(sent, ['a', 'bad', 'next'], '失敗之後新按的照常送')
  chain.push('boom'); await chain.push('after')
  assert.deepEqual(sent, ['a', 'bad', 'next', 'boom'], '丟錯也算沒送出')
})

test('按鍵串成一條：結束打字時排著還沒送的作廢', async () => {
  const { createKeyChain } = await import('../ui/lib/term-keys.mjs')
  const sent = []
  let release
  const chain = createKeyChain(seq => { sent.push(seq); return seq === 'slow' ? new Promise(r => { release = r }) : Promise.resolve(true) })
  chain.push('slow'); const last = chain.push('enter')
  await new Promise(r => setTimeout(r, 5))
  chain.cancel(); release(true)
  await last
  assert.deepEqual(sent, ['slow'])
})

// #1696：Claude Code 新版的顏色寫法是冒號子參數（38:2::r:g:b，中間空一格色彩空間）；畫面文字不能把序列殘字印出來
const CC = [
  '\x1b[38:2::153:153:153m╭──────────────╮\x1b[39m',
  '\x1b[38:2::255:255:255m\x1b[48:2::55:55:55m 你好 \x1b[39m\x1b[49m\x1b(B\x1b[0;1m粗\x1b[0m',
  '\x1b[38:2:215:119:87m\x1b[58:2::255:0:0m\x1b[4:3m底線\x1b[59m\x1b[24m\x1b[B\x1b[0;1m完',
].join('\n')
test('畫面文字去掉跳脫序列（冒號全彩 38／48／58、分號、字元集、OSC），不留序列的殘字', () => {
  const plain = stripAnsi(CC)
  assert.equal(plain, ['╭──────────────╮', ' 你好 粗', '底線完'].join('\n'))
  assert.doesNotMatch(plain, /\[|\x1b|38:2|0;1m|\(B/)
  assert.equal(stripAnsi('a\x1b[1;38;2;1;2;3mb\x1b[39mc'), 'abc', '分號寫法照舊')
  assert.equal(stripAnsi('\x1b]8;;https://claude.ai/x\x07連結\x1b]8;;\x07'), '連結', 'OSC 8')
  assert.equal(stripAnsi('x\x1b'), 'x', '落單的 ESC 也拿掉')
  assert.equal(stripAnsi(null), '')
})

test('帶顏色的畫面接折行：序列不算字寬、不印殘字；登入網址照樣找得到', () => {
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc'
  const c = t => '\x1b[38:2::153:153:153m' + t + '\x1b[39m'
  const rows = [c(url.slice(0, 30)), c(url.slice(30)), c('下一行')]
  const out = joinWrapped(rows.join('\r\n'), 30)
  assert.equal(out, url + '\n下一行')
  assert.deepEqual(findLoginUrls(out).map(x => x.url), [url])
})
