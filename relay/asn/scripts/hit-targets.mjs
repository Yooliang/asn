// 手機觸控目標棘輪（#1763 T3，hitTarget 探測）：在無頭 Chrome 開手機設定頁的每一個情境（m-set-*：每類內容頁 × 外觀 × 412／360、狀態類），
// 量所有可點元素（button、a、input、select…）的大小，列出寬或高小於 44px 的。純邏輯在 hit-targets-lib.mjs，守門測試在 test/hit-targets.test.mjs。
//   node scripts/hit-targets.mjs                     量一次，跟基準（test/golden/hit-targets-baseline.json）比，有新增或惡化就結束碼 1
//   node scripts/hit-targets.mjs --update            量一次，把結果寫成新基準（只在確定違規變少、或情境有增減時用）
//   --only <名稱片段,…>   只量部分情境（只能比對、不能 --update）
//   --out <資料夾>        量測結果存這裡（hit-targets.json、report.md；預設系統暫存的 asn-hit-targets）。測試用 ASN_HIT_TARGETS_LATEST 指到那份 json 就會一起檢查
//   --timeout 毫秒、--browser 路徑
// 只用 --headless；不下載瀏覽器；伺服器只綁 127.0.0.1；瀏覽器程序只關自己記下 PID 的那一棵。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SMOKE_NOW, SCENARIOS, findBrowser, injectSource, mountCheckSource, pagerSettleSource, pathOf, probeSource, tableFor } from './smoke-lib.mjs'
import { clockSource, freezeSource } from './ui-shots-lib.mjs'
import { baselineProblems, compareHitTargets, hitTargetSource, lineOf, makeBaseline, sortViolations } from './hit-targets-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ui = path.join(root, 'ui')
const BASELINE = path.join(root, 'test', 'golden', 'hit-targets-baseline.json')
const fatal = m => { console.error(`觸控目標量測無法執行：${m}`); process.exit(2) }

const opts = { update: false, only: [], out: '', timeoutMs: 15000, browser: '' }
for (let i = 2; i < process.argv.length; i++) {
  let a = process.argv[i], inline
  const eq = a.startsWith('--') ? a.indexOf('=') : -1
  if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq) }
  const val = () => (inline !== undefined ? inline : process.argv[++i])
  if (a === '--update') opts.update = true
  else if (a === '--only') opts.only.push(...String(val() ?? '').split(',').filter(Boolean))
  else if (a === '--out') opts.out = val() ?? ''
  else if (a === '--timeout') opts.timeoutMs = Number(val())
  else if (a === '--browser') opts.browser = val() ?? ''
  else fatal(`不認得的參數：${process.argv[i]}`)
}
if (opts.update && opts.only.length) fatal('--update 要量全部情境，不能搭配 --only')
if (!(opts.timeoutMs >= 1000)) fatal('--timeout 要是不小於 1000 的毫秒數')

// 量的情境：手機的設定頁基準情境（m-set-*）
const scenarios = SCENARIOS.filter(s => s.page.startsWith('m.html') && s.probe?.setPage && (!opts.only.length || opts.only.some(f => s.name.includes(f))))
if (!scenarios.length) fatal('沒有符合的手機設定頁情境')

let browserPath
try { browserPath = findBrowser({ explicit: opts.browser }) } catch (e) { fatal(e.message) }
if (!fs.existsSync(path.join(ui, 'vendor', 'vue.global.prod.js'))) fatal('ui/vendor 不存在，先執行 node scripts/prep.mjs')

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

// 跑一個情境（流程同 ui-shots：開頁→假 Tauri→等掛上→設定頁探測打開該類→等滑頁停→凍住畫面）再量
const tableCache = new Map()
const tableAt = sc => {
  if (tableCache.has(sc.name)) return tableCache.get(sc.name)
  const Real = globalThis.Date
  globalThis.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(SMOKE_NOW) } static now() { return SMOKE_NOW } }
  try { const t = tableFor(sc); tableCache.set(sc.name, t); return t } finally { globalThis.Date = Real }
}
async function measure(cdp, sc, base) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  try {
    await S('Runtime.enable'); await S('Page.enable')
    await S('Emulation.setDeviceMetricsOverride', { width: sc.width ?? 412, height: sc.height ?? 800, deviceScaleFactor: 1, mobile: true })
    await S('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Taipei' })
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await S('Page.addScriptToEvaluateOnNewDocument', { source: clockSource(SMOKE_NOW) + '\n' + injectSource(tableAt(sc)) })
    await S('Page.navigate', { url: `${base}/${sc.page}` })
    const expr = mountCheckSource(sc.ready, pathOf(sc.page))
    const check = async () => { try { return (await evalValue(S, expr)) ?? { ok: false, why: '頁面還沒就緒' } } catch { return { ok: false, why: '頁面還沒就緒' } } }
    const deadline = Date.now() + opts.timeoutMs
    let c = await check()
    while (!c.ok && Date.now() < deadline) { await sleep(200); c = await check() }
    if (!c.ok) return { error: `沒有掛上：${c.why}` }
    await sleep(1000)
    const pv = await evalValue(S, probeSource(sc.probe), true)   // 設定頁探測：點進該類內頁並確認真的畫出來（R9：沒畫出來不能算「沒有違規」）
    if (!pv?.ok) return { error: `設定頁沒有畫出來：${pv?.why || '沒有回結果'}` }
    try { await evalValue(S, pagerSettleSource(), true) } catch { /* 沒有 pager 就略過 */ }
    await evalValue(S, freezeSource(), true)
    const r = await evalValue(S, hitTargetSource())
    if (!r?.ok) return { error: r?.why || '量測沒有回結果' }
    if (!(r.total > 0)) return { error: '量到 0 個可點元素（內頁是空的？）' }
    return { total: r.total, violations: r.violations.map(v => ({ scenario: sc.name, ...v })) }
  } finally { await cdp.send('Target.closeTarget', { targetId }).catch(() => {}) }
}

