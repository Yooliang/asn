// 畫面截圖比對（#1763 T2）：對「基準 ui」與「新 ui」各自跑同一組情境（既有 smoke 情境裡帶 shot 的子集），
// 取得截圖、結構快照，逐情境比對，產出報告。預設只報告、結束碼 0；加 --strict 才在有差異時結束碼 1。
//   node scripts/ui-shots.mjs --base <ui 資料夾> --new <ui 資料夾> [--out <資料夾>] [--only 名稱片段,…] [--limit N]
//                             [--strict] [--include-unstable] [--pixel-tolerance 0.001] [--color-tolerance 0] [--jobs 並行情境數，預設 1；大於 1 時畫面可能因計時器而不穩，只在探勘時用] [--timeout 毫秒] [--browser 路徑] [--list]
// 輸出（--out，預設暫存資料夾）：report.md；base/、new/（每情境的 .png 與 .txt 結構快照）；diff/（有差異的情境：差異圖、並排圖、結構差異 .diff）。
// 起瀏覽器、假 Tauri、視窗尺寸、等 Vue 掛上都沿用 smoke-ui／smoke-lib 的做法；只用系統已裝的 Chrome／Edge，不下載；伺服器只綁 127.0.0.1。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { SMOKE_NOW, SCENARIOS, findBrowser, injectSource, mountCheckSource, mpaneWidenProbeSource, pagerSettleSource, pathOf, probeKind, probeSource, tableFor } from './smoke-lib.mjs'
import { PNG_1X1, realInput } from './ui-shots-input.mjs'
import { clockSource, cjkProbeSource, cjkVerdict, toolBroken, compareImages, coverage, decodePng, diffLines, encodePng, formatReport, freezeSource, isMonochrome, parseShotArgs, rowStatus, sampleScenarios, scenarioSkin, scenarioWidth, shotScenarios, sideBySide, snapshotSource, strictFailed, UNSTABLE_SCENARIOS } from './ui-shots-lib.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fatal = m => { console.error(`畫面截圖比對無法執行：${m}`); process.exit(2) }

let opts
try { opts = parseShotArgs(process.argv.slice(2)) } catch (e) { fatal(e.message) }

let scenarios = shotScenarios(SCENARIOS, opts.only, { includeUnstable: opts.includeUnstable })
if (!scenarios.length) fatal(`沒有符合 --only ${opts.only.join(',')} 的情境（只有帶 shot 的情境會參與比對）`)
scenarios = sampleScenarios(scenarios, opts.limit)
if (opts.list) {
  for (const s of scenarios) console.log(`${s.name}\t${s.page}\t${scenarioWidth(s)}\t${scenarioSkin(s)}`)
  const cov = coverage(scenarios)
  console.log(`共 ${scenarios.length} 個情境${cov.missing.length ? `；缺：${cov.missing.join('、')}` : ''}`)
  process.exit(0)
}

const out = path.resolve(opts.out || path.join(os.tmpdir(), 'asn-ui-shots'))
const baseUi = path.resolve(opts.base), newUi = path.resolve(opts.new)
const writeReport = md => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'report.md'), md) }
const baseMeta = { base: baseUi, new: newUi }

// 找不到瀏覽器：清楚說明後提早結束（不讓 PR 紅）；--strict 才算失敗
let browserPath
try { browserPath = findBrowser({ explicit: opts.browser }) } catch (e) {
  console.log(`畫面截圖比對已略過（工具沒有跑，不是「沒有差異」）：${e.message}`)
  console.log(`::warning::畫面截圖比對沒有跑：${e.message}`)
  writeReport(formatReport({ rows: [], meta: { ...baseMeta, skipped: e.message }, opts }))
  process.exit(3)   // 工具壞了固定非 0（步驟是 continue-on-error，不擋 PR，但會顯示警告）
}
for (const [label, dir] of [['--base', baseUi], ['--new', newUi]]) {
  if (!fs.existsSync(path.join(dir, 'm.html'))) fatal(`${label} ${dir} 不像 ui 資料夾（找不到 m.html）`)
  if (!fs.existsSync(path.join(dir, 'vendor', 'vue.global.prod.js'))) fatal(`${label} ${dir} 沒有 vendor/（先在那份程式碼裡執行 node scripts/prep.mjs）`)
}
for (const d of ['base', 'new', 'diff']) fs.rmSync(path.join(out, d), { recursive: true, force: true })

