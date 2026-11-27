import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

test('版本號：package.json、tauri.conf.json、Cargo.toml 三處一致', () => {
  const pkg = JSON.parse(read('package.json')).version
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')).version
  const cargo = /^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))[1]
  assert.equal(conf, pkg)
  assert.equal(cargo, pkg)
})

test('版本號：標題列與設定頁都有顯示', () => {
  const html = read('ui/list.html')
  assert.match(html, /class="brand">[^<]*<span class="ver">\(\{\{ version \}\}\)<\/span>/)
  // 設定聊天窗的「關於」：settings-panel 把 st.version 傳給共用元件 AsnAboutPanel，元件兩種版面都把它畫成「版本 …」（#1763 C1）
  assert.match(read('ui/lib/settings-panel.mjs'), /<asn-about-panel [^>]*:version="st\.version"/)
  assert.equal((read('ui/parts/about-panel.mjs').match(/版本 \{\{ version \}\}/g) ?? []).length, 2, '元件的電腦、手機版面各畫一次版本號')
  assert.match(read('ui/list.js'), /version: info\.version/)
  assert.match(read('src-tauri/src/lib.rs'), /version: env!\("CARGO_PKG_VERSION"\)/)
})
