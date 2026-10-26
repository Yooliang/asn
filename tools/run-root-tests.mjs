// 跑根目錄 tests/*.test.mjs：一支一支跑、每支各自逾時（#284）。
// 為什麼不直接 `node --test tests/*.test.mjs`：整批一次丟出去，其中一支卡住（沒關假後台、連不到資料庫…）整批就掛著不動，也看不出是哪一支；
// 而 `--test-force-exit` 在 Windows 結束時會觸發 libuv 斷言崩潰，造成假的「取消」，所以這裡不用它。
// 用法：node tools/run-root-tests.mjs [檔名片段…] [--timeout=秒]   例：node tools/run-root-tests.mjs tenants roadmap --timeout=30
// 結束碼：全過 0；有失敗或逾時 1。逾時的會單獨列出來（不算通過）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 參數 → { filters, timeoutSec }；--timeout 不是正整數就用預設 60 */
export function parseArgs(argv) {
  const filters = []
  let timeoutSec = 60
  for (const a of argv) {
    const m = /^--timeout=(.*)$/.exec(a)
    if (m) { const n = Number(m[1]); if (Number.isInteger(n) && n > 0) timeoutSec = n; continue }
    if (!a.startsWith('--')) filters.push(a.toLowerCase())
  }
  return { filters, timeoutSec }
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

function main() {
  const { filters, timeoutSec } = parseArgs(process.argv.slice(2))
  const files = pickFiles(fs.readdirSync(path.join(root, 'tests')), filters)
  if (!files.length) { console.error('沒有符合的測試檔'); process.exit(1) }
  const res = { passed: [], failed: [], timeout: [] }
  for (const f of files) {
    const t0 = Date.now()
    const r = spawnSync(process.execPath, ['--test', `--test-timeout=${timeoutSec * 1000}`, path.join('tests', f)], { cwd: root, encoding: 'utf8', timeout: (timeoutSec + 10) * 1000, killSignal: 'SIGKILL' })
    const kind = classify({ ...r, signal: r.signal === 'SIGKILL' ? 'SIGTERM' : r.signal })
    res[kind].push(f)
    console.log(`${kind === 'passed' ? '過' : kind === 'timeout' ? '逾時' : '失敗'}  ${f}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    if (kind !== 'passed') console.log(((r.stdout ?? '') + (r.stderr ?? '')).split('\n').filter(l => /not ok|ℹ (pass|fail)|Error|error/.test(l)).slice(0, 12).map(l => '    ' + l).join('\n'))
  }
  console.log(`\n共 ${files.length} 支：過 ${res.passed.length}、失敗 ${res.failed.length}、逾時 ${res.timeout.length}`)
  if (res.failed.length) console.log('失敗：' + res.failed.join('、'))
  if (res.timeout.length) console.log('逾時：' + res.timeout.join('、'))
  process.exit(res.failed.length || res.timeout.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
