// 群組裡點成員跳一對一（#1515）：接線守門（純函式 memberFriendId 在 group-offline.test.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('chatpane：只有群組裡別人的訊息、有成員鍵才能點；名字與頭像有 role、aria-label、鍵盤；不在名單用輸入列下方那行說明', () => {
  const p = read('ui/lib/chatpane.mjs')
  assert.match(p, /openMember: \{ type: Function, default: null \}/)
  assert.match(p, /const canJump = m => !!\(isRoom\.value && props\.openMember && m && m\.k === 'them' && m\.fk\)/, '自己的訊息、一對一、沒有成員鍵都不能點')
  assert.match(p, /if \(!ok\) photoMsg\.value = MEMBER_NOT_FRIEND/)
  assert.match(p, /function onSpk\(m, ev\) \{ if \(!canJump\(m\)\) return; ev\?\.stopPropagation\(\); ev\?\.preventDefault\(\); jumpMember\(m\.fk\) \}/, '不讓整則訊息的點擊（回覆選單）接著觸發')
  // 頭像、兩種名字（.who 與 LINE 的 .l-name）都接上
  assert.equal((p.match(/:role="canJump\(m\) \? 'button' : null" :tabindex="canJump\(m\) \? 0 : null" :aria-label="canJump\(m\) \? jumpLabel\(m\) : null" @click="onSpk\(m, \$event\)" @keydown\.enter="onSpk\(m, \$event\)" @keydown\.space="onSpk\(m, \$event\)"/g) ?? []).length, 3)
  assert.match(p, /<template v-if="m\.k === 'me'">\{\{ plain\(me\.nick\) \}\}<\/template><span class="who-name" v-else/, '自己的名字不包成可點的')
  assert.match(p, /@back="\$emit\('back'\)" @member="jumpMember"><\/action-bar>/, '電腦頂部「N 人離線」名單點的人也走同一條')
})

test('「N 人離線」名單：能點的列（有成員鍵）有 role、aria-label、Enter／空白鍵；點了先收起名單再交給上層', () => {
  const ab = read('ui/lib/actionbar.mjs')
  assert.match(ab, /function pick\(it\) \{ if \(!it\?\.key\) return; open\.value = false; emit\('pick', it\.key\) \}/)
  assert.match(ab, /<li class="menu-note" v-for="it in view\.items"[^>]*:role="it\.key \? 'button' : null"[^>]*@click="pick\(it\)" @keydown\.enter\.prevent="pick\(it\)" @keydown\.space\.prevent="pick\(it\)">\{\{ it\.label \}\}<\/li>/)
  assert.match(ab, /<offline-menu-button v-if="isRoom" :names="offlineNames" @pick="k => \$emit\('member', k\)"><\/offline-menu-button>/)
  const html = read('ui/m.html')
  assert.match(html, /<li v-for="it in chatOffline\.items"[^>]*:role="it\.key \? 'button' : null"[^>]*@click="pickOffline\(it\)"/)
})

test('電腦：整合模式的分頁走 openChat；分離模式的對話視窗請名單視窗代開（open-chat），名單視窗再確認在名單裡', () => {
  const js = read('ui/list.js')
  assert.match(js, /function openMember\(key\) \{\n?\s*const id = memberFriendId\(key, core\.friends\)\n?\s*if \(!id\) return false\n?\s*void openChat\(id\)\n?\s*return true\n?\s*\}/)
  assert.match(js, /else if \(c\.op === 'open-chat'\) \{ if \(typeof c\.id === 'string' && core\.friends\.has\(c\.id\)\) await openChat\(c\.id\) \}/)
  assert.match(read('ui/list.html'), /:open-member="openMember"/)
  const chat = read('ui/chat.js')
  assert.match(chat, /const id = memberFriendId\(key, snap\.value\?\.friends \?\? \[\]\)/)
  assert.match(chat, /emit\('asn:cmd', \{ op: 'open-chat', id \}\)/)
  assert.match(read('ui/chat.html'), /<chat-pane :open-member="openMember"/)
})

test('手機：跳之前在群組那一筆記錄記 jumpFrom／jumpTo、記憶體記 memberJump；返回時三個條件都成立才換回群組，標記用一次就拿掉；名單開著先退掉名單那一筆', () => {
  const js = read('ui/m.js')
  assert.match(js, /history\.replaceState\(\{ \.\.\.\(history\.state \?\? \{\}\), jumpFrom: from, jumpTo: id \}, ''\)\n?\s*memberJump = \{ from, to: id \}/)
  // 換到 from／to 以外的人，記憶體裡的這一次就作廢（審查 #1516：之後的返回鍵不能把人拉回群組）
  assert.match(js, /watch\(lastChat, v => \{ if \(memberJump && v !== memberJump\.from && v !== memberJump\.to\) memberJump = null \}\)/)
  assert.match(js, /const back = !fourthNav\.busy\(\) && memberJump && memberJump\.from === j\.jumpFrom && memberJump\.to === j\.jumpTo && lastChat\.value === memberJump\.to/, '程式自己退記錄（busy）不算；要跟記憶體那一次一致')
  const pop = js.slice(js.indexOf('const j = e.state'), js.indexOf('fourthNav.onPop(e.state)'))
  assert.ok(pop.indexOf("history.replaceState(rest, '')") < pop.indexOf('if (back)'), '標記不管有沒有用到都拿掉')
  assert.match(pop, /if \(back\) \{ memberJump = null; lastChat\.value = jumpFrom \}/)
  assert.match(js, /if \(offlineClosing \|\| fourthNav\.busy\(\)\) return true[^\n]*\n\s*afterOffline = jump; closeOffline\(\)/, '名單收不起來時不留著等')
  assert.match(read('ui/m.html'), /@click="pickOffline\(it\)" @keydown\.enter\.prevent="pickOffline\(it\)" @keydown\.space\.prevent="pickOffline\(it\)"/)
  assert.match(js, /if \(openMember\(it\.key\) === false\) \{ closeOffline\(\); roomNote\.value = MEMBER_NOT_FRIEND \}/)
  assert.match(read('ui/m.html'), /:open-member="openMember" :skin="prefs\.skin"/)
})

test('樣式：可點的名字、頭像只多游標與焦點框（靜止時畫面不變）', () => {
  const css = read('ui/style.css')
  assert.match(css, /\.can-jump\{cursor:pointer\}/)
  assert.doesNotMatch(css.slice(css.indexOf('#1515')), /\.can-jump\{[^}]*(color|background|text-decoration|font)/)
})
