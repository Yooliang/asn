// 啟動冒煙測試的純邏輯：參數、入口頁清單、假 Tauri 回應表、瀏覽器尋找、發版關卡。（真正載頁面的部分由 npm run smoke:ui 跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { BAR_PROBES, EXCLUDED_PAGES, GROUP_ITEMS, groupProbeSource, probeKind, MASK_PROBES, barProbeSource, probeSource, PARTNER_ME, SCENARIOS, browserCandidates, fakeTable, findBrowser, injectSource, maskProbeSource, mountCheckSource, parseSmokeArgs, pathOf, selectScenarios, tableFor } from '../scripts/smoke-lib.mjs'
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
  const mask = SCENARIOS.filter(s => s.probe && !s.probe.bar && !s.probe.group && !s.probe.mbar && !s.probe.mgroup && !s.probe.quota && !s.probe.mattach)
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

test('手機大按鈕情境（#539 之四）：412 寬、Claude 與 ACP 各一，6 顆依序、反灰正確；表達式語法正確；夥伴開在另一台', async () => {
  const sc = SCENARIOS.filter(s => s.probe?.mbar)
  assert.deepEqual(sc.map(s => s.name), ['m-bar-claude', 'm-bar-acp', 'm-bar-offline'])
  for (const s of sc) {
    assert.ok(s.page.startsWith('m.html'), '手機頁以 412 寬開')
    assert.deepEqual(s.probe.mbar.map(x => x[0]), ['call', 'window', 'model', 'subs', 'tasks', 'manage'])
    const can = s.probe.wake ? ['window', 'manage'] : ['model', 'manage']
    assert.deepEqual(s.probe.mbar.filter(x => !x[1]).map(x => x[0]), can, '手機上能按的：在線＝切換模型與管理；離線＝喚醒與管理（假環境沒有語音）')
    assert.doesNotThrow(() => new vm.Script(probeSource(s.probe)))
    assert.equal(probeKind(s.probe), '手機大按鈕檢查')
    const ctx = vm.createContext({}); ctx.globalThis = ctx
    vm.runInContext(injectSource(tableFor(s)), ctx)
    assert.equal(JSON.parse(await ctx.__TAURI__.core.invoke('store_load', { name: 'me' })).lastChat, 'Q/demo')
    assert.equal((await ctx.__TAURI__.core.invoke('android_launchers')).machines[0].node, 'Q')
  }
})

