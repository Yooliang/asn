// 啟動冒煙測試：用系統已裝的 Chrome／Edge 無頭模式，把 ui/ 每個入口頁真的載起來（假 Tauri），
// 等 Vue 掛上，收集 console 錯誤與未捕捉例外；任何一頁出錯或沒掛上就失敗（結束碼 1），並印出是哪一頁、錯誤原文。
//   npm run smoke:ui                       全部情境
//   npm run smoke:ui -- --only m-signed-in  只跑指定情境（逗號分隔）
//   --timeout 毫秒（每頁等掛上的上限，預設 15000）、--browser 路徑、--verbose（印被拒絕的未註冊指令）
// 只用 --headless；不下載瀏覽器；伺服器只綁 127.0.0.1。瀏覽器程序只關自己記下 PID 的那一棵。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findBrowser, injectSource, mountCheckSource, probeKind, probeSource, parseSmokeArgs, pathOf, selectScenarios, shotPath, tableFor } from './smoke-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ui = path.join(root, 'ui')
const fatal = m => { console.error(`冒煙測試無法執行：${m}`); process.exit(2) }

let opts, scenarios, browserPath
try { opts = parseSmokeArgs(process.argv.slice(2)); scenarios = selectScenarios(opts.only); browserPath = findBrowser({ explicit: opts.browser }) } catch (e) { fatal(e.message) }

// ui/vendor 由 prep 產生（vue、DiceBear、更新記錄）；沒有就先產生，產不出來就清楚報錯
if (!fs.existsSync(path.join(ui, 'vendor', 'vue.global.prod.js'))) {
  console.log('ui/vendor 不存在，先執行 scripts/prep.mjs 產生…')
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'prep.mjs')], { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) fatal('ui/vendor 產生失敗（多半是還沒 npm install）')
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const f = path.join(ui, decodeURIComponent(u.pathname))
  if (!f.startsWith(ui) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': `${MIME[path.extname(f)] ?? 'application/octet-stream'}; charset=utf-8` })
  res.end(fs.readFileSync(f))
})

let child = null
let profile = ''
const killTree = pid => {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* 已結束 */ } }
}
let cleaned = false
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

// ---- 最小的 DevTools 連線 ----
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
    on: h => handlers.add(h),
    close: () => { try { ws.close() } catch { /* 已關 */ } },
  })
})

const argText = a => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type)

async function runScenario(cdp, sc, base) {
  const errors = []
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  cdp.on(d => {
    if (d.sessionId !== sessionId) return
    if (d.method === 'Runtime.exceptionThrown') { const x = d.params.exceptionDetails; errors.push(`未捕捉例外：${x.exception?.description ?? x.text}`) }
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(`console.error：${d.params.args.map(argText).join(' ')}`)
    else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(`瀏覽器錯誤：${d.params.entry.text} ${d.params.entry.url ?? ''}`.trim())
  })
  await S('Runtime.enable'); await S('Log.enable'); await S('Page.enable')
  await S('Emulation.setDeviceMetricsOverride', { width: sc.page.startsWith('m.html') ? 412 : 1100, height: 800, deviceScaleFactor: 1, mobile: sc.page.startsWith('m.html') })
  await S('Page.addScriptToEvaluateOnNewDocument', { source: injectSource(tableFor(sc)) })
  await S('Page.navigate', { url: `${base}/${sc.page}` })
  const expr = mountCheckSource(sc.ready, pathOf(sc.page))
  const evalCheck = async () => { try { return (await S('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value ?? { ok: false, why: '頁面還沒就緒' } } catch { return { ok: false, why: '頁面還沒就緒' } } }
  const deadline = Date.now() + opts.timeoutMs
  let check = await evalCheck()
  while (!check.ok && Date.now() < deadline) { await sleep(200); check = await evalCheck() }
  if (check.ok) { await sleep(1000); check = await evalCheck() }   // 掛上後再等一下，讓首次渲染與啟動後的非同步例外跑完
  let probeWhy = ''
  if (check.ok && sc.probe) {
    try { const v = (await S('Runtime.evaluate', { expression: probeSource(sc.probe), awaitPromise: true, returnByValue: true })).result.value; if (!v?.ok) probeWhy = v?.why || '沒有回結果' } catch (e) { probeWhy = `執行失敗：${e.message}` }
  }
  // 情境帶 shot（#374）：探測完存一張截圖（ASN_SMOKE_SHOTS 指定的資料夾，沒指定放暫存資料夾）；存不了只記一筆，不算失敗
  let shot = ''
  if (check.ok && sc.shot) {
    try {
      const { data } = await S('Page.captureScreenshot', { format: 'png' })
      shot = shotPath(sc.shot)
      fs.mkdirSync(path.dirname(shot), { recursive: true })
      fs.writeFileSync(shot, Buffer.from(data, 'base64'))
    } catch (e) { shot = ''; console.log(`    截圖存不了：${e.message}`) }
  }
  let missing = []
  try { missing = (await S('Runtime.evaluate', { expression: 'globalThis.__smokeMissing || []', returnByValue: true })).result.value ?? [] } catch { /* 頁面已離開 */ }
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  const problems = [...errors]
  if (!check.ok) problems.unshift(`沒有掛上：${check.why}`)
  if (probeWhy) problems.push(`${probeKind(sc.probe)}：${probeWhy}`)
  return { problems, missing, shot }
}

let failed = 0
try {
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r) })
  const base = `http://127.0.0.1:${server.address().port}`
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-smoke-'))
  child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true })
  child.on('error', e => fatal(`瀏覽器啟動失敗：${e.message}`))
  console.log(`冒煙測試：瀏覽器 ${browserPath}（PID ${child.pid}），伺服器 ${base}`)
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(150)
  if (!fs.existsSync(portFile)) throw new Error('瀏覽器沒有開出偵錯連線（無頭模式啟動失敗）')
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)
  const cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`)
  for (const sc of scenarios) {
    const t0 = Date.now()
    let r
    try { r = await runScenario(cdp, sc, base) } catch (e) { r = { problems: [`測試程序出錯：${e.message}`], missing: [] } }
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    if (r.problems.length) {
      failed++
      console.error(`✗ ${sc.name}（${sc.page}）失敗 ${sec}s`)
      for (const p of r.problems) console.error(`    ${p}`)
    } else console.log(`✓ ${sc.name}（${sc.page}）${sec}s`)
    if (r.shot) console.log(`    截圖：${r.shot}`)
    if (opts.verbose && r.missing.length) console.log(`    被拒絕的未註冊指令：${[...new Set(r.missing)].join('、')}`)
  }
  cdp.close()
} catch (e) {
  console.error(`冒煙測試出錯：${e.message}`)
  failed = failed || 1
} finally {
  cleanup()
}
console.log(failed ? `冒煙測試失敗：${failed} 個情境有問題` : `冒煙測試通過：${scenarios.length} 個情境`)
process.exit(failed ? 1 : 0)