// ---- 靜態伺服器（每份 ui 一台）----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' }
const makeServer = ui => http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const f = path.join(ui, decodeURIComponent(u.pathname))
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': `${MIME[path.extname(f)] ?? 'application/octet-stream'}; charset=utf-8` })
  res.end(fs.readFileSync(f))
})
const servers = [makeServer(baseUi), makeServer(newUi)]

let child = null, profile = '', cleaned = false
const killTree = pid => {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* 已結束 */ } }
}
const SMOKE_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-shots-files-'))
fs.writeFileSync(path.join(SMOKE_FILES, 'ok1.png'), PNG_1X1)
fs.writeFileSync(path.join(SMOKE_FILES, 'ok2.png'), PNG_1X1)
fs.writeFileSync(path.join(SMOKE_FILES, 'bad.png'), Buffer.from('這不是圖片，只是一段文字。'))
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  killTree(child?.pid)   // 只關自己啟動並記下 PID 的那一棵
  for (const s of servers) { try { s.close() } catch { /* 已關 */ } }
  if (profile) { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 暫存而已 */ } }
  try { fs.rmSync(SMOKE_FILES, { recursive: true, force: true }) } catch { /* 暫存而已 */ }
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130) })

// ---- 最小的 DevTools 連線（同 smoke-ui，多一個 off）----
const connect = url => new Promise((resolve, reject) => {
  const ws = new WebSocket(url)
  let seq = 0
  const pending = new Map(), handlers = new Set()
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result) } else for (const h of handlers) h(d)
  }
  ws.onerror = () => reject(new Error('連不上瀏覽器的偵錯連線'))
  ws.onopen = () => resolve({
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params, sessionId })) }),
    on: h => { handlers.add(h); return () => handlers.delete(h) },
    close: () => { try { ws.close() } catch { /* 已關 */ } },
  })
})

const argText = a => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type)
const evalValue = async (S, expression, awaitPromise = false) => (await S('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })).result.value

// 跑一個情境（流程同 smoke-ui 的 runScenario：開頁→假 Tauri→等掛上→探測→widen→等滑頁停→截圖），再凍住畫面取結構快照
// 假後台表有些時間是組表當下的真實時間（訊息時間「13:03」之類）：組表時把這個行程的 Date 暫時換成固定值（跟頁面的假時間同一個），
// 每個情境只組一次，基準與新版用同一份。不這樣做，兩次組表差一分鐘就會誤報文字差異
const tableCache = new Map()
const tableAt = sc => {
  if (tableCache.has(sc.name)) return tableCache.get(sc.name)
  const Real = globalThis.Date
  globalThis.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(SMOKE_NOW) } static now() { return SMOKE_NOW } }
  try { const t = tableFor(sc); tableCache.set(sc.name, t); return t } finally { globalThis.Date = Real }
}

