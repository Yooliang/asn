// 別台要在這台打字的確認框：逾時／前一個框還開著時，桌面畫面用既有提示窗告訴本人（只放純文字）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('list.js 聽逾時與框還開著的事件，用 showLaunchNotice 顯示', () => {
  const src = read('ui/list.js')
  const expired = src.match(/await listen\('input-consent-expired', [^\n]*/)?.[0]
  const busy = src.match(/await listen\('input-consent-busy', [^\n]*/)?.[0]
  assert.ok(expired, '要聽 input-consent-expired')
  assert.ok(busy, '要聽 input-consent-busy')
  assert.match(expired, /showLaunchNotice\(/)
  assert.match(busy, /showLaunchNotice\(/)
  assert.ok(expired.includes('這次請求已逾時或已取消，沒有允許'))
  assert.ok(busy.includes('前一個打字確認框還開著'))
})

test('事件名和 Rust 端一致，提示窗只用文字節點顯示', () => {
  const rs = read('src-tauri/src/input_consent.rs')
  assert.ok(rs.includes('pub const EV_EXPIRED: &str = "input-consent-expired";'))
  assert.ok(rs.includes('pub const EV_BUSY: &str = "input-consent-busy";'))
  const html = read('ui/list.html')
  assert.ok(html.includes('{{ launchNotice.body }}'))
  assert.ok(!/v-html=["'][^"']*launchNotice/.test(html), '提示窗不能用 v-html')
})
