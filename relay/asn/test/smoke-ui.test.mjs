// 啟動冒煙測試的純邏輯：參數、入口頁清單、假 Tauri 回應表、瀏覽器尋找、發版關卡。（真正載頁面的部分由 npm run smoke:ui 跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { EXCLUDED_PAGES, MASK_PROBES, PARTNER_ME, SCENARIOS, browserCandidates, fakeTable, findBrowser, injectSource, maskProbeSource, mountCheckSource, parseSmokeArgs, pathOf, selectScenarios, tableFor } from '../scripts/smoke-lib.mjs'
import { SKIP_WARNING, smokeGate, splitSkipFlag } from '../scripts/smoke-gate.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

test('參數：預設值、--only、--timeout、--browser，不認得的就報錯', () => {
  assert.deepEqual(parseSmokeArgs([]), { only: [], timeoutMs: 15000, browser: '', verbose: false })
  assert.deepEqual(parseSmokeArgs(['--only', 'list,chat', '--only=login', '--timeout=3000', '--browser', 'X:/b.exe', '--verbose']), { only: ['list', 'chat', 'login'], timeoutMs: 3000, browser: 'X:/b.exe', verbose: true })
  assert.throws(() => parseSmokeArgs(['--nope']), /不認得的參數/)
  assert.throws(() => parseSmokeArgs(['--timeout', '5']), /--timeout/)
  assert.throws(() => parseSmokeArgs(['--only']), /--only/)
})

test('入口頁清單：ui/ 下每個 html 都有情境，或明列為刻意不測（含理由）', () => {
  const pages = fs.readdirSync(path.join(root, 'ui')).filter(f => f.endsWith('.html'))
  const covered = new Set(SCENARIOS.map(s => s.page.split('?')[0]))
  for (const p of pages) assert.ok(covered.has(p) || EXCLUDED_PAGES[p], `${p} 沒有冒煙情境，也沒列在 EXCLUDED_PAGES（新增入口頁要補情境）`)
  for (const p of covered) assert.ok(pages.includes(p), `情境指向不存在的頁面：${p}`)
  for (const [p, why] of Object.entries(EXCLUDED_PAGES)) assert.ok(why.length > 4 && pages.includes(p), `${p} 的排除理由或檔案不存在`)
  // 手機未登入、已登入兩種都要有；電腦版三個主頁都要有
  const names = SCENARIOS.map(s => s.name)
  for (const n of ['m-signed-out', 'm-signed-in', 'list', 'chat', 'onboard', 'login']) assert.ok(names.includes(n), `缺情境 ${n}`)
  assert.equal(new Set(names).size, names.length, '情境名稱不可重複')
  assert.equal(SCENARIOS.find(s => s.name === 'm-signed-in').state.signedIn, true)
  assert.equal(SCENARIOS.find(s => s.name === 'm-signed-out').state.signedIn, false)
})

test('selectScenarios：--only 只挑指定的，名稱錯誤就報錯', () => {
  assert.deepEqual(selectScenarios(['list']).map(s => s.name), ['list'])
  assert.equal(selectScenarios([]).length, SCENARIOS.length)
  assert.throws(() => selectScenarios(['zzz']), /沒有這些情境：zzz/)
})

test('假回應表：能 JSON 序列化；登入狀態跟著情境；常用指令都有', () => {
  const t = fakeTable({ signedIn: true })
  assert.deepEqual(JSON.parse(JSON.stringify(t)), t)
  assert.equal(t.auth_status.signed_in, true)
  assert.equal(fakeTable({ signedIn: false, needsLogin: true }).startup_info.needs_login, true)
  assert.equal(fakeTable({ signedIn: false }).auth_status.signed_in, false)
  for (const c of ['startup_info', 'auth_status', 'store_load', 'relay_list', 'relay_inbox', 'relay_rooms']) assert.ok(c in t, `缺 ${c}`)
  assert.ok(Array.isArray(t.local_windows) && Array.isArray(t.claude_accounts_list), '這兩個真機回陣列')
  // 故意不放的指令：模擬真機沒註冊
  for (const c of ['android_update_check', 'ai_cli_detect']) assert.ok(!(c in t))
})

test('注入的假 Tauri：有回應的指令回資料、store_load 依名稱、未知指令被拒絕並記錄', async () => {
  const ctx = vm.createContext({ globalThis: null })
  ctx.globalThis = ctx
  vm.runInContext(injectSource(tableFor(SCENARIOS.find(s => s.name === 'list'))), ctx)
  const inv = ctx.__TAURI__.core.invoke
  assert.equal((await inv('auth_status')).signed_in, true)
  assert.equal(await inv('store_load', { name: 'onboard' }), JSON.stringify({ done: true }))
  assert.equal(await inv('store_load', { name: '沒有的' }), null)
  await assert.rejects(inv('android_update_check'), e => /not found/.test(e))
  assert.deepEqual(Array.from(ctx.__smokeMissing), ['android_update_check'])
  assert.equal(typeof (await ctx.__TAURI__.event.listen('x', () => {})), 'function')
})

test('引導情境：store_load 不預設「已引導」，其他情境預設已引導', async () => {
  const run = async name => {
    const ctx = vm.createContext({}); ctx.globalThis = ctx
    vm.runInContext(injectSource(tableFor(SCENARIOS.find(s => s.name === name))), ctx)
    return ctx.__TAURI__.core.invoke('store_load', { name: 'onboard' })
  }
  assert.equal(await run('onboard'), null)
  assert.ok(await run('m-signed-in'))
})

