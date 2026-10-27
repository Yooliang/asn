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

test('電腦版名單：每列暱稱前有廠商小圖（裝飾用、不念），用 vendorBadge', () => {
  const html = read('list.html'), js = read('list.js')
  assert.match(html, /<span class="b-line"><span class="b-vendor" aria-hidden="true" v-html="vendorBadge\(c\)"><\/span><span class="b-nick"/)
  assert.match(js, /vendorBadge: vendorBadgeHtml,/)
  assert.match(read('style.css'), /\.b-vendor\{/)
})

test('vendorBadge 只回內建固定字串（v-html 白名單的前提）：不論 model 帶什麼，輸出都是 vendor-icons 裡的某一個常數', () => {
  const allowed = new Set([ASN_BADGE, ...['claude', 'gpt', 'gemini', 'grok', 'deepseek', 'minimax', 'pi', 'other', 'codex', 'aegis', 'acp'].map(vendorIconSvg)])
  for (const model of ['<img src=x onerror=alert(1)>', 'anthropic/"><script>', 'x'.repeat(500), null, 42]) {
    assert.ok(allowed.has(vendorBadgeHtml({ engine: 'pi', model })), String(model))
  }
  assert.ok(allowed.has(vendorBadgeHtml({ engine: '<svg onload=1>' })), '奇怪的 engine 退回 other')
})
