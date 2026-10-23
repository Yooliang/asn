// 對話上方功能列（#40）：只放已有功能的按鈕、中文提示、圖示檔都在、兩種對話視窗都接上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canOfferCall, canOfferConsole, consoleButtonView, friendEngine, opsMenuItems } from '../ui/lib/actionbar.mjs'
import { roomHue, roomInitial } from '../ui/lib/groups.mjs'

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
  assert.equal(imgs.length, 6)
  for (const m of imgs) assert.match(fs.readFileSync(path.join(root, 'ui', m[1]), 'utf8'), /^<svg/, m[1])
  assert.ok(!/v-html|innerHTML/.test(t))
})

test('不放假按鈕：功能列只有通話、主控台、喚醒、切換模型、子代理、管理六個動作', () => {
  assert.equal([...read('ui/lib/actionbar.mjs').matchAll(/class="abtn"/g)].length, 6)
})

test('兩種對話視窗都把 transport 與本機節點傳給對話區，對話區放了功能列', () => {
  assert.match(read('ui/chat.html'), /:agent-api="transport" :self-node="selfNode"/)
  assert.match(read('ui/list.html'), /:agent-api="transport" :self-node="selfNode"/)
  assert.match(read('ui/lib/chatpane.mjs'), /<action-bar :friend="friend" :self-node="selfNode" :api="agentApi"/)
  assert.ok(read('ui/style.css').includes('.actionbar'))
})

test('管理按鈕（原收件人列的「⋯」）：群組三項、可邀請的一對一一項、其他沒有；群組不放通話與主控台', () => {
  assert.deepEqual(opsMenuItems({ room: true }).map(i => i.key), ['invite', 'addai', 'manage'])
  assert.equal(opsMenuItems(null).length, 0)
  assert.equal(opsMenuItems({ id: 'pending:1' }).length, 0)
  assert.equal(canOfferCall({ room: true, status: 'online' }), false)
  assert.equal(canOfferConsole({ room: true, node: 'H' }, 'H'), false)
})

test('「⋯」搬到大按鈕區：收件人列不再有選單，大按鈕區有「管理」鈕，選單搬到 body 並用 fixed 定位', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.ok(!/to-menu/.test(pane), '收件人列不該再有「⋯」')
  assert.ok(!/to-menu/.test(read('ui/group.css')))
  assert.match(pane, /<action-bar [^>]*v-if="!isRoom \|\| opsItems\.length" :ops="opsItems" @ops="pickMenu"/, '群組對話也要有大按鈕區')
  const ab = read('ui/lib/actionbar.mjs')
  assert.match(ab, /aria-label="管理"/)
  assert.match(ab, /<teleport to="body">/)
  assert.match(read('ui/style.css'), /\.ab-ops\{position:fixed;z-index:70/)
})

test('群組列表：未讀徽章垂直置中、不被拉長；大頭像與個人名單同一個 dp xs 尺寸', () => {
  const html = read('ui/list.html'), css = read('ui/group.css')
  assert.match(html, /<span class="dp xs room-av/)
  assert.match(html, /<span class="dp xs" :class="'st-' \+ c\.status">/, '個人名單也是 dp xs')
  assert.ok(!/room-ic/.test(html))
  assert.match(css, /\.room-btn\{display:flex;align-items:center;/)
  assert.match(css, /\.room-btn \.unread\{align-self:center;height:18px/)
  assert.equal(roomInitial('  小良 團隊'), '小')
  assert.equal(roomInitial(''), '群')
  assert.equal(roomHue('abc'), roomHue('abc'))
  assert.ok(roomHue('團購群') >= 0 && roomHue('團購群') < 360)
})
