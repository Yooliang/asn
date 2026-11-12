// 跑根目錄 tests/*.test.mjs：每支測試檔一個獨立程序、各自逾時（#284），多支並行（#1383）。
// 為什麼不直接 `node --test tests/*.test.mjs`：整批一次丟出去，其中一支卡住（沒關假後台、連不到資料庫…）整批就掛著不動，也看不出是哪一支；
// 而 `--test-force-exit` 在 Windows 結束時會觸發 libuv 斷言崩潰，造成假的「取消」，所以這裡不用它。
// 用法：node tools/run-root-tests.mjs [檔名片段…] [--timeout=秒] [--jobs=並行數]   例：node tools/run-root-tests.mjs tenants roadmap --timeout=30
// 並行數：--jobs=N ＞ 環境變數 ROOT_TESTS_JOBS ＞ CPU 數（os.availableParallelism()）。--jobs=1 就是一支一支跑。
// 每支各給一個自己的暫存目錄（TMPDIR／TEMP／TMP 指過去），跑完刪掉；測試檔彼此不共用暫存位置。
// 輸出：每支開始印一行「開始」，結束時把該支的結果與（失敗時的）輸出一次印成一組，並行時不會交錯。
// 結束碼：全過 0；有失敗或逾時 1。逾時的會單獨列出來（不算通過）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 正整數字串 → 數字，否則 null */
function posInt(s) {
  const n = Number(s)
  return s !== '' && s != null && Number.isInteger(n) && n > 0 ? n : null
}

/** 參數 → { filters, timeoutSec, requirePglite, jobs }；--timeout 不是正整數就用預設 60；--jobs 不是正整數就當沒給（null）；
 *  --require-pglite＝pglite 載不到就整批不跑、直接失敗，且任何子測試因為 pglite 被略過也算失敗（CI 用，見 asn-linux-build.yml）。
 *  只看「因為 pglite」的略過：tenants_sql 有 3 項因舊 irori 額度邏輯而固定略過，跟 pglite 無關，不算。 */
export function parseArgs(argv) {
  const filters = []
  let timeoutSec = 60
  let requirePglite = false
  let jobs = null
  for (const a of argv) {
    const m = /^--timeout=(.*)$/.exec(a)
    if (m) { const n = posInt(m[1]); if (n) timeoutSec = n; continue }
    const j = /^--jobs=(.*)$/.exec(a)
    if (j) { jobs = posInt(j[1]); continue }
    if (a === '--require-pglite') { requirePglite = true; continue }
    if (!a.startsWith('--')) filters.push(a.toLowerCase())
  }
  return { filters, timeoutSec, requirePglite, jobs }
}

/** 並行數：參數 ＞ 環境變數 ROOT_TESTS_JOBS ＞ CPU 數；壞值略過；至少 1 */
export function resolveJobs(argJobs, env = process.env, cpus = availableCpus()) {
  return argJobs ?? posInt(env.ROOT_TESTS_JOBS) ?? Math.max(1, cpus | 0)
}

function availableCpus() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
}

/** node --test 輸出裡「因為 pglite 而略過」的子測試那幾行（tap：「ok N - 名稱 # SKIP 原因」；spec：「﹣ 名稱 … # 原因」），原因提到 pglite 才算 */
export function pgliteSkips(out) {
  return String(out ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => (/^ok \d+ - .*# SKIP\b/.test(l) || /^﹣ /.test(l)) && /pglite/i.test(l.slice(l.lastIndexOf('#'))))
}

/** tests/ 底下的 *.test.mjs（排序固定）；有篩選字就只留檔名含任一個的 */
export function pickFiles(names, filters = []) {
  return names.filter(f => f.endsWith('.test.mjs')).sort().filter(f => !filters.length || filters.some(k => f.toLowerCase().includes(k)))
}

/** 開跑順序：檔案大的先跑（測試項目多、通常跑得久），免得最慢那支最後才開始、拖長整體時間；同大小照檔名 */
export function scheduleOrder(files, sizeOf) {
  return files.map(f => [f, sizeOf(f)]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([f]) => f)
}

/** 一支的結果：passed／failed／timeout */
export function classify(r) {
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') return 'timeout'
  return r.status === 0 ? 'passed' : 'failed'
}

/** 失敗時要印的輸出：先挑 not ok／統計／Error 那幾行（最多 12 行）；一行都沒挑到就印最後 20 行，不讓失敗原因整個消失 */
export function failureExcerpt(out) {
  const lines = String(out ?? '').split(/\r?\n/)
  const picked = lines.filter(l => /not ok|ℹ (pass|fail)|Error|error/.test(l)).slice(0, 12)
  return picked.length ? picked : lines.filter(l => l.trim()).slice(-20)
}

/** 收掉整個程序樹：測試檔可能生孫程序（假後台、資料庫），只殺直接子程序的話孫程序還握著 stdout 管線，執行器就等不到結束（#1379）。
 *  Linux／macOS：子程序是自己的程序群組領頭（detached），對 -pid 發 SIGKILL；Windows：taskkill /PID <pid> /T /F（只針對這個 pid，不依名稱殺）。 */
export function killTree(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(-child.pid, 'SIGKILL')
  } catch { try { child.kill('SIGKILL') } catch { /* 已經結束 */ } }
}

/** 跑一支測試檔，回傳 { status, signal, stdout, stderr, error? }。
 *  逾時（timeoutSec + 寬限秒數，給 --test-timeout 先開口）＝收整個程序樹、不等 stdio 關閉、直接回 timeout；計時器一開始就啟動。 */
export function runOne(file, timeoutSec, { args = ['--test', `--test-timeout=${timeoutSec * 1000}`], graceSec = 10, cwd = root, env = process.env } = {}) {
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let done = false
    let timer
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout: out, stderr: err, ...r }) }
    const child = spawn(process.execPath, [...args, file], { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', d => { out += d })
    child.stderr.setEncoding('utf8').on('data', d => { err += d })
    // 'exit' 之後只再等一下讓輸出收完就結算，不等 'close'：孫程序握著管線時 close 可能永遠不來
    child.on('exit', (status, signal) => {
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch { /* 群組已空 */ } } // 正常結束也順手收掉遺留的孫程序
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish({ status, signal }) }, 300)
    })
    child.on('error', error => finish({ status: null, error }))
    timer = setTimeout(() => {
      killTree(child)
      child.stdout.destroy(); child.stderr.destroy()
      finish({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } })
    }, (timeoutSec + graceSec) * 1000)
  })
}

