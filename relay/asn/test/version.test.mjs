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
  assert.match(read('ui/lib/settings-panel.mjs'), /版本 \{\{ st\.version \}\}/)   // 設定聊天窗的「關於」
  assert.match(read('ui/list.js'), /version: info\.version/)
  assert.match(read('src-tauri/src/lib.rs'), /version: env!\("CARGO_PKG_VERSION"\)/)
})
