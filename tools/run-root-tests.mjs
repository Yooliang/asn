// 跑根目錄 tests/*.test.mjs：一支一支跑、每支各自逾時（#284）。
// 為什麼不直接 `node --test tests/*.test.mjs`：整批一次丟出去，其中一支卡住（沒關假後台、連不到資料庫…）整批就掛著不動，也看不出是哪一支；
// 而 `--test-force-exit` 在 Windows 結束時會觸發 libuv 斷言崩潰，造成假的「取消」，所以這裡不用它。
// 用法：node tools/run-root-tests.mjs [檔名片段…] [--timeout=秒]   例：node tools/run-root-tests.mjs tenants roadmap --timeout=30
// 結束碼：全過 0；有失敗或逾時 1。逾時的會單獨列出來（不算通過）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 參數 → { filters, timeoutSec, requirePglite }；--timeout 不是正整數就用預設 60；
 *  --require-pglite＝pglite 載不到就整批不跑、直接失敗，且任何子測試因為 pglite 被略過也算失敗（CI 用，見 asn-linux-build.yml）。
 *  只看「因為 pglite」的略過：tenants_sql 有 3 項因舊 irori 額度邏輯而固定略過，跟 pglite 無關，不算。 */
export function parseArgs(argv) {
  const filters = []
  let timeoutSec = 60
  let requirePglite = false
  for (const a of argv) {
    const m = /^--timeout=(.*)$/.exec(a)
    if (m) { const n = Number(m[1]); if (Number.isInteger(n) && n > 0) timeoutSec = n; continue }
    if (a === '--require-pglite') { requirePglite = true; continue }
    if (!a.startsWith('--')) filters.push(a.toLowerCase())
  }
  return { filters, timeoutSec, requirePglite }
}

/** node --test 輸出裡「因為 pglite 而略過」的子測試那幾行（tap：「ok N - 名稱 # SKIP 原因」；spec：「﹣ 名稱 … # 原因」），原因提到 pglite 才算 */
export function pgliteSkips(out) {
  return String(out ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => (/^ok \d+ - .*# SKIP\b/.test(l) || /^﹣ /.test(l)) && /pglite/i.test(l.slice(l.lastIndexOf('#'))))
}

/** tests/ 底下的 *.test.mjs（排序固定）；有篩選字就只留檔名含任一個的 */
export function pickFiles(names, filters = []) {
  return names.filter(f => f.endsWith('.test.mjs')).sort().filter(f => !filters.length || filters.some(k => f.toLowerCase().includes(k)))
}

/** 一支的結果：passed／failed／timeout */
export function classify(r) {
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') return 'timeout'
  return r.status === 0 ? 'passed' : 'failed'
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
export function runOne(file, timeoutSec, { args = ['--test', `--test-timeout=${timeoutSec * 1000}`], graceSec = 10, cwd = root } = {}) {
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let done = false
    let timer
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout: out, stderr: err, ...r }) }
    const child = spawn(process.execPath, [...args, file], { cwd, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

async function main() {
  const { filters, timeoutSec, requirePglite } = parseArgs(process.argv.slice(2))
  if (requirePglite) {
    try { await import('@electric-sql/pglite') } catch (e) { console.error(`--require-pglite：載不到 @electric-sql/pglite（${e.code ?? e.message}），不跑`); process.exit(1) }
  }
  const files = pickFiles(fs.readdirSync(path.join(root, 'tests')), filters)
  if (!files.length) { console.error('沒有符合的測試檔'); process.exit(1) }
  const res = { passed: [], failed: [], timeout: [] }
  for (const f of files) {
    console.log(`開始  ${f}`)
    const t0 = Date.now()
    const r = await runOne(path.join('tests', f), timeoutSec)
    let kind = classify(r)
    const pskips = requirePglite ? pgliteSkips((r.stdout ?? '') + (r.stderr ?? '')) : []
    const skipNote = kind === 'passed' && pskips.length ? `，因 pglite 略過 ${pskips.length} 項` : ''
    if (skipNote) kind = 'failed'
    res[kind].push(f)
    console.log(`${kind === 'passed' ? '過' : kind === 'timeout' ? '逾時' : '失敗'}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)}s${skipNote})`)
    if (skipNote) console.log(pskips.slice(0, 12).map(l => '    ' + l).join('\n'))
    if (kind !== 'passed') console.log(((r.stdout ?? '') + (r.stderr ?? '')).split('\n').filter(l => /not ok|ℹ (pass|fail)|Error|error/.test(l)).slice(0, 12).map(l => '    ' + l).join('\n'))
  }
  console.log(`\n共 ${files.length} 支：過 ${res.passed.length}、失敗 ${res.failed.length}、逾時 ${res.timeout.length}`)
  if (res.failed.length) console.log('失敗：' + res.failed.join('、'))
  if (res.timeout.length) console.log('逾時：' + res.timeout.join('、'))
  process.exit(res.failed.length || res.timeout.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
