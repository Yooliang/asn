// #374：電腦版設定頁的 Claude 額度條（5 小時、每週），重置時間「約 N 小時後」；沒接上提醒去接上；Codex／Grok 寫沒有額度資料
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LOW_PCT, NOT_CONNECTED_TEXT, NO_QUOTA_TEXT, quotaBars, resetIn } from '../ui/lib/account-quota.mjs'

const NOW = Date.parse('2026-10-28T10:00:00Z')
const at = new Date(NOW - 10 * 60_000).toISOString()

test('有數字：兩條剩餘百分比，剩 20% 以下標警示；重置寫「約 N 小時後」', () => {
  const v = quotaBars({ five_hour_pct: 64, weekly_pct: 12, reset_at: new Date(NOW + 3 * 3600_000 + 10 * 60_000).toISOString(), at }, { hookOn: true, now: NOW })
  assert.deepEqual(v.bars, [{ key: 'five', label: '5 小時', pct: 64, low: false }, { key: 'week', label: '每週', pct: 12, low: true }])
  assert.equal(v.reset, '約 3 小時後重置')
  assert.equal(v.note, '')
  assert.equal(v.stale, false)
  assert.equal(LOW_PCT, 20)
})

test('重置時間：不到 1 小時、已過、沒有', () => {
  assert.equal(resetIn(new Date(NOW + 20 * 60_000).toISOString(), NOW), '不到 1 小時後重置')
  assert.equal(resetIn(new Date(NOW - 60_000).toISOString(), NOW), '')
  assert.equal(resetIn(undefined, NOW), '')
})

test('沒有數字：沒接上就提醒到啟動設定接上；接上了（或還沒查到）照實寫額度未知，不編數字', () => {
  assert.deepEqual(quotaBars({}, { hookOn: false, now: NOW }).bars, [])
  assert.equal(quotaBars({}, { hookOn: false, now: NOW }).note, NOT_CONNECTED_TEXT)
  assert.match(NOT_CONNECTED_TEXT, /啟動設定/)
  assert.equal(quotaBars({}, { hookOn: true, now: NOW }).note, '額度未知')
  assert.equal(quotaBars({ five_hour_pct: 200, at }, { hookOn: null, now: NOW }).note, '額度未知', '壞值不畫')
})

test('接線：設定頁自己這台的 Claude 帳號畫額度條（有 progressbar 角色與數值）；Codex／Grok 寫「沒有額度資料」', () => {
  const src = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(src, /<span class="dv-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="b\.pct"/)
  assert.match(src, /v-else-if="v\.key === 'codex' \|\| v\.key === 'grok'">\{\{ NO_QUOTA_TEXT \}\}/)
  assert.equal(NO_QUOTA_TEXT, '沒有額度資料')
  assert.match(fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8'), /\.dv-fill\.low\{/)
})
