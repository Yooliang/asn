// 守門：畫面程式沒掛上時，不露出 {{ }} 原文，也不無聲空白（30家用 11-05 測試版少打包 vue，整頁露出原文）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const read = name => fs.readFileSync(path.join(ui, name), 'utf8')
const css = read('style.css')
// 小提醒視窗（toast）一下就關，不放
const PAGES = ['list', 'chat', 'login', 'onboard', 'panel', 'm', 'askpass', 'setup-progress']

test('.win 的 display:flex 會蓋掉 [v-cloak]，要明確壓過', () => {
  assert.match(css, /\.win\[v-cloak\]\{display:none!important\}/)
})

test('提示預設不顯示；只有 #app 還帶 v-cloak 才顯示，而且先等一段時間，平常開啟不會閃', () => {
  assert.match(css, /^\.boot-fail\{display:none\}/m)
  const rule = css.match(/#app\[v-cloak\]~\.boot-fail\{([^}]*)\}/)
  assert.ok(rule, '要靠 v-cloak 決定：Vue 沒載入、程式出錯都不會拿掉它，所以不依賴任何程式')
  assert.match(rule[1], /display:flex/)
  assert.match(rule[1], /animation:boot-fail-show 0s linear 15s both/)
  assert.match(css, /@keyframes boot-fail-show\{from\{visibility:hidden\}to\{visibility:visible\}\}/)
})

for (const page of PAGES) {
  test(`${page}.html：提示和 #app 同一層、排在後面，而且不需要程式就有字`, () => {
    const html = read(`${page}.html`).replace(/\r\n/g, '\n')
    const hint = '<div class="boot-fail" role="alert">畫面載入失敗，請重開 ASN</div>\n</body>'
    assert.ok(html.includes(hint), '直接放在 </body> 前，是 body 的子元素')
    assert.ok(html.indexOf(hint) > html.indexOf('<div id="app"'), '要在 #app 之後，~ 選擇器才選得到')
    assert.match(html, /<link rel="stylesheet" href="style\.css">/)
  })
}
