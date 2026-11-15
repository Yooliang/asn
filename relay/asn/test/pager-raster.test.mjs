// 手機滑頁停下來後不留 will-change（#1565）：一直開著時，Chrome 會沿用轉場途中某一格的小數 x 位移畫內頁、滑完也不重畫，
// 字和直線偏半像素變糊（冒煙 m-launch-360／412 的截圖因此有兩、三種）。只在手指拖動和程式控制的轉場期間加，結束（transitionend 或逾時保險）就拿掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PAGER_SETTLE_MS } from '../ui/lib/mobile.mjs'

const rd = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('CSS：.m-pager 平常沒有 will-change，只有拖動（dragging）與轉場中（moving）才有', () => {
  const css = rd('mobile.css')
  const base = css.match(/\.m-pager\{display:flex[^}]*\}/)?.[0]
  assert.ok(base, '找到 .m-pager 的主規則')
  assert.doesNotMatch(base, /will-change/)
  assert.match(css, /\.m-pager\.dragging,\.m-pager\.moving\{will-change:transform\}/)
  assert.doesNotMatch(css.replace(/\.m-pager\.dragging,\.m-pager\.moving\{will-change:transform\}/, ''), /\.m-pager[^{]*\{[^}]*will-change/, '別的 .m-pager 規則也沒有')
})

test('逾時保險比轉場（0.28 秒）長，但不會久到停很久還開著', () => {
  const ms = Number(rd('mobile.css').match(/\.m-pager\{[^}]*transition:transform \.(\d+)s/)?.[1]) * 10
  assert.equal(ms, 280)
  assert.ok(PAGER_SETTLE_MS > ms && PAGER_SETTLE_MS <= 1000, String(PAGER_SETTLE_MS))
})

test('接線：pager 掛 moving 與 transitionend；位移一變（不是手指拖動）就標 moving、排逾時；只認 pager 自己的 transform 轉場', () => {
  const html = rd('m.html'), js = rd('m.js')
  assert.match(html, /<div class="m-pager" :class="\{ dragging: sw\.dragging, moving: sw\.moving \}" :style="pagerStyle" @transitionend="pagerMoved">/)
  assert.match(js, /watch\(\(\) => pagerStyle\.value\.transform, \(\) => \{\n\s+if \(sw\.dragging\) return\n\s+sw\.moving = true\n\s+clearTimeout\(settleTimer\)\n\s+settleTimer = setTimeout\(pagerSettled, PAGER_SETTLE_MS\)/)
  assert.match(js, /function pagerMoved\(e\) \{ if \(e\.target === e\.currentTarget && e\.propertyName === 'transform' && !sw\.dragging\) pagerSettled\(\) \}/)
  assert.match(js, /const pagerSettled = \(\) => \{ clearTimeout\(settleTimer\); settleTimer = 0; sw\.moving = false \}/)
  // 放開手指時先關 dragging 再歸零位移，吸附回去的那段轉場才會被標成 moving
  assert.match(js, /sw\.dragging = false; sw\.locked = ''\n[^\n]*\n\s+sw\.shift = 0/)
})