async function runShot(cdp, sc, base, { wantCjk = false } = {}) {
  const errors = []
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  const chooserWaiters = []
  const off = cdp.on(d => {
    if (d.sessionId !== sessionId) return
    if (d.method === 'Runtime.exceptionThrown') { const x = d.params.exceptionDetails; errors.push(`未捕捉例外：${x.exception?.description ?? x.text}`) }
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(`console.error：${d.params.args.map(argText).join(' ')}`)
    else if (d.method === 'Page.fileChooserOpened') { const w = chooserWaiters.shift(); if (w) w(d.params) }
    else if (d.method === 'Runtime.bindingCalled' && d.params.name === '__smokeInput') realInput(S, d.params.payload, { SMOKE_FILES, chooserWaiters }).catch(e => errors.push(`送真的輸入失敗：${e?.message ?? e}`))
  })
  try {
    await S('Runtime.addBinding', { name: '__smokeInput' })
    await S('Runtime.enable'); await S('Log.enable'); await S('Page.enable')
    const mobile = sc.page.startsWith('m.html')
    await S('Emulation.setDeviceMetricsOverride', { width: scenarioWidth(sc), height: sc.height ?? 800, deviceScaleFactor: 1, mobile })
    await S('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Taipei' })
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })   // 一律減少動態（可重現）
    await S('Page.addScriptToEvaluateOnNewDocument', { source: clockSource(SMOKE_NOW) + '\n' + injectSource(tableAt(sc)) })
    await S('Page.navigate', { url: `${base}/${sc.page}` })
    const expr = mountCheckSource(sc.ready, pathOf(sc.page))
    const evalCheck = async () => { try { return (await evalValue(S, expr)) ?? { ok: false, why: '頁面還沒就緒' } } catch { return { ok: false, why: '頁面還沒就緒' } } }
    const deadline = Date.now() + opts.timeoutMs
    let check = await evalCheck()
    while (!check.ok && Date.now() < deadline) { await sleep(200); check = await evalCheck() }
    if (check.ok) { await sleep(1000); check = await evalCheck() }
    const res = { problems: [], png: null, lines: null, cjk: null, notes: [] }
    if (!check.ok) { res.problems.push(`沒有掛上：${check.why}`); return res }
    let probeWhy = ''
    if (sc.probe) {
      try { const v = await evalValue(S, probeSource(sc.probe), true); if (!v?.ok) probeWhy = v?.why || '沒有回結果' } catch (e) { probeWhy = `執行失敗：${e.message}` }
    }
    if (!probeWhy && sc.widen) {
      try {
        await S('Emulation.setDeviceMetricsOverride', { width: sc.widen, height: sc.height ?? 800, deviceScaleFactor: 1, mobile: false })
        const v = await evalValue(S, mpaneWidenProbeSource(), true)
        if (!v?.ok) probeWhy = v?.why || '放寬後沒有回結果'
      } catch (e) { probeWhy = `放寬後執行失敗：${e.message}` }
      await S('Emulation.setDeviceMetricsOverride', { width: scenarioWidth(sc), height: sc.height ?? 800, deviceScaleFactor: 1, mobile: false })
      await sleep(300)
    }
    if (probeWhy) res.notes.push(`${probeKind(sc.probe)}：${probeWhy}`)
    if (probeWhy && sc.probe?.setPage) res.problems.push(`設定頁沒有畫出來（${probeWhy}）`)   // 基準與新版同樣畫不出來也不能算「一致」（R9 假綠）
    try { const v = await evalValue(S, pagerSettleSource(), true); if (!v?.ok) res.notes.push(`截圖前：${v?.why || '等滑頁停下來時沒有回結果'}`) } catch (e) { res.notes.push(`截圖前：${e.message}`) }
    const fz = await evalValue(S, freezeSource(), true)
    if (fz?.dpr !== 1 || (fz?.scale ?? 1) !== 1) res.notes.push(`縮放不是 1（dpr ${fz?.dpr}、scale ${fz?.scale}）`)
    if (wantCjk) res.cjk = cjkVerdict(await evalValue(S, cjkProbeSource()))
    res.lines = await evalValue(S, snapshotSource())
    res.png = Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64')
    if (errors.length) res.notes.push(`頁面錯誤 ${errors.length} 筆：${errors[0].slice(0, 100)}`)
    return res
  } finally {
    off()
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

const rows = []
const t0 = Date.now()
let cjk = null
try {
  await Promise.all(servers.map(s => new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', r) })))
  const bases = servers.map(s => `http://127.0.0.1:${s.address().port}`)
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-shots-'))
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--force-device-scale-factor=1', '--font-render-hinting=none', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let browserErr = ''
  child.stderr?.on('data', d => { browserErr = (browserErr + d).slice(-2000) })
  child.on('error', e => fatal(`瀏覽器啟動失敗：${e.message}`))
  console.log(`畫面截圖比對：瀏覽器 ${browserPath}（PID ${child.pid}）；情境 ${scenarios.length} 個；輸出 ${out}`)
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 400 && !fs.existsSync(portFile) && child.exitCode === null && child.signalCode === null; i++) await sleep(150)
  if (!fs.existsSync(portFile)) throw new Error(`瀏覽器沒有開出偵錯連線（結束碼 ${child.exitCode}、訊號 ${child.signalCode}）${browserErr ? `：${browserErr.slice(-500)}` : ''}`)
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)
  const cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`)
  const save = (side, name, r) => {
    fs.mkdirSync(path.join(out, side), { recursive: true })
    if (r.png) fs.writeFileSync(path.join(out, side, `${name}.png`), r.png)
    if (r.lines) fs.writeFileSync(path.join(out, side, `${name}.txt`), r.lines.join('\n') + '\n')
  }
  let next = 0, done = 0
  const rowAt = new Array(scenarios.length)
  const work = async () => {
   for (let i = next++; i < scenarios.length; i = next++) {
    const sc = scenarios[i]
    const ts = Date.now()
    const row = { name: sc.name, page: sc.page.split('?')[0], width: scenarioWidth(sc), skin: scenarioSkin(sc) }
    try {
      // 基準與新版一個接一個跑（同時開兩頁會讓靠計時器的探測讀到不同時間點的畫面，同一份程式碼也會誤報差異）
      const a = await runShot(cdp, sc, bases[0], { wantCjk: !cjk })
      const b = await runShot(cdp, sc, bases[1])
      save('base', sc.name, a); save('new', sc.name, b)
      if (a.cjk) cjk = a.cjk
      const errs = [...a.problems.map(p => `基準 ${p}`), ...b.problems.map(p => `新版 ${p}`)]
      if (errs.length) row.error = errs.join('；')
      else {
        const sd = diffLines(a.lines, b.lines)
        row.structDiff = sd.removed.length + sd.added.length
        const ia = decodePng(a.png), ib = decodePng(b.png)
        row.pixel = compareImages(ia, ib, { colorTolerance: opts.colorTolerance })
        if (isMonochrome(ia) || isMonochrome(ib)) row.blank = true   // 空白頁不能算通過（R9）
        const notesA = a.notes.join('、'), notesB = b.notes.join('、')
        if (notesA || notesB) row.note = notesA === notesB ? notesB : `基準：${notesA || '無'}／新版：${notesB || '無'}`
        if (rowStatus(row, { pixelTolerance: opts.pixelTolerance }) !== 'ok') {
          fs.mkdirSync(path.join(out, 'diff'), { recursive: true })
          if (sd.text) fs.writeFileSync(path.join(out, 'diff', `${sc.name}.struct.diff`), sd.text)
          const d = row.pixel.diffImage ?? { width: ia.width, height: ia.height, data: new Uint8Array(ia.width * ia.height * 4).fill(128) }
          fs.writeFileSync(path.join(out, 'diff', `${sc.name}.png`), encodePng(d))
          fs.writeFileSync(path.join(out, 'diff', `${sc.name}.side.png`), encodePng(sideBySide([ia, ib, d])))
        }
        delete row.pixel.diffImage
      }
    } catch (e) { row.error = `測試程序出錯：${e.message}` }
    rowAt[i] = row
    const st = rowStatus(row, { pixelTolerance: opts.pixelTolerance })
    console.log(`${st === 'ok' ? '✓' : '✗'} [${++done}/${scenarios.length}] ${sc.name} 結構 ${row.structDiff ?? '—'} 像素 ${row.pixel ? (row.pixel.ratio * 100).toFixed(3) + '%' : '—'}${st === 'ok' ? '' : ` ${st}`} ${((Date.now() - ts) / 1000).toFixed(1)}s`)
   }
  }
  await Promise.all(Array.from({ length: Math.min(opts.jobs, scenarios.length) }, work))
  rows.push(...rowAt)
  cdp.close()
} catch (e) {
  console.error(`畫面截圖比對出錯：${e.message}`)
  rows.push({ name: '(整體)', page: '', width: 0, skin: '', error: e.message })
} finally {
  cleanup()
}

const seconds = Math.round((Date.now() - t0) / 1000)
const cov = coverage(scenarios)
const excluded = opts.includeUnstable ? [] : Object.entries(UNSTABLE_SCENARIOS).filter(([n]) => SCENARIOS.some(s => s.name === n && s.shot && (!opts.only.length || opts.only.some(f => n.includes(f)))))
const meta = { ...baseMeta, browser: browserPath, seconds, excluded }
// 中文字檢查一次都沒量到（第一個情境沒掛上、基準側出錯…）：不能當作通過，否則沒有 CJK 字型時全是方框也「一致」
if (!cjk && !rows.some(r => r.name === '(整體)') && scenarios.length) cjk = { ok: false, missing: true, why: '中文字檢查一次都沒量到（情境沒有掛上或基準側出錯）' }
const broken = toolBroken({ rows, meta, cjk })
writeReport(formatReport({ rows, meta, cjk, coverageMissing: cov.missing, opts }))
const failed = strictFailed({ rows, cjk, opts, countMismatch: rows.length !== scenarios.length && !rows.some(r => r.name === '(整體)') })
console.log(`畫面截圖比對：${rows.length} 個情境、耗時 ${seconds} 秒、報告 ${path.join(out, 'report.md')}${cjk && !cjk.ok ? `\n🔴 中文字檢查失敗：${cjk.why}` : ''}`)
if (broken) console.log(`::warning::畫面截圖比對工具自己壞了：${broken}`)
process.exit(broken ? 3 : opts.strict && failed ? 1 : 0)
