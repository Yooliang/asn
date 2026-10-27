import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QUOTA_HOOK_TEXT, normalizeQuotaHook, quotaHookView } from '../ui/lib/quota-hook.mjs'

const read = p => readFileSync(new URL(`../ui/${p}`, import.meta.url), 'utf8')

test('還沒查到狀態不顯示這一區；壞值當 blocked，不讓人去按', () => {
  assert.equal(quotaHookView(null), null)
  assert.equal(normalizeQuotaHook({ state: 'weird' }).state, 'blocked')
  const v = quotaHookView({ state: 'weird' })
  assert.equal(v.showAsk, false); assert.equal(v.showAgree, false); assert.equal(v.showDisconnect, false)
})

test('沒接：只有「接上…」；按了才出現同意與取消，同意前會顯示目前指令與要改什麼', () => {
  const off = quotaHookView({ state: 'off', current: 'echo hi', hasOriginal: false })
  assert.deepEqual([off.showAsk, off.showAgree, off.showCancel, off.showDisconnect], [true, false, false, false])
  assert.equal(off.consent, ''); assert.equal(off.current, '')
  const ask = quotaHookView({ state: 'off', current: 'echo hi' }, { confirm: true })
  assert.deepEqual([ask.showAsk, ask.showAgree, ask.showCancel], [false, true, true])
  assert.ok(ask.consent.includes('~/.claude/settings.json') && ask.consent.includes('取消接上'))
  assert.equal(ask.current, 'echo hi')
})

test('已接上：只有「取消接上」；路徑對不上顯示重新接上，也能取消', () => {
  const on = quotaHookView({ state: 'on', hasOriginal: true })
  assert.deepEqual([on.showAsk, on.showAgree, on.showDisconnect], [false, false, true])
  assert.ok(on.lines.includes(QUOTA_HOOK_TEXT.hasOriginal))
  const stale = quotaHookView({ state: 'stale' })
  assert.equal(stale.askLabel, QUOTA_HOOK_TEXT.reconnect)
  assert.deepEqual([stale.showAsk, stale.showDisconnect], [true, true])
})

test('處理中：確認框收起、按鈕仍在但畫面會停用（busy）', () => {
  const v = quotaHookView({ state: 'off' }, { busy: true, confirm: true })
  assert.equal(v.busy, true); assert.equal(v.consent, '')
})

test('接線守門：改設定檔的指令只在 quota-hook-connect／disconnect 兩個動作裡呼叫；預設不接', () => {
  const js = read('list.js'), tauri = read('lib/tauri.mjs'), panel = read('lib/settings-panel.mjs')
  assert.equal((js.match(/transport\.quotaHookConnect\(/g) ?? []).length, 1)
  assert.equal((js.match(/transport\.quotaHookDisconnect\(/g) ?? []).length, 1)
  assert.ok(js.includes("case 'quota-hook-connect': await runQuotaHook(() => transport.quotaHookConnect()"))
  assert.ok(js.includes("case 'quota-hook-ask': quotaHook.confirm = true"), '先跳確認說明，不是按了就改')
  assert.ok(!js.includes('quotaHookConnect()') || !/loadQuotaHook[\s\S]{0,200}quotaHookConnect/.test(js), '載入狀態時不會順手接上')
  assert.ok(tauri.includes("invoke('claude_quota_hook_connect')"))
  assert.equal((panel.match(/act\('quota-hook-connect'\)/g) ?? []).length, 1, '只有「同意並接上」按鈕觸發接上')
})
