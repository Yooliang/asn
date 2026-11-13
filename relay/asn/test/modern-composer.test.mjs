// 現代外觀的輸入框膠囊（#1421 B2）：電腦與手機共用 ChatPane，新節點在復古 Aero 下一律不顯示，
// 排版全在 modern.css（:root[data-skin="modern"] 底下）；鍵盤與送出的 handler 沒被換掉、送出鈕的名字綁 sendLabel。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const pane = read('ui/lib/chatpane.mjs'), style = read('ui/style.css'), modern = read('ui/modern.css')
const form = pane.slice(pane.indexOf('<form class="composer"'), pane.indexOf('</form>', pane.indexOf('<form class="composer"')))

test('復古 Aero：新的「＋」與語音輸入鈕在 style.css 預設就是 display:none（modern.css 才讓它們出現）', () => {
  assert.match(style, /\.mc-plus,\.mc-dict\{display:none\}/)
  assert.ok(!/\.mc-/.test(read('ui/mobile.css')), 'mobile.css 不碰新節點')
  assert.match(modern, /:root\[data-skin="modern"\] \.compose-main \.mc-plus,:root\[data-skin="modern"\] \.compose-main \.mc-dict\{display:grid;/)
})

test('modern.css：膠囊（單列 52／手機 50、26／25px 圓角、#e6e4df 細邊、指定陰影）、上方工具列收起、「＋」展開', () => {
  const at = '/* ---------- #1421 B2：輸入框膠囊'
  assert.ok(modern.includes(at), '檔尾要有 B2 區塊')
  const blk = modern.slice(modern.indexOf(at))
  const main = blk.match(/\.compose-main\{[^}]*\}/)[0]
  for (const part of ['min-height:52px', 'max-width:760px', 'border:1px solid #e6e4df', 'border-radius:26px', 'box-shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px rgba(0,0,0,.06)']) assert.ok(main.includes(part), '膠囊要有 ' + part)
  assert.match(blk, /\.compose-row\{padding:10px 32px 18px\}/)
  assert.match(blk, /\.m-chat \.compose-row\{padding:8px 12px 10px/)
  assert.match(blk, /\.m-chat \.compose-main\{min-height:50px;[^}]*border-radius:25px/)
  assert.match(blk, /\.compose-main \.composer\{display:contents\}/)
  assert.match(blk, /\.compose-main > \.toolbar\{display:none\}/)
  assert.match(blk, /\.compose-main > \.toolbar\.mc-open\{display:flex;/)
  assert.match(blk, /\.composer \.aero-btn\{[^}]*width:40px;height:40px[^}]*border-radius:50%[^}]*var\(--accent\)/)
  assert.ok(blk.includes('%23fff') && blk.includes('M12 19V5M6 11l6-6 6 6'), '白色向上箭頭')
})

test('樣板：送出鈕的 aria-label 綁 sendLabel、字照舊；Enter／Shift+Enter／@ 選單的 handler 原樣；舊工具鈕與 handler 都還在', () => {
  assert.match(form, /<button class="aero-btn" type="submit" :aria-label="sendLabel" :disabled="displayOnly \|\| !draft\.trim\(\)">\{\{ sendLabel \}\}<\/button>/)
  assert.match(form, /<form class="composer" @submit\.prevent="send">/)
  assert.match(form, /@keydown="onComposeKey" @keydown\.enter\.exact="onEnter"/, 'Enter 送出、Shift+Enter 沒綁（照預設換行）')
  assert.match(pane, /function onEnter\(ev\) \{\n\s+if \(mention\.value\) \{ ev\.preventDefault\(\); pickMention\(\); return \}\n\s+if \(!props\.enterSends\) return\n\s+ev\.preventDefault\(\)\n\s+send\(\)/)
  assert.match(pane, /const sendLabel = computed\(\(\) => \(termCompose\.value \? SEND_LABEL_TERM : SEND_LABEL\)\)/, '看終端時的「送出」那條路沒動')
  for (const h of ['@click="startCall"', '@click="dictClick"', '@click="micClick"', '@click="nudge"', '@click="fileEl && fileEl.click()"', '@click="docEl && docEl.click()"', '@click="startShot"', '@click="pickerOpen = !pickerOpen"']) assert.ok(pane.includes(h), '舊工具鈕還在：' + h)
  assert.equal((pane.match(/m-term-switch/g) || []).length, 1, '對話／終端切換鈕只有原本那一顆')
})

test('「＋」與語音輸入：新鈕沿用原本的 handler 與 disabled 條件；Tab 順序＝＋、輸入框、語音、送出', () => {
  assert.match(form, /<button class="mc-plus" type="button" @click="plusOpen = !plusOpen"[^>]*:aria-expanded="plusOpen" aria-label="附件與更多"/)
  assert.match(form, /class="mc-dict"[^>]*v-if="showDictBtn" @click="dictClick" :disabled="callActive"[^>]*aria-label="語音輸入" :title="dictTip"/)
  assert.match(form, /class="mc-dict mc-mic"[^>]*v-if="voice && !showDictBtn" @click="micClick"[^>]*:aria-label="micTip"/)
  const at = s => form.indexOf(s)
  assert.ok(at('class="mc-plus"') < at('<textarea') && at('<textarea') < at('class="mc-dict"') && at('class="mc-dict"') < at('type="submit"'))
  assert.match(pane, /<div class="toolbar" :class="\{ 'mc-open': plusOpen, 'mc-has-dict': showDictBtn \}" @click="onToolbarClick"/)
})

test('點選單外面就收起：只在選單開著時掛一個 pointerdown 監聽、先移除再掛、卸載時移除；回覆列與語音提示同時出現時往上疊', () => {
  assert.match(pane, /watch\(plusOpen, on => \{\n\s+document\.removeEventListener\('pointerdown', onOutsidePress, true\)\n\s+if \(on\) document\.addEventListener\('pointerdown', onOutsidePress, true\)/)
  assert.match(pane, /onBeforeUnmount\(\(\) => document\.removeEventListener\('pointerdown', onOutsidePress, true\)\)/)
  assert.equal((pane.match(/addEventListener\('pointerdown', onOutsidePress/g) || []).length, 1)
  assert.match(modern, /\.compose-main > \.voice-install:has\(~ \.reply-bar\)\{bottom:calc\(100% \+ 8px \+ 36px \+ 6px\)\}/)
  assert.match(modern, /\.compose-main > \.reply-bar\{box-sizing:border-box;height:36px;/)
})
