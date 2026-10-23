// Frutiger Aero 背景守門：兩張圖存在且夠小；CSS 有引用；圖往下漸變成白色。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8')
const FADE = 'linear-gradient(to bottom,rgba(255,255,255,0) 0,#fff '

test('背景圖：bg-app.webp、bg-chat.webp 存在、是 webp、各在 300 KB 內', () => {
  for (const f of ['bg-app.webp', 'bg-chat.webp']) {
    const b = fs.readFileSync(path.join(root, 'ui', 'img', f))
    assert.equal(b.subarray(0, 4).toString(), 'RIFF', f)
    assert.equal(b.subarray(8, 12).toString(), 'WEBP', f)
    assert.ok(b.length < 300 * 1024, `${f} 太大：${b.length}`)
  }
})

test('電腦版：視窗用 bg-app、對話區用 bg-chat，都疊「往下淡成白」的漸層並以白色為底', () => {
  const css = read('ui', 'style.css')
  assert.match(css, /\.win\{background:linear-gradient\(to bottom,rgba\(255,255,255,0\) 0,#fff \d+%\),url\(img\/bg-app\.webp\) top center\/[^;]*no-repeat,#fff\}/)
  assert.match(css, /\.chatpane-main\{background:linear-gradient\(to bottom,rgba\(255,255,255,0\) 0,#fff \d+%\),url\(img\/bg-chat\.webp\) left top\/[^;]*no-repeat,#fff\}/)
  assert.ok(css.includes(FADE))
  assert.match(css, /\.pane\{background:rgba\(255,255,255,\.\d+\)\}/, '名單面板要半透明白底保持可讀')
  assert.match(css, /\.conv-main,\.compose-main\{background:rgba\(255,255,255,\.\d+\)\}/)
})

test('手機版：整個 App 用 bg-app、對話分頁用 bg-chat，同樣往下淡成白', () => {
  const css = read('ui', 'mobile.css')
  assert.match(css, /html,body\.m-body\{background:linear-gradient\(to bottom,rgba\(255,255,255,0\) 0,#fff \d+%\),url\(img\/bg-app\.webp\) top center\/[^;]*no-repeat,#fff\}/)
  assert.match(css, /\.m-chat\{background:linear-gradient\(to bottom,rgba\(255,255,255,0\) 0,#fff \d+%\),url\(img\/bg-chat\.webp\) left top\/[^;]*no-repeat,#fff\}/)
  assert.match(css, /\.m-scroll\{background:rgba\(255,255,255,\.\d+\)\}/)
})
