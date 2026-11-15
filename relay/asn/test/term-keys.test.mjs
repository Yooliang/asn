// 手機看終端的按鍵列、複製畫面文字、登入網址（#1512 B）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_KEYS, KEYS_TEXT, LOGIN_HOSTS, joinWrapped, findLoginUrls, droppedGrew } from '../ui/lib/term-keys.mjs'

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
  assert.match(sk, /send\(seq, false\)/, '按鍵一律當打字（不走貼上）')
  // 登入網址只用 open_link 開，開之前再比一次網域
  const open = chat.split('const openLogin = u => {')[1].split('\n')[0]
  assert.match(open, /findLoginUrls\(u\?\.url\)\.length/)
  assert.match(open, /'open_link'/)
})
