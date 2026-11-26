// #2355 P3：本機型號清單讀取器（pending 自動再問、重新讀取）與電腦版接線。
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PENDING_INTERVAL_MS, PENDING_RETRIES, createModelLoader } from '../ui/lib/local-models.mjs'
import { acpListVendor } from '../ui/lib/partner-ops-ui.mjs'
import { NONE_TEXT_LOCAL, PENDING_TEXT } from '../ui/lib/remote-models.mjs'

const logs = []
mock.method(console, 'info', (...a) => { logs.push(a.join(' ')) })
afterEach(() => { logs.length = 0 })

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const entry = (status, extra = {}) => ({ models: [{ vendor: 'gemini', status, models: [{ id: 'gemini-a', name: 'A' }, { id: 'gemini-b', name: 'B' }], ...extra }] })

// 假計時器：不真的等
function rig(answers) {
  const timers = []
  const calls = []
  const seen = []
  const loader = createModelLoader({
    fetch: async a => { calls.push(a); const x = answers.shift(); if (x instanceof Error) throw x; return x },
    onChange: (v, view) => seen.push({ v, ...view }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
  })
  return { loader, timers, calls, seen, last: () => seen[seen.length - 1] }
}
const flush = () => new Promise(r => setImmediate(r))

test('第一次問就有清單 → ready，沒有說明、不能重試', async () => {
  const r = rig([entry('ok')])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'ready'); assert.deepEqual(r.last().models.map(m => m.id), ['gemini-a', 'gemini-b'])
  assert.equal(r.last().note, ''); assert.equal(r.last().loading, false)
  assert.deepEqual(r.calls, [{ vendor: 'gemini', force: false }])
})

test('pending → 隔 5 秒自動再問 → ready', async () => {
  const r = rig([entry('pending'), entry('ok')])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'pending'); assert.equal(r.last().note, PENDING_TEXT)
  assert.equal(r.timers.length, 1); assert.equal(r.timers[0].ms, PENDING_INTERVAL_MS)
  r.timers[0].fn(); await flush()
  assert.equal(r.last().state, 'ready'); assert.equal(r.calls.length, 2)
})

test('一直 pending：最多再問 3 次（約 15 秒），之後當成讀不到並可重新讀取', async () => {
  const r = rig(Array.from({ length: 10 }, () => entry('pending')))
  await r.loader.load('gemini')
  for (let i = 0; i < PENDING_RETRIES; i++) { assert.equal(r.last().state, 'pending', `第 ${i} 次`); r.timers.at(-1).fn(); await flush() }
  assert.equal(r.calls.length, PENDING_RETRIES + 1)
  assert.equal(r.last().state, 'unavailable'); assert.equal(r.last().canRetry, true)
  assert.match(r.last().note, /^讀不到型號清單：讀取逾時/); assert.equal(r.timers.length, PENDING_RETRIES, '不再排下一次')
  assert.ok(logs.some(l => l.includes('當成讀不到')), '原因進 console')
})

test('讀不到：白話原因上畫面，代碼只進 console；沒有清單', async () => {
  const r = rig([entry('unavailable', { code: 'not_logged_in', models: [] })])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'unavailable'); assert.deepEqual(r.last().models, [])
  assert.equal(r.last().note, '讀不到型號清單：Gemini 還沒登入（登入後再試）')
  assert.ok(!r.last().note.includes('not_logged_in')); assert.ok(logs.some(l => l.includes('not_logged_in')))
})

test('命令拋錯 → 讀不到，原文進 console，畫面不放錯誤原文', async () => {
  const r = rig([new Error('invoke boom 503')])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'unavailable'); assert.ok(!r.last().note.includes('503')); assert.ok(logs.some(l => l.includes('503')))
})

test('Android 沒有本機探測（models: null）→ none，說「這台電腦讀不到型號清單」', async () => {
  const r = rig([{ models: null }])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'none'); assert.equal(r.last().note, NONE_TEXT_LOCAL)
  assert.equal(NONE_TEXT_LOCAL, '這台電腦讀不到型號清單', '本機畫面跟本機 ASN 同一版，不寫「請先更新」')
})

