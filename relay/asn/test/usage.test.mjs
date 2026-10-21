import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { authClass, authLabel, showInstall, showLogin } from '../ui/lib/usage.mjs'

test('用量 UI（暫停）：僅安裝／登入，無啟動、無額度列', () => {
  const base = { install_available: true, login_available: true, binary_found: false }
  assert.equal(showInstall(base), true)
  assert.equal(showLogin({ ...base, binary_found: false }), false)
  assert.equal(showLogin({ ...base, binary_found: true }), true)
  assert.equal(showInstall({ ...base, binary_found: true }), false)
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.ok(!html.includes('runLaunch') && !html.includes('>啟動<'))
  assert.ok(html.includes('usage-paused'))
  assert.ok(html.includes('runInstall') && html.includes('runLogin'))
})

test('authLabel 依 binary_found', () => {
  assert.equal(authLabel({ binary_found: false }), '未安裝')
  assert.equal(authLabel({ binary_found: true }), '已安裝')
  assert.equal(authClass({ binary_found: true }), 'st-online')
})