test('手機群組對話情境（#539 收尾）：最後使用的是群組、假群組列表；「群組」選單三項、沒有「輸入邀請碼加入」；表達式語法正確', async () => {
  const sc = SCENARIOS.find(s => s.name === 'm-group-chat')
  assert.ok(sc && sc.page.startsWith('m.html'))
  assert.deepEqual(sc.probe.mgroup, GROUP_ITEMS)
  assert.ok(!GROUP_ITEMS.includes('輸入邀請碼加入'))
  assert.equal(probeKind(sc.probe), '手機群組按鈕檢查')
  assert.doesNotThrow(() => new vm.Script(probeSource(sc.probe)))
  const ctx = vm.createContext({}); ctx.globalThis = ctx
  vm.runInContext(injectSource(tableFor(sc)), ctx)
  const inv = ctx.__TAURI__.core.invoke
  assert.equal(JSON.parse(await inv('store_load', { name: 'me' })).lastChat, 'room:g1')
  assert.equal((await inv('relay_rooms')).rooms[0].id, 'g1')
  const off = SCENARIOS.find(s => s.name === 'm-bar-offline')
  assert.equal(off.probe.wake, true)
  assert.deepEqual(off.probe.mbar[1], ['window', false, '喚醒'])
  assert.doesNotThrow(() => new vm.Script(probeSource(off.probe)))
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

test('固定 6 顆大按鈕情境（#539）：閒置 Claude、離線 Claude、ACP 各一，6 顆依序、反灰狀態；表達式語法正確', async () => {
  const bar = SCENARIOS.filter(s => s.probe?.bar)
  assert.deepEqual(bar.map(s => s.name), ['list-bar-fixed', 'list-bar-fixed-offline', 'list-bar-fixed-acp', 'list-bar-tasks'])
  for (const s of bar) {
    assert.deepEqual(s.probe.bar.map(x => x[0]), ['call', 'window', 'model', 'subs', 'tasks', 'manage'], s.name)
    assert.equal(probeSource(s.probe), barProbeSource(s.probe))
    assert.doesNotThrow(() => new vm.Script(barProbeSource(s.probe)))
  }
  assert.deepEqual(BAR_PROBES.acp.bar[1], ['window', 'ACP 模式', true])
  assert.deepEqual([BAR_PROBES.offline.bar[1], BAR_PROBES.offline.wake], [['window', '喚醒', false], true], '離線時第 2 格是喚醒、可按')
  assert.deepEqual(BAR_PROBES.claude.bar[1], ['window', '後台隱藏', false], '在線時照舊前後台')
  assert.match(barProbeSource(BAR_PROBES.offline), /img\/ab-wake\.svg/)
  const ctx = vm.createContext({}); ctx.globalThis = ctx
  vm.runInContext(injectSource(tableFor(SCENARIOS.find(s => s.name === 'list-bar-fixed-acp'))), ctx)
  assert.equal((await ctx.__TAURI__.core.invoke('relay_list')).members[0].agents[0].engine, 'gemini')
})

test('工作項目情境（#539 之三）：有件數時可按、徽章數字、列表打得開、header 拿掉件數；0 件的情境反灰、沒有徽章', async () => {
  const sc = SCENARIOS.find(s => s.name === 'list-bar-tasks')
  assert.ok(sc, '要有工作項目情境')
  assert.deepEqual(sc.probe.bar.find(x => x[0] === 'tasks'), ['tasks', '工作項目', false])
  assert.deepEqual([sc.probe.badge, sc.probe.header], ['3', 'demo'])
  assert.deepEqual(sc.probe.taskItems, ['建置', '跑測試', '還有 1 件沒列出'])
  assert.deepEqual(BAR_PROBES.claude.bar.find(x => x[0] === 'tasks'), ['tasks', '工作項目', true])
  assert.equal(BAR_PROBES.claude.badge, '', '0 件不顯示徽章')
  const src = barProbeSource(sc.probe)
  assert.doesNotThrow(() => new vm.Script(src))
  assert.match(src, /\.ab-badge/)
  const ctx = vm.createContext({}); ctx.globalThis = ctx
  vm.runInContext(injectSource(tableFor(sc)), ctx)
  const inv = ctx.__TAURI__.core.invoke
  assert.equal((await inv('relay_list')).members[0].agents[0].detail, '背景工作 3 件')
  assert.equal((await inv('tasks_query', { req: { name: 'demo' } })).items.length, 2)
})

test('群組分頁情境（#539 之二）：假群組列表＋session 帶 room: 分頁；檢查「群組」四項、「管理」不再有它們；反灰檢查改看 aria-disabled', async () => {
  const sc = SCENARIOS.find(s => s.name === 'list-group-tab')
  assert.ok(sc, '要有群組分頁情境')
  assert.deepEqual(sc.probe.group, GROUP_ITEMS)
  assert.deepEqual(GROUP_ITEMS, ['邀請別人加入', '加我的另一個 AI', '成員與設定'], '#539 收尾拿掉「輸入邀請碼加入」')
  assert.equal(probeSource(sc.probe), groupProbeSource(sc.probe))
  assert.equal(probeKind(sc.probe), '群組按鈕檢查')
  assert.doesNotThrow(() => new vm.Script(groupProbeSource(sc.probe)))
  const ctx = vm.createContext({}); ctx.globalThis = ctx
  vm.runInContext(injectSource(tableFor(sc)), ctx)
  const inv = ctx.__TAURI__.core.invoke
  assert.equal((await inv('relay_rooms')).rooms[0].id, 'g1')
  const me = JSON.parse(await inv('store_load', { name: 'me' }))
  assert.deepEqual(me.session.tabs, [{ id: 'room:g1' }])
  assert.equal(JSON.stringify(await inv('relay_group', { action: 'group_confirm_list' })), '{"confirms":[]}')
  // 大按鈕檢查：反灰看 aria-disabled、有原生 disabled 就失敗、反灰的選單鈕點了不能打開
  const bar = barProbeSource(BAR_PROBES.offline)
  assert.ok(bar.includes(`getAttribute('aria-disabled') === 'true'`))
  assert.ok(bar.includes(`hasAttribute('disabled')`))
  assert.ok(bar.includes('反灰卻點得開'))
})

test('手機群組附件情境（0.1.111）：沒有外部成員、有外部成員的群組兩顆都在且送得出去；假回應表帶 external；表達式語法正確', async () => {
  const yes = SCENARIOS.find(s => s.name === 'm-group-attach'), no = SCENARIOS.find(s => s.name === 'm-group-attach-external')
  assert.ok(yes && no && yes.page.startsWith('m.html') && no.page.startsWith('m.html'))
  assert.deepEqual(yes.probe.mattach.labels, ['傳照片', '傳送檔案'])
  assert.deepEqual(no.probe.mattach.labels, ['傳照片', '傳送檔案'], '有外部成員的群組也能傳附件（0.1.111）')
  assert.equal(tableFor(yes).relay_rooms.rooms[0].external, undefined)
  assert.equal(tableFor(no).relay_rooms.rooms[0].external, true)
  for (const sc of [yes, no]) {
    assert.equal(probeKind(sc.probe), '手機群組附件檢查')
    assert.doesNotThrow(() => new vm.Script(probeSource(sc.probe)))
  }
  const css = fs.readFileSync(fileURLToPath(new URL('../ui/mobile.css', import.meta.url)), 'utf8')
  assert.ok(!/\.is-room \.toolbar>\.tool\s*\{\s*display:\s*none/.test(css), '群組工具列不能整排藏掉（附件鈕要看得到）')
  const mjs = fs.readFileSync(fileURLToPath(new URL('../ui/m.js', import.meta.url)), 'utf8')
  assert.ok(/createRoomHub\(\{.*photos: true/.test(mjs), '手機群組要帶 photos:true，附件照片才看得到')
  assert.ok(/\.is-room \.toolbar>\.tool\.dict/.test(css) && /\.is-room \.toolbar>\.tool\.mic/.test(css), '群組只藏語音輸入與麥克風')
})
