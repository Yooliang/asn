// 手機對話頂端的名牌（#1421 B 之三，只在現代外觀）：左返回、中間名牌（頭像、名字、哪台電腦・狀態）、右「看終端」；點名牌開「⋯」選單。
// 復古 Aero 下名牌與看終端不顯示，畫面照舊是頭像、名字、「⋯」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { nameplateView } from '../ui/lib/actionbar.mjs'

const read = p => fs.readFileSync(new URL(`../ui/${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const html = read('m.html'), js = read('m.js'), css = read('mobile.css'), modern = read('modern.css')
const head = html.slice(html.indexOf('<header class="m-head m-chathead"'), html.indexOf('</header>', html.indexOf('<header class="m-head m-chathead"')))

test('名牌的字和電腦頂部共用 nameplateView：名字、哪台電腦・狀態；離線標灰；群組寫「群組」', () => {
  assert.match(js, /import \{ chatGroupItems, nameplateView \} from '\.\/lib\/actionbar\.mjs'/)
  assert.match(js, /const chatPlate = computed\(\(\) => \(chatFriend\.value \? nameplateView\(chatFriend\.value\) : null\)\)/)
  const on = nameplateView({ id: 'Q/demo', nick: 'demo', device: '辦公室', status: 'online' })
  assert.equal(on.sub, '辦公室・在線'); assert.equal(on.offline, false)
  const off = nameplateView({ id: 'Q/demo', nick: 'demo', device: '辦公室', status: 'offline' })
  assert.equal(off.sub, '辦公室・離線'); assert.equal(off.offline, true)
  assert.equal(nameplateView({ id: 'r', nick: '群', room: true }).sub, '群組')
})

test('接線：名牌點了開「⋯」選單（沒有項目時不能按）；看終端切的是對話窗格裡同一顆切換', () => {
  assert.match(head, /<button class="m-plate" type="button" :class="\{ 'is-offline': chatPlate\.offline \}"[^>]*:disabled="!opsItems\.length && !groupItems\.length" @click="openOps">/)
  assert.match(head, /<b class="m-plate-name" v-html="emo\(chatPlate\.name\)"><\/b><small class="m-plate-sub" v-if="chatPlate\.sub">\{\{ chatPlate\.sub \}\}<\/small>/, '名字照舊過 emo（表情符號）；副標是純文字')
  assert.match(head, /<button class="m-icon-btn m-head-term" type="button" v-if="headTerm"[^>]*@click="toggleHeadTerm">/)
  assert.match(html, /<chat-pane v-if="chatFriend" :friend="chatFriend"[\s\S]*?ref="chatPaneEl"><\/chat-pane>/)
  assert.match(js, /const headTerm = computed\(\(\) => \{ const p = chatPaneEl\.value; return p && p\.mSwitch \? p\.mToggle : null \}\)/, '只有能看終端（和下方切換鈕同一個條件）才出現')
  assert.match(js, /function toggleHeadTerm\(\) \{ const p = chatPaneEl\.value; if \(!p \|\| !p\.mSwitch\) return; if \(p\.remoteShown\) p\.showMsgs\(\); else p\.showTerm\(\) \}/)
  // 忙碌／離線的變色（#1423 修好的）照舊掛在標題列上
  assert.match(html, /m-chathead" :class="\{ 'is-busy': chatFriend && headTone\(chatFriend\.status, chatFriend\) === 'busy', 'is-offline': [^"]*'m-plate-head': chatFriend \}"/)
})

test('復古 Aero 不變：名牌與看終端在 mobile.css 預設不顯示；顯示只寫在 modern.css、全部限定現代', () => {
  assert.match(css, /\.m-chathead \.m-plate,\.m-chathead \.m-head-term\{display:none\}/)
  assert.doesNotMatch(css, /m-plate-head/, 'mobile.css 不排名牌的版面')
  const rules = modern.split('\n').filter(l => /m-plate|m-head-term|m-head-more|m-term-switch/.test(l) && l.includes('{'))
  assert.ok(rules.length >= 8, '現代有名牌的規則')
  for (const l of rules) assert.match(l, /^:root\[data-skin="modern"\] /, l)
  assert.match(modern, /:root\[data-skin="modern"\] \.m-plate-head > \.m-pic,:root\[data-skin="modern"\] \.m-plate-head > \.m-head-tx,:root\[data-skin="modern"\] \.m-plate-head > \.m-head-more\{display:none\}/, '現代下收起原本的頭像、名字、「⋯」（「⋯」改由點名牌打開）')
  assert.match(modern, /:root\[data-skin="modern"\] \.m-chat \.m-term-switch\{display:none\}/, '下方工具列那顆搬到頂端了')
  assert.match(modern, /\.m-plate\.is-offline\{background:#efeeea\}/, '離線名牌變灰')
})
