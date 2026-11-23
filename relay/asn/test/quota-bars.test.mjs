// #374：電腦版設定頁的 Claude 額度條（5 小時、每週），重置時間「約 N 小時後」；Codex／Grok 寫沒有額度資料（#1883 起額度條都由列表資料畫，這裡只剩共用的小工具與接線）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LOW_PCT, NO_QUOTA_TEXT, resetIn } from '../ui/lib/account-quota.mjs'

const NOW = Date.parse('2026-10-28T10:00:00Z')

test('警示線：剩 20% 以下', () => {
  assert.equal(LOW_PCT, 20)
})

test('重置時間：不到 1 小時、已過、沒有', () => {
  assert.equal(resetIn(new Date(NOW + 20 * 60_000).toISOString(), NOW), '不到 1 小時後重置')
  assert.equal(resetIn(new Date(NOW - 60_000).toISOString(), NOW), '')
  assert.equal(resetIn(undefined, NOW), '')
})

test('接線：設定頁自己這台的 Claude 帳號畫額度條（讀 a.quota）（有 progressbar 角色與數值）；Codex／Grok 寫「沒有額度資料」', () => {
  const src = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(src, /<span class="dv-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="b\.pct"/)
  // #2111 ⑦：設備頁不畫額度（含 Codex／Grok 的「沒有額度資料」），額度只在帳號頁
  assert.equal(NO_QUOTA_TEXT, '沒有額度資料')
  assert.match(fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8'), /\.dv-fill\.low\{/)
})
