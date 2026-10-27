// 名單每列的廠商小圖（#308 第 2 塊）：手機與電腦版共用 vendorBadgeHtml；pi 照背後的模型廠商。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ASN_BADGE, vendorBadgeHtml, vendorIconSvg } from '../ui/lib/vendor-icons.mjs'
import * as mobile from '../ui/lib/mobile.mjs'

const read = f => readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')

test('共用：pi 照 model 換成背後廠商的圖，對不到用 pi 的圖；其他引擎照 engine；ASN 視窗用 logo', () => {
  assert.equal(vendorBadgeHtml({ engine: 'pi', model: 'anthropic/claude-sonnet-4' }), vendorIconSvg('claude'))
  assert.equal(vendorBadgeHtml({ engine: 'pi', model: 'openrouter/deepseek/deepseek-chat' }), vendorIconSvg('deepseek'))
  assert.equal(vendorBadgeHtml({ engine: 'pi', model: 'weird/unknown-1' }), vendorIconSvg('pi'))
  assert.equal(vendorBadgeHtml({ engine: 'pi' }), vendorIconSvg('pi'))
  assert.equal(vendorBadgeHtml({ engine: 'grok' }), vendorIconSvg('grok'))
  assert.equal(vendorBadgeHtml({ engine: 'asn' }), ASN_BADGE)
  assert.equal(vendorBadgeHtml({}), vendorIconSvg('other'))
  assert.equal(mobile.vendorBadgeHtml, vendorBadgeHtml, '手機沿用同一支')
})

test('電腦版名單與對話視窗：廠商小圖疊在頭像右下角，跟手機一樣（#336，裝飾用、不念），統一用 <asn-avatar>', () => {
  const html = read('list.html'), pane = read('lib/chatpane.mjs'), css = read('style.css'), comp = read('lib/avatar-badge.mjs')
  assert.match(html, /<asn-avatar :src="avOf\(c\)" :friend="c"/, '名單每列')
  assert.ok(!html.includes('class="b-vendor"'), '名字前不再放一顆')
  assert.match(html, /<asn-avatar glyph=">_" :friend="r"/, '終端列')
  assert.match(html, /<asn-avatar class="pin-av" :src="avOf\(t\)" :friend="!t\.panel &amp;&amp; !t\.room \? t : null"/, '釘選分頁（面板、群組不放小圖）')
  for (const s of ['<asn-avatar class="to-av"', '<asn-avatar size="xl" :src="friendAv"', '<asn-avatar :src="friendAv"']) assert.ok(pane.includes(s), `對話視窗缺 ${s}`)   // 上方、側欄大頭、訊息旁
  assert.match(comp, /<span class="avb-v" aria-hidden="true" v-if="badge" v-html="badge">/, '小圖裝飾用、不念')
  assert.match(css, /\.avb-v\{position:absolute;right:-5px;bottom:-5px/, '跟手機一樣疊在頭像右下角（小良哥 10/27 傍晚）')

  assert.match(css, /\.avb\.off \.avb-v\{opacity:\.6;filter:grayscale\(1\)\}/, '離線整顆灰階')
})

test('vendorBadge 只回內建固定字串（v-html 白名單的前提）：不論 model 帶什麼，輸出都是 vendor-icons 裡的某一個常數', () => {
  const allowed = new Set([ASN_BADGE, ...['claude', 'gpt', 'gemini', 'grok', 'deepseek', 'minimax', 'pi', 'other', 'codex', 'aegis', 'acp'].map(vendorIconSvg)])
  for (const model of ['<img src=x onerror=alert(1)>', 'anthropic/"><script>', 'x'.repeat(500), null, 42]) {
    assert.ok(allowed.has(vendorBadgeHtml({ engine: 'pi', model })), String(model))
  }
  assert.ok(allowed.has(vendorBadgeHtml({ engine: '<svg onload=1>' })), '奇怪的 engine 退回 other')
})

test('v-html 白名單的前提（#336）：頭像小圖只會是內建常數，或內建常數把 id 加上只含英數的尾碼', async () => {
  const { withUniqueIds } = await import('../ui/lib/vendor-icons.mjs')
  const g = vendorIconSvg('gemini')
  assert.equal(withUniqueIds(g, '"><script>x'), withUniqueIds(g, 'scriptx'), '尾碼裡的非英數字元一律丟掉')
  assert.equal(withUniqueIds(g, ''), g, '沒有尾碼就原樣')
})