/** 這支測試自己的暫存目錄：TMPDIR（Linux／macOS）、TEMP／TMP（Windows）都指過去，os.tmpdir() 就會落在這裡 */
function isolatedEnv(file, baseEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `asn-rrt-${path.basename(file).replace(/\W+/g, '_').slice(0, 40)}-`))
  return { tmp, env: { ...baseEnv, TMPDIR: tmp, TEMP: tmp, TMP: tmp } }
}

function removeQuietly(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows 上偶爾還被佔用，留給系統清 */ }
}

/** 一支結束後要印的那一組文字（一次印出，並行時不會跟別支交錯） */
export function formatResult(f, kind, secs, r, pskips = []) {
  const skipNote = pskips.length ? `，因 pglite 略過 ${pskips.length} 項` : ''
  const label = kind === 'passed' ? '過' : kind === 'timeout' ? '逾時' : '失敗'
  const lines = [`${label}  ${f}  (${secs.toFixed(1)}s${skipNote})`]
  if (pskips.length) lines.push(...pskips.slice(0, 12).map(l => '    ' + l))
  if (kind !== 'passed') {
    lines.push(`  ┌─ ${f} 的輸出（節錄）`)
    lines.push(...failureExcerpt((r.stdout ?? '') + (r.stderr ?? '')).map(l => '  │ ' + l))
    lines.push(`  └─ ${f}`)
  }
  return lines.join('\n')
}

/** 跑一批測試檔，最多 jobs 支同時跑。回傳 { res: {passed, failed, timeout}, times: [[檔名, 秒]], code }。
 *  dir：測試檔所在目錄（相對 cwd）；log：印一整組文字的函式；runArgs：交給 runOne 的 node 參數（測試用）。 */
export async function runAll(files, { jobs = 1, timeoutSec = 60, requirePglite = false, cwd = root, dir = 'tests', log = s => console.log(s), runArgs, graceSec, baseEnv = process.env } = {}) {
  const res = { passed: [], failed: [], timeout: [] }
  const times = []
  const queue = [...files]
  const worker = async () => {
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      log(`開始  ${f}`)
      const t0 = Date.now()
      const { tmp, env } = isolatedEnv(f, baseEnv)
      let r
      try {
        r = await runOne(path.join(dir, f), timeoutSec, { cwd, env, ...(runArgs ? { args: runArgs } : {}), ...(graceSec != null ? { graceSec } : {}) })
      } finally { removeQuietly(tmp) }
      let kind = classify(r)
      const pskips = requirePglite && kind === 'passed' ? pgliteSkips((r.stdout ?? '') + (r.stderr ?? '')) : []
      if (pskips.length) kind = 'failed'
      const secs = (Date.now() - t0) / 1000
      res[kind].push(f)
      times.push([f, secs])
      log(formatResult(f, kind, secs, r, pskips))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, files.length)) }, worker))
  return { res, times, code: res.failed.length || res.timeout.length ? 1 : 0 }
}

async function main() {
  const { filters, timeoutSec, requirePglite, jobs: argJobs } = parseArgs(process.argv.slice(2))
  if (requirePglite) {
    try { await import('@electric-sql/pglite') } catch (e) { console.error(`--require-pglite：載不到 @electric-sql/pglite（${e.code ?? e.message}），不跑`); process.exit(1) }
  }
  const testsDir = path.join(root, 'tests')
  const files = pickFiles(fs.readdirSync(testsDir), filters)
  if (!files.length) { console.error('沒有符合的測試檔'); process.exit(1) }
  const jobs = resolveJobs(argJobs)
  console.log(`共 ${files.length} 支，並行 ${jobs} 支（CPU ${availableCpus()}；可用 --jobs=N 或環境變數 ROOT_TESTS_JOBS 改）`)
  const t0 = Date.now()
  const ordered = scheduleOrder(files, f => { try { return fs.statSync(path.join(testsDir, f)).size } catch { return 0 } })
  const { res, times, code } = await runAll(ordered, { jobs, timeoutSec, requirePglite })
  const slow = [...times].sort((a, b) => b[1] - a[1]).slice(0, 10)
  console.log(`\n最慢 ${slow.length} 支：` + slow.map(([f, s]) => `${f} ${s.toFixed(1)}s`).join('、'))
  console.log(`共 ${files.length} 支：過 ${res.passed.length}、失敗 ${res.failed.length}、逾時 ${res.timeout.length}；總耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s（並行 ${jobs}）`)
  if (res.failed.length) console.log('失敗：' + res.failed.sort().join('、'))
  if (res.timeout.length) console.log('逾時：' + res.timeout.sort().join('、'))
  process.exit(code)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
