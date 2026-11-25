// 設定項目效果紀錄（#1763 T4）：在無頭 Chrome 開電腦／手機設定頁的每一類，對每個控制項真的操作一次，
// 記下假 Tauri 收到的指令序列、設定檔（me）欄位差異、localStorage 差異，跟 test/golden/settings-effects.json 比。純邏輯在 settings-effects-lib.mjs。
//   node scripts/settings-effects.mjs                 量一次，跟 golden 比，有差異結束碼 1
//   ASN_GOLDEN_UPDATE=1 node scripts/settings-effects.mjs   重錄 golden（只在「使用者看得到的效果」確定要改時用；只能全量錄，不能搭配 --only）
//   --only <名稱片段,…>  只跑部分情境（例如 list-set-look,m-set-notify），只比對那幾類
//   --out <資料夾>       最新紀錄存這裡（settings-effects.json；預設系統暫存）
//   --timeout 毫秒、--browser 路徑
// 只用 --headless；不下載瀏覽器；伺服器只綁 127.0.0.1；瀏覽器程序只關自己記下 PID 的那一棵。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'
import { SMOKE_NOW, SCENARIOS, findBrowser, injectSource, mountCheckSource, pagerSettleSource, pathOf, probeSource, tableFor } from './smoke-lib.mjs'
import { clockSource } from './ui-shots-lib.mjs'
import { GOLDEN_VERSION, SETTLE_AFTER_MS, buildEntry, compareEffects, describeChange, entryId, findSecrets, fxHelperSource, markPlatformOnly, recorderSource, sortEntries, stripDefaultWrites } from './settings-effects-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ui = path.join(root, 'ui')
const GOLDEN = path.join(root, 'test', 'golden', 'settings-effects.json')
const fatal = m => { console.error(`設定效果紀錄無法執行：${m}`); process.exit(2) }

const opts = { only: [], out: '', timeoutMs: 15000, browser: '' }
for (let i = 2; i < process.argv.length; i++) {
  let a = process.argv[i], inline
  const eq = a.startsWith('--') ? a.indexOf('=') : -1
  if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq) }
  const val = () => (inline !== undefined ? inline : process.argv[++i])
  if (a === '--only') opts.only.push(...String(val() ?? '').split(',').filter(Boolean))
  else if (a === '--out') opts.out = val() ?? ''
  else if (a === '--timeout') opts.timeoutMs = Number(val())
  else if (a === '--browser') opts.browser = val() ?? ''
  else fatal(`不認得的參數：${process.argv[i]}`)
}
const UPDATE = process.env.ASN_GOLDEN_UPDATE === '1'
if (UPDATE && opts.only.length) fatal('重錄 golden 不能搭配 --only（只能全量）')

// 情境：設定頁基準情境（zSetPage）裡「有資料、復古外觀」那一組：電腦每一類、手機每一類
const all = SCENARIOS.filter(s => /^(list|m)-set-[a-z]+-aero$/.test(s.name))
const scenarios = all.filter(s => !opts.only.length || opts.only.some(f => s.name.includes(f)))
if (!scenarios.length) fatal('沒有符合的情境')
const platformOf = s => (s.page.startsWith('m.html') ? 'phone' : 'desk')
const catOf = s => s.probe.key
const deskCats = all.filter(s => platformOf(s) === 'desk').map(catOf)
const phoneCats = all.filter(s => platformOf(s) === 'phone').map(catOf)

let browserPath
try { browserPath = findBrowser({ explicit: opts.browser }) } catch (e) { console.log(`設定效果紀錄已略過（工具沒有跑，不是「沒有差異」）：${e.message}`); console.log(`::warning::設定效果紀錄沒有跑：${e.message}`); process.exit(3) }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const f = path.join(ui, decodeURIComponent(u.pathname))
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': `${MIME[path.extname(f)] ?? 'application/octet-stream'}; charset=utf-8` })
  res.end(fs.readFileSync(f))
})
let child = null, profile = '', cleaned = false
const killTree = pid => {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* 已結束 */ } }
}
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  killTree(child?.pid)
  try { server.close() } catch { /* 已關 */ }
  if (profile) { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 暫存而已 */ } }
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const connect = url => new Promise((resolve, reject) => {
  const ws = new WebSocket(url)
  let seq = 0
  const pending = new Map()
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result) } }
  ws.onerror = () => reject(new Error('連不上瀏覽器的偵錯連線'))
  ws.onopen = () => resolve({
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params, sessionId })) }),
    close: () => { try { ws.close() } catch { /* 已關 */ } },
  })
})
const evalValue = async (S, expression, awaitPromise = false) => (await S('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })).result.value

const tableCache = new Map()
const tableAt = sc => {
  if (tableCache.has(sc.name)) return tableCache.get(sc.name)
  const Real = globalThis.Date
  globalThis.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(SMOKE_NOW) } static now() { return SMOKE_NOW } }
  try { const t = tableFor(sc); tableCache.set(sc.name, t); return t } finally { globalThis.Date = Real }
}
const SAVE_LABEL = /^(儲存|套用|送出|確認|核准|建立)/
const rootSel = sc => (platformOf(sc) === 'phone' ? '#app.m .m-fourth' : '#app.win .panel-pane')