const out = path.resolve(opts.out || path.join(os.tmpdir(), 'asn-hit-targets'))
const violations = [], measured = [], failed = []
let targets = 0
const t0 = Date.now()
try {
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r) })
  const base = `http://127.0.0.1:${server.address().port}`
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-hit-'))
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--force-device-scale-factor=1', '--font-render-hinting=none', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.on('error', e => fatal(`瀏覽器啟動失敗：${e.message}`))
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 400 && !fs.existsSync(portFile) && child.exitCode === null; i++) await sleep(150)
  if (!fs.existsSync(portFile)) throw new Error('瀏覽器沒有開出偵錯連線')
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)
  const cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`)
  console.log(`觸控目標量測：瀏覽器 ${browserPath}（PID ${child.pid}）；情境 ${scenarios.length} 個`)
  for (const sc of scenarios) {
    let r
    try { r = await measure(cdp, sc, base) } catch (e) { r = { error: `量測程序出錯：${e.message}` } }
    if (r.error) { failed.push(`${sc.name}：${r.error}`); console.log(`✗ ${sc.name} ${r.error}`); continue }
    measured.push(sc.name); targets += r.total; violations.push(...r.violations)
    console.log(`✓ ${sc.name} 可點元素 ${r.total} 個、小於 44px 的 ${r.violations.length} 個`)
  }
  cdp.close()
} catch (e) { failed.push(`整體：${e.message}`) } finally { cleanup() }

const sorted = sortViolations(violations)
fs.mkdirSync(out, { recursive: true })
const latest = { scenarios: measured, targets, violations: sorted }
fs.writeFileSync(path.join(out, 'hit-targets.json'), JSON.stringify(latest, null, 1))
const seconds = Math.round((Date.now() - t0) / 1000)
console.log(`觸控目標量測：${measured.length}/${scenarios.length} 個情境量到、可點元素 ${targets} 個、違規 ${sorted.length} 筆、耗時 ${seconds} 秒、結果 ${path.join(out, 'hit-targets.json')}`)
if (failed.length) { console.error(`🔴 有情境沒量到（不能當成沒有違規）：\n  ${failed.join('\n  ')}`); process.exit(1) }

if (opts.update) {
  const b = makeBaseline({ scenarios: measured, violations: sorted })
  const bad = baselineProblems(b)
  if (bad.length) fatal(`產生的基準不一致：${bad.join('；')}`)
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify(b, null, 1).replace(/\n/g, '\r\n') + '\r\n')
  console.log(`已更新基準 ${BASELINE}：${b.total} 筆違規、${Object.keys(b.scenarios).length} 個情境`)
  process.exit(0)
}
if (!fs.existsSync(BASELINE)) { console.error(`沒有基準檔 ${BASELINE}（先用 --update 產生）`); process.exit(1) }
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
// --only 只量一部分時，基準也只取同一部分來比
const part = opts.only.length ? { ...baseline, violations: baseline.violations.filter(v => measured.includes(v.scenario)), scenarios: Object.fromEntries(Object.entries(baseline.scenarios).filter(([n]) => measured.includes(n))) } : baseline
const cmp = compareHitTargets(part, latest)
const show = (title, list, fn = lineOf) => { if (list.length) console.log(`${title}（${list.length}）\n${list.slice(0, 40).map(v => '  ' + fn(v)).join('\n')}${list.length > 40 ? `\n  …另外 ${list.length - 40} 筆` : ''}`) }
show('🔴 新增的違規', cmp.added)
show('🔴 惡化的違規（最短邊縮短）', cmp.worsened, x => `${lineOf(x.now)}（原本 ${x.was.w}×${x.was.h}）`)
show('改善（可用 --update 更新基準）', cmp.improved)
if (cmp.unmeasured.length) console.log(`🔴 基準裡有、這次沒量到的情境：${cmp.unmeasured.join('、')}`)
console.log(cmp.ok ? `觸控目標棘輪：通過（違規 ${sorted.length} 筆，基準 ${part.violations.length} 筆）` : '觸控目標棘輪：失敗')
process.exit(cmp.ok ? 0 : 1)
