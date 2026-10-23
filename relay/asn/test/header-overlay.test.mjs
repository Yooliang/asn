// 對話頁頭部疊色與看圖檢視層的守門。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8')

test('對話頁頭部：與對話區共用同一張背景，正常疊白色半透明、忙碌疊黃色半透明（不再是不透明黃底）', () => {
  const m = read('ui', 'mobile.css')
  assert.match(m, /\.m-chathead\{background:rgba\(255,255,255,\.\d+\)/)
  assert.match(m, /\.m-chathead\.is-busy\{background:rgba\(255,213,74,\.\d+\)/)
  assert.ok(!/\.m-chathead[^{]*\{[^}]*background:#ffd54a/.test(m), '忙碌不可再用不透明黃')
  assert.match(m, /\.m-chat\{background:linear-gradient/, '頭部在 .m-chat 之內，共用同一張圖')
  const s = read('ui', 'style.css')
  assert.match(s, /\.conv-main \.to-line\{background:rgba\(255,255,255,\.\d+\)/)
  assert.match(s, /\.conv-main \.warn\{background:rgba\(255,213,74,\.\d+\)/)
})

test('看圖檢視層：搬到 body、固定蓋滿視窗、層級高過頭部，手機與電腦版共用', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.match(pane, /<teleport to="body" v-if="viewer">\s*<div class="photo-viewer"/)
  const css = read('ui', 'style.css')
  const z = /\.photo-viewer\{position:fixed;inset:0;z-index:(\d+);/.exec(css)
  assert.ok(z && Number(z[1]) >= 1000)
  assert.match(read('ui', 'mobile.css'), /\.m-body \.photo-viewer \.aero-btn/)
})
