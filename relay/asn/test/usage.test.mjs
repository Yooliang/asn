// 用量分頁（#52）：格式整理、元件接線、Rust 指令註冊，以及「不下載、不啟動外部程式、不碰登入檔」的守門。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fmtCost, fmtTokens, createUsageUi, usageView } from '../ui/lib/usage.mjs'

const src = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('數字格式：token 與成本', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(1234), '1,234')
  assert.equal(fmtTokens(250_000), '25.0 萬')
  assert.equal(fmtTokens(250_000_000), '2.50 億')
  assert.equal(fmtTokens(NaN), '0')
  assert.equal(fmtCost(0), '$0')
  assert.equal(fmtCost(0.004), '< $0.01')
  assert.equal(fmtCost(12.345), '$12.35')
})

test('畫面資料：沒資料夾、沒記錄、沒價目的模型各有說明；缺欄位不丟錯', () => {
  assert.equal(usageView(null), null)
  assert.match(usageView({ rootsFound: false, periods: [] }).empty, /找不到/)
  assert.match(usageView({ rootsFound: true, periods: [{ key: 'month', messages: 0 }] }).empty, /還沒有/)
  const v = usageView({ rootsFound: true, priceDate: '2026-10-22', unpricedModels: ['claude-x-9'], periods: [{ key: 'today', label: '今天', input: 1000, output: 500, cacheWrite: 0, cacheRead: 2000, messages: 3, costUsd: 0.5, models: [{ model: 'claude-x-9', priced: false, input: 1, messages: 1 }, { model: 'claude-opus-4-5', priced: true, costUsd: 0.5, input: 1, messages: 2 }] }] })
  assert.equal(v.empty, '')
  assert.equal(v.periods[0].tokens, '3,500')
  assert.equal(v.periods[0].cost, '$0.50')
  assert.equal(v.periods[0].models[0].cost, '未列價目')
  assert.match(v.unpriced, /claude-x-9/)
  assert.match(v.priceLine, /2026-10-22/)
})

test('createUsageUi：把本機時差傳給 Rust、載入中不重複呼叫、失敗顯示中文訊息', async () => {
  const calls = []
  let fail = false
  const invoke = async (cmd, args) => { calls.push([cmd, args]); if (fail) throw new Error('壞了'); return { rootsFound: true, periods: [] } }
  const ui = createUsageUi({ invoke, reactive: o => o, now: () => ({ getTimezoneOffset: () => -480, getHours: () => 9, getMinutes: () => 5 }) })
  const a = ui.refresh(); const b = ui.refresh()
  await Promise.all([a, b])
  assert.deepEqual(calls, [['usage_summary', { tzOffsetMin: -480 }]])
  assert.equal(ui.state.updated, '09:05')
  assert.equal(ui.state.loading, false)
  fail = true
  await ui.refresh()
  assert.equal(ui.state.error, '讀取用量失敗：壞了')
})

test('守門：Rust 指令有註冊、前端呼叫的指令名與參數名對得上', () => {
  assert.ok(src('src-tauri/src/lib.rs').includes('usage::usage_summary'), 'lib.rs 沒註冊 usage_summary')
  assert.ok(src('src-tauri/src/lib.rs').includes('mod usage;'))
  assert.ok(src('src-tauri/src/usage.rs').includes('pub async fn usage_summary(tz_offset_min: i32)'))
  assert.ok(src('ui/lib/usage.mjs').includes("invoke('usage_summary', { tzOffsetMin:"))
})

test('守門：用量掃描不啟動外部程式、不連網、不碰登入檔與 ASN 資料', () => {
  const rs = src('src-tauri/src/usage.rs').split('#[cfg(test)]')[0]
  for (const bad of ['Command::new', 'reqwest', 'std::process', 'NoWindow', '.credentials', '.claude.json', 'claude-accounts', 'npx', 'ccusage']) {
    assert.ok(!rs.includes(bad), `usage.rs 不該出現「${bad}」`)
  }
  assert.ok(!/Command|fetch\(|XMLHttp/.test(src('ui/lib/usage.mjs')), 'usage.mjs 不該連網或啟動程式')
})