// 開一頁、打開該類設定、裝上控制項輔助；fn(S) 做事；用完關掉
async function withPage(cdp, sc, base, fn) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  try {
    await S('Runtime.enable'); await S('Page.enable')
    await S('Emulation.setDeviceMetricsOverride', { width: sc.width ?? (platformOf(sc) === 'phone' ? 412 : 1100), height: sc.height ?? 800, deviceScaleFactor: 1, mobile: platformOf(sc) === 'phone' })
    await S('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Taipei' })
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await S('Page.addScriptToEvaluateOnNewDocument', { source: [clockSource(SMOKE_NOW), injectSource(tableAt(sc)), recorderSource()].join('\n') })
    await S('Page.navigate', { url: `${base}/${sc.page}` })
    const expr = mountCheckSource(sc.ready, pathOf(sc.page))
    const check = async () => { try { return (await evalValue(S, expr)) ?? { ok: false, why: '頁面還沒就緒' } } catch { return { ok: false, why: '頁面還沒就緒' } } }
    const deadline = Date.now() + opts.timeoutMs
    let c = await check()
    while (!c.ok && Date.now() < deadline) { await sleep(200); c = await check() }
    if (!c.ok) throw new Error(`沒有掛上：${c.why}`)
    await sleep(800)
    const pv = await evalValue(S, probeSource(sc.probe), true)   // 打開該類設定並確認真的畫出來（沒畫出來不能算「沒有項目」）
    if (!pv?.ok) throw new Error(`設定頁沒有畫出來：${pv?.why || '沒有回結果'}`)
    try { await evalValue(S, pagerSettleSource(), true) } catch { /* 沒有 pager 就略過 */ }
    await evalValue(S, fxHelperSource(rootSel(sc)))
    return await fn(S)
  } finally { await cdp.send('Target.closeTarget', { targetId }).catch(() => {}) }
}

const initialMeOf = sc => { try { return JSON.parse(tableAt(sc).store_load?.values?.me ?? '{}') } catch { return {} } }

async function recordScenario(cdp, sc, base) {
  const items = await withPage(cdp, sc, base, S => evalValue(S, '__fx.items()'))
  if (!items?.length) throw new Error('設定頁內沒有找到任何控制項')
  const entries = []
  // 先量一次「不操作」：背景輪詢的指令與頁面自己的預設存檔，之後扣掉
  const doRun = async steps => {
    const run = await withPage(cdp, sc, base, S => evalValue(S, `__fx.run(${JSON.stringify(steps)}, ${SETTLE_AFTER_MS})`, true))
    if (!run?.ok) throw new Error(`操作「${steps.map(s => s.label).join('」→「')}」失敗：${run?.why}`)
    return run
  }
  const base0 = await doRun([])
  const idOf = s => `${s.kind}|${s.label}#${s.nth}`
  for (const item of items) {
    const run = await doRun([item])
    entries.push(buildEntry({ platform: platformOf(sc), cat: catOf(sc), item, run, base: base0, initialMe: initialMeOf(sc), nowMs: SMOKE_NOW }))
    // 第二層：這個操作讓畫面多出來的控制項（先按「詳情」才有的按鈕、確認框的按鈕…），各操作一次（再往下不追）
    for (const r2 of run.reveals ?? []) {
      const run2 = await doRun([item, r2])
      entries.push(buildEntry({ platform: platformOf(sc), cat: catOf(sc), item: r2, via: idOf(item), run: run2, base: base0, initialMe: initialMeOf(sc), nowMs: SMOKE_NOW }))
    }
    // 輸入類（文字、數字）單獨輸入不會存：再配「同一層」的儲存類按鈕做「輸入後按儲存」的整串流程（via＝先輸入的那個）
    if (item.kind === 'text' || item.kind === 'number') {
      for (const save of items.filter(x => x.kind === 'button' && SAVE_LABEL.test(x.label))) {
        const run3 = await doRun([item, save])
        entries.push(buildEntry({ platform: platformOf(sc), cat: catOf(sc), item: save, via: idOf(item), run: run3, base: base0, initialMe: initialMeOf(sc), nowMs: SMOKE_NOW }))
      }
    }
  }
  return entries
}

