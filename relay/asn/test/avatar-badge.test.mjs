// 統一頭像 <asn-avatar>（#336 第二期）：一個元件、一套 .avb 樣式；廠商小圖固定右下角；漸層 id 每個頭像各自一份
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { AsnAvatar, avatarBadgeHtml } from '../ui/lib/avatar-badge.mjs'
import { vendorIconSvg, withUniqueIds } from '../ui/lib/vendor-icons.mjs'

const render = props => renderToString(Vue.createSSRApp({ components: { AsnAvatar }, data: () => ({ p: props }), template: '<asn-avatar v-bind="p"></asn-avatar>' }))
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('AI 夥伴：外框照狀態、右下角有廠商小圖；離線整顆灰階；尺寸只認 xs／sm／xl', async () => {
  const on = await render({ src: 'a.png', friend: { engine: 'claude', status: 'online' }, status: 'online', size: 'sm' })
  const cls = (h, i) => [...h.matchAll(/class="([^"]+)"/g)][i][1].split(' ').sort().join(' ')
  assert.equal(cls(on, 0), 'avb sm')
  assert.equal(cls(on, 1), 'dp sm st-online')
  assert.match(on, /<img src="a\.png" alt=""><\/span><\/span><span class="avb-v" aria-hidden="true"><svg/, '小圖在頭像後面（右下角由 .avb-v 定位）')
  const off = await render({ src: 'a.png', friend: { engine: 'claude' }, status: 'offline' })
  assert.equal(cls(off, 0), 'avb off xs')
  assert.equal(cls(off, 1), 'dp st-offline xs')
  assert.match(await render({ src: 'a.png', size: 'huge' }), /class="avb xs"/, '不認得的尺寸退回 xs')
})

test('沒有夥伴也沒有廠商（真人、群組、面板）就不放小方塊；off 可以單獨指定', async () => {
  const human = await render({ src: 'me.png', status: 'online' })
  assert.ok(!human.includes('avb-v'))
  const archived = await render({ src: 'a.png', friend: { engine: 'grok' }, status: 'offline', off: false })
  assert.match(archived, /class="avb xs"/, '已封存：外框灰但不整顆淡化')
  assert.match(archived, /st-offline/)
})

test('群組發言者只知道廠商鍵；終端沒有圖時放字', async () => {
  assert.equal(avatarBadgeHtml({ vendor: 'grok' }), vendorIconSvg('grok'))
  assert.equal(avatarBadgeHtml({}), '')
  const term = await render({ glyph: '>_', friend: { engine: 'grok' }, status: 'online', off: false })
  assert.match(term, /<span class="term-glyph" aria-hidden="true">&gt;_<\/span>/)
})

test('漸層 id：每個頭像各自一份，同頁兩個 Gemini 不會共用；agy 用 Gemini 的圖', async () => {
  const a = await render({ src: 'a.png', friend: { engine: 'gemini' } })
  const b = await render({ src: 'b.png', friend: { engine: 'gemini' } })
  const ids = h => [...h.matchAll(/ id="([^"]+)"/g)].map(m => m[1])
  assert.ok(ids(a).length > 0)
  assert.equal(ids(a).filter(x => ids(b).includes(x)).length, 0, '兩份 id 不重複')
  for (const h of [a, b]) for (const [, ref] of h.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids(h).includes(ref), `url(#${ref}) 要指到同一份圖裡的 id`)
  assert.equal(vendorIconSvg('agy'), vendorIconSvg('gemini'))
  assert.equal(withUniqueIds(vendorIconSvg('claude'), 'x'), vendorIconSvg('claude'), '沒有 id 的圖原樣回傳')
})

test('守門：AI 頭像只能用 <asn-avatar>，不准再手寫 .avb／.m-vendor／.spk-vendor 加 v-html 小圖', () => {
  const tpl = { 'ui/list.html': read('ui/list.html'), 'ui/m.html': read('ui/m.html'), 'ui/lib/chatpane.mjs': read('ui/lib/chatpane.mjs') }
  for (const [f, t] of Object.entries(tpl)) {
    for (const bad of ['class="avb', 'class="avb-v', 'm-vendor', 'spk-vendor', 'v-html="vendorBadge(', 'v-html="spkVendor(']) assert.ok(!t.includes(bad), `${f} 還有 ${bad}`)
  }
  assert.ok(tpl['ui/list.html'].includes('<asn-avatar') && tpl['ui/m.html'].includes('<asn-avatar') && tpl['ui/lib/chatpane.mjs'].includes('<asn-avatar'))
  for (const css of ['ui/mobile.css', 'ui/group.css']) assert.ok(!/\.(m-vendor|spk-vendor)\b/.test(read(css)), `${css} 還留著舊的小圖樣式`)
  assert.match(read('ui/list.js'), /app\.component\('asn-avatar', AsnAvatar\)/)
  assert.match(read('ui/m.js'), /app\.component\('asn-avatar', AsnAvatar\)/)
})