test('掛上判斷的表達式：語法正確、帶入選擇器與預期路徑', () => {
  const src = mountCheckSource('#app.m .m-pager', pathOf('m.html?x=1'))
  assert.equal(pathOf('chat.html?id=1'), '/chat.html')
  assert.ok(src.includes('"/m.html"') && src.includes('#app.m .m-pager'))
  assert.doesNotThrow(() => new vm.Script(src))
  // 空頁面：找不到 #app 要判失敗
  const ctx = vm.createContext({ location: { pathname: '/m.html', search: '' }, document: { querySelector: () => null } })
  const r = vm.runInContext(src, ctx)
  assert.equal(r.ok, false)
  assert.match(r.why, /#app/)
})

test('對話框遮罩情境（#536）：電腦與手機各一，檢查左上使用者區與名單；表達式語法正確', async () => {
  const mask = SCENARIOS.filter(s => s.probe)
  assert.deepEqual(mask.map(s => s.name), ['list-dialog-mask', 'm-dialog-mask'])
  assert.ok(MASK_PROBES.desktop.cover.includes('.me .me-dp') && MASK_PROBES.desktop.cover.includes('.rail'))
  assert.ok(MASK_PROBES.mobile.cover.includes('.m-head .m-me'))
  for (const s of mask) assert.doesNotThrow(() => new vm.Script(maskProbeSource(s.probe)))
  // 電腦版情境：整合模式開著夥伴分頁，名單上有這個夥伴
  const ctx = vm.createContext({}); ctx.globalThis = ctx
  vm.runInContext(injectSource(tableFor(SCENARIOS.find(s => s.name === 'list-dialog-mask'))), ctx)
  assert.deepEqual(JSON.parse(await ctx.__TAURI__.core.invoke('store_load', { name: 'me' })), PARTNER_ME)
  assert.equal((await ctx.__TAURI__.core.invoke('relay_list')).members[0].agents[0].name, 'demo')
})

test('找瀏覽器：指定路徑優先；找不到給清楚中文錯誤；候選依平台', () => {
  assert.equal(findBrowser({ explicit: 'B', env: {}, exists: p => p === 'B' }), 'B')
  assert.throws(() => findBrowser({ explicit: 'B', env: {}, exists: () => false }), /指定的瀏覽器不存在/)
  assert.equal(findBrowser({ env: { ASN_SMOKE_BROWSER: 'E' }, exists: p => p === 'E' }), 'E')
  assert.throws(() => findBrowser({ platform: 'win32', env: { PROGRAMFILES: 'C:\\P' }, exists: () => false }), /不會下載瀏覽器/)
  const w = browserCandidates('win32', { PROGRAMFILES: 'C:\\P' })
  assert.ok(w.some(p => /chrome\.exe$/.test(p)) && w.some(p => /msedge\.exe$/.test(p)))
  assert.equal(findBrowser({ platform: 'win32', env: { PROGRAMFILES: 'C:\\P' }, exists: p => /msedge\.exe$/.test(p) }).endsWith('msedge.exe'), true)
  assert.ok(browserCandidates('linux', { PATH: '/usr/bin' }).includes(path.join('/usr/bin', 'chromium')))
})

test('發版關卡：沒過就回 ok:false；--skip-smoke 不跑且印醒目警告；參數會被拿掉', () => {
  assert.deepEqual(splitSkipFlag(['--notes', 'x', '--skip-smoke']), { skip: true, rest: ['--notes', 'x'] })
  assert.deepEqual(splitSkipFlag(['--dry-run']), { skip: false, rest: ['--dry-run'] })
  const logs = [], warns = []
  const log = { log: m => logs.push(m), warn: m => warns.push(m) }
  const calls = []
  const bad = smokeGate({ root: 'R', skip: false, node: 'N', log, run: (...a) => { calls.push(a); return { status: 1 } } })
  assert.deepEqual(bad, { ok: false, skipped: false })
  assert.equal(calls.length, 1)
  assert.match(calls[0][1][0], /smoke-ui\.mjs$/)
  assert.equal(smokeGate({ root: 'R', skip: false, node: 'N', log, run: () => ({ status: 0 }) }).ok, true)
  const before = calls.length
  const skipped = smokeGate({ root: 'R', skip: true, log, run: () => { calls.push(1); return { status: 1 } } })
  assert.deepEqual(skipped, { ok: true, skipped: true })
  assert.equal(calls.length, before, '跳過就不能跑')
  assert.ok(warns.join('').includes(SKIP_WARNING) && warns.join('').includes('!!!'))
})

test('三支發版腳本都在打包前接了關卡；package.json 有 smoke:ui', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts['smoke:ui'], /smoke-ui\.mjs/)
  const order = (file, first, second) => {
    const s = read(file)
    const a = s.indexOf(first), b = s.indexOf(second)
    assert.ok(a > 0 && b > 0 && a < b, `${file}：${first} 要在 ${second} 之前`)
  }
  order('scripts/release.mjs', 'smokeGate({', "'scripts/bump.mjs'")
  order('scripts/release-android.mjs', 'smokeGate({', "'scripts/prep.mjs'")
  order('scripts/release-play.mjs', 'smokeGate({', "'scripts/prep.mjs'")
  order('scripts/release-play.mjs', 'smokeGate({', 'keytool')
  for (const f of ['release', 'release-android', 'release-play']) assert.ok(read(`scripts/${f}.mjs`).includes('--skip-smoke'), `${f} 的失敗訊息要提到 --skip-smoke`)
})