const out = path.resolve(opts.out || path.join(os.tmpdir(), 'asn-settings-effects'))
const entries = [], failed = []
const t0 = Date.now()
try {
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r) })
  const base = `http://127.0.0.1:${server.address().port}`
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-fx-'))
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--force-device-scale-factor=1', '--font-render-hinting=none', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.on('error', e => fatal(`瀏覽器啟動失敗：${e.message}`))
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 400 && !fs.existsSync(portFile) && child.exitCode === null; i++) await sleep(150)
  if (!fs.existsSync(portFile)) throw new Error('瀏覽器沒有開出偵錯連線')
  const { port, wsPath } = await readDevToolsPort(portFile)
  const cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`)
  console.log(`設定效果紀錄：瀏覽器 ${browserPath}（PID ${child.pid}）；情境 ${scenarios.length} 個`)
  for (const sc of scenarios) {
    try { const es = await recordScenario(cdp, sc, base); entries.push(...es); console.log(`✓ ${sc.name} 控制項 ${es.length} 個`) } catch (e) { failed.push(`${sc.name}：${e.message}`); console.log(`✗ ${sc.name} ${e.message}`) }
  }
  cdp.close()
} catch (e) { failed.push(`整體：${e.message}`) } finally { cleanup() }

const latest = {
  version: GOLDEN_VERSION,
  note: '設定項目效果紀錄（#1763 T4）。每筆＝一個控制項真的操作一次後：假 Tauri 收到的指令、設定檔 me 的欄位差異、localStorage 差異。在舊程式上錄，搬完用同一份驗收。重錄：ASN_GOLDEN_UPDATE=1 node scripts/settings-effects.mjs',
  scenarios: scenarios.map(s => s.name),
  entries: sortEntries(markPlatformOnly(stripDefaultWrites(entries), { deskCats, phoneCats })),
}
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'settings-effects.json'), JSON.stringify(latest, null, 1))
console.log(`設定效果紀錄：${scenarios.length - failed.length}/${scenarios.length} 個情境、控制項 ${entries.length} 個、耗時 ${Math.round((Date.now() - t0) / 1000)} 秒、結果 ${path.join(out, 'settings-effects.json')}`)
if (failed.length) { console.error(`🔴 有情境沒跑完（不能當成沒有差異）：\n  ${failed.join('\n  ')}`); process.exit(1) }

const secrets = findSecrets(JSON.stringify(latest))
if (secrets.length) { console.error(`🔴 紀錄裡出現疑似金鑰／真實帳號：\n  ${secrets.join('\n  ')}`); process.exit(1) }

if (UPDATE) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
  fs.writeFileSync(GOLDEN, JSON.stringify(latest, null, 1).replace(/\n/g, '\r\n') + '\r\n')
  console.log(`已重錄 ${GOLDEN}：${latest.entries.length} 筆`)
  process.exit(0)
}
if (!fs.existsSync(GOLDEN)) { console.error(`沒有 golden 檔 ${GOLDEN}（先用 ASN_GOLDEN_UPDATE=1 錄一份）`); process.exit(1) }
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
const part = opts.only.length ? { ...golden, entries: golden.entries.filter(e => scenarios.some(s => platformOf(s) === e.platform && catOf(s) === e.cat)) } : golden
// 只跑部分情境時，另一個平台沒有一起量，「平台專屬」標記算不出來：沿用 golden 的標記，只比其他欄位
const gMark = new Map(golden.entries.map(e => [entryId(e), e.platformOnly]))
const cmp = compareEffects(part, opts.only.length ? { ...latest, entries: latest.entries.map(e => ({ ...e, platformOnly: gMark.has(entryId(e)) ? gMark.get(entryId(e)) : e.platformOnly })) } : latest)
for (const [title, list] of [['🔴 golden 有、這次沒有的項目', cmp.missing], ['🔴 golden 沒有、這次多出的項目', cmp.extra]]) if (list.length) console.log(`${title}（${list.length}）\n${list.slice(0, 40).map(x => '  ' + x).join('\n')}`)
if (cmp.changed.length) console.log(`🔴 效果不同（${cmp.changed.length}）\n${cmp.changed.slice(0, 40).map(c => '  ' + describeChange(c)).join('\n')}`)
console.log(cmp.ok ? `設定效果紀錄：與 golden 一致（${latest.entries.length} 筆）` : '設定效果紀錄：與 golden 不一致')
process.exit(cmp.ok ? 0 : 1)