test('stale：列清單並說明是幾分鐘前的，可重新讀取', async () => {
  const r = rig([entry('ok', { stale: true, age_s: 600, code: 'timeout' })])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'stale'); assert.equal(r.last().models.length, 2)
  assert.equal(r.last().note, '清單是 10 分鐘前讀到的，剛才重新讀取失敗'); assert.equal(r.last().canRetry, true)
})

test('重新讀取：帶 force，等的時候舊清單還在、按鈕停用，回來才換', async () => {
  const r = rig([entry('ok'), entry('unavailable', { code: 'timeout', models: [] })])
  await r.loader.load('gemini')
  const p = r.loader.load('gemini', { force: true })
  assert.equal(r.last().loading, true); assert.equal(r.last().models.length, 2, '舊清單先留著'); assert.equal(r.last().canRetry, false)
  await p
  assert.deepEqual(r.calls[1], { vendor: 'gemini', force: true })
  assert.equal(r.last().state, 'unavailable', '使用者明確按了重新讀取，結果照實換')
})

test('窄規則：帶 / 的型號不列（切換模型後端會拒絕），筆數進 console', async () => {
  const r = rig([{ models: [{ vendor: 'gemini', status: 'ok', models: [{ id: 'gemini-a', name: 'A' }, { id: 'vendor/x', name: 'X' }] }] }])
  await r.loader.load('gemini')
  assert.deepEqual(r.last().models.map(m => m.id), ['gemini-a'])
  assert.ok(logs.some(l => l.includes('1 筆因切換模型的格式限制')))
})

test('reset：晚到的回應不採用、等待中的再問不再發', async () => {
  const r = rig([entry('pending'), entry('ok')])
  await r.loader.load('gemini')
  r.loader.reset()
  const n = r.seen.length
  await r.loader.load('gemini'); // 新一輪
  assert.equal(r.loader.view('gemini').state, 'ready'); assert.ok(r.seen.length > n)
  // 舊一輪的計時器就算被觸發，也不會畫出舊結果
  const r2 = rig([entry('ok')])
  const p = r2.loader.load('gemini'); r2.loader.reset(); await p
  assert.equal(r2.loader.view('gemini'), null, 'reset 後不採用晚到的回應')
})

test('ensure：讀過就不再讀（切回第 2 頁不重問）', async () => {
  const r = rig([entry('ok'), entry('ok')])
  r.loader.ensure('gemini'); await flush(); r.loader.ensure('gemini'); await flush()
  assert.equal(r.calls.length, 1)
})

test('acpListVendor：只有這台的 Gemini 內建通道向本機讀；Grok、別台、手機（沒命令）都是輸入框', () => {
  const g = { node: 'H', engine: 'gemini', agent: 'x' }
  assert.equal(acpListVendor(g, { selfNode: 'H' }), 'gemini')
  assert.equal(acpListVendor(g, { selfNode: 'W' }), '', '別台')
  assert.equal(acpListVendor(g, { selfNode: '' }), '')
  assert.equal(acpListVendor(g, { selfNode: 'H', canRead: false }), '', '手機沒有本機命令')
  assert.equal(acpListVendor({ ...g, engine: 'grok' }, { selfNode: 'H' }), '', 'Grok 維持輸入框（D6）')
  assert.equal(acpListVendor({ node: 'H', engine: 'claude' }, { selfNode: 'H' }), '')
})

test('接線：第 2 頁用本機清單，切換模型的對話框也讀 agent_models；寫死的清單已拿掉', () => {
  const list = read('ui/list.js'), html = read('ui/list.html'), cat = read('ui/lib/model-catalog.mjs')
  assert.match(list, /createModelLoader\(\{ fetch: a => transport\.agentModels\(a\)/)
  assert.match(list, /modelLoader\.load\(c\.vendor, \{ force: true \}\)/, '重新讀取帶 force')
  assert.match(html, /@click="reloadLaunchModels"/)
  assert.match(read('ui/lib/partner-ops-ui.mjs'), /fetch: a => props\.api\.agentModels\(a\)/)
  assert.doesNotMatch(cat, /GEMINI_MODELS|CLAUDE_MODELS/)
  assert.doesNotMatch(cat, /function launchModelChoices\([^)]*local/, 'launchModelChoices 不再有 local 條件')
})
