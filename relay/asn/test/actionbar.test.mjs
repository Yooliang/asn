// 對話上方功能列（#40）：只放已有功能的按鈕、中文提示、圖示檔都在、兩種對話視窗都接上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canOfferCall, canOfferConsole, consoleButtonView, friendEngine } from '../ui/lib/actionbar.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

test('主控台按鈕：只有本機、已開起來、非雲端代理的視窗', () => {
  assert.equal(canOfferConsole({ node: 'H' }, 'H'), true)
  assert.equal(canOfferConsole({ node: 'W' }, 'H'), false, '別台設備')
  assert.equal(canOfferConsole({ node: 'H', engine: 'acp' }, 'H'), false)
  assert.equal(canOfferConsole({ node: 'H', pending: true }, 'H'), false)
  assert.equal(canOfferConsole(null, 'H'), false)
})

test('通話按鈕：夥伴在線、有語音功能才給；離線或等待中的不給', () => {
  assert.equal(canOfferCall({ status: 'online' }), true)
  assert.equal(canOfferCall({ status: 'busy' }), true)
  assert.equal(canOfferCall({ status: 'offline' }), false)
  assert.equal(canOfferCall({ status: 'online', pending: true }), false)
  assert.equal(canOfferCall({ status: 'online' }, { hasVoice: false }), false)
  assert.equal(canOfferCall(null), false)
})

test('主控台按鈕的字：看得到＝切到背景，看不到＝叫回前台，都有提示', () => {
  assert.equal(consoleButtonView(true).label, '切到背景')
  assert.equal(consoleButtonView(false).label, '叫回前台')
  for (const v of [true, false]) assert.match(consoleButtonView(v).tip, /[一-鿿]/)
})

test('代理用哪家指令：名單寫的優先，沒寫看啟動設定，再沒有就是 Claude', () => {
  assert.equal(friendEngine({ engine: 'codex' }), 'codex')
  assert.equal(friendEngine({ launchProfile: 'codex' }), 'codex')
  assert.equal(friendEngine({}), 'claude')
})

test('功能列按鈕都有中文 aria-label 與提示，圖示檔存在且是 SVG', () => {
  const t = read('ui/lib/actionbar.mjs')
  assert.match(t, /aria-label="切換模型"[^>]*title="[^"]*[一-鿿]/)
  assert.match(t, /:title="consoleView\.tip" :aria-label="consoleView\.label"/)
  assert.match(t, /role="toolbar" aria-label="代理功能列"/)
  const imgs = [...t.matchAll(/src="(img\/[^"]+)"/g)]
  assert.equal(imgs.length, 5)
  for (const m of imgs) assert.match(fs.readFileSync(path.join(root, 'ui', m[1]), 'utf8'), /^<svg/, m[1])
  assert.ok(!/v-html|innerHTML/.test(t))
})

test('不放假按鈕：功能列只有通話、主控台、喚醒、切換模型、子代理五個動作', () => {
  assert.equal([...read('ui/lib/actionbar.mjs').matchAll(/class="abtn"/g)].length, 5)
})

test('兩種對話視窗都把 transport 與本機節點傳給對話區，對話區放了功能列', () => {
  assert.match(read('ui/chat.html'), /:agent-api="transport" :self-node="selfNode"/)
  assert.match(read('ui/list.html'), /:agent-api="transport" :self-node="selfNode"/)
  assert.match(read('ui/lib/chatpane.mjs'), /<action-bar :friend="friend" :self-node="selfNode" :api="agentApi"/)
  assert.ok(read('ui/style.css').includes('.actionbar'))
})
