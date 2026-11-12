// tools/run-root-tests.mjs：參數解析、挑檔、結果分類（#284）、因 pglite 而略過的子測試（--require-pglite，CI 守門）、逾時收整棵程序樹（#1379）、並行（#1383）。
// 只用暫存目錄裡的假測試檔，不真的跑 tests/ 底下的別支測試。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classify, failureExcerpt, parseArgs, pickFiles, pgliteSkips, resolveJobs, runAll, runOne, scheduleOrder, shardFiles } from '../tools/run-root-tests.mjs'

test('參數：預設 60 秒；--timeout 要正整數，壞的用預設；其餘當檔名篩選字（小寫）', () => {
  assert.deepEqual(parseArgs([]), { filters: [], timeoutSec: 60, requirePglite: false, jobs: null, shard: null })
  assert.deepEqual(parseArgs(['Tenants', '--timeout=30', 'roadmap']), { filters: ['tenants', 'roadmap'], timeoutSec: 30, requirePglite: false, jobs: null, shard: null })
  assert.deepEqual(parseArgs(['_sql', '--require-pglite', '--timeout=180']), { filters: ['_sql'], timeoutSec: 180, requirePglite: true, jobs: null, shard: null })
  for (const bad of ['--timeout=0', '--timeout=-5', '--timeout=abc', '--timeout=1.5', '--timeout=']) assert.equal(parseArgs([bad]).timeoutSec, 60, bad)
  assert.deepEqual(parseArgs(['--unknown']).filters, [], '不認得的旗標不當檔名')
})

test('挑檔：只要 *.test.mjs、排序固定、篩選字比對檔名（不分大小寫）', () => {
  const names = ['b_sql.test.mjs', '_fake_relay.mjs', 'vectors', 'A_roadmap.test.mjs', 'c.test.mjs']
  assert.deepEqual(pickFiles(names), ['A_roadmap.test.mjs', 'b_sql.test.mjs', 'c.test.mjs'])
  assert.deepEqual(pickFiles(names, ['sql']), ['b_sql.test.mjs'])
  assert.deepEqual(pickFiles(names, ['roadmap', 'c.test']), ['A_roadmap.test.mjs', 'c.test.mjs'])
  assert.deepEqual(pickFiles(names, ['沒有']), [])
})

test('結果分類：0 是過、非 0 是失敗、逾時（ETIMEDOUT 或被收掉）單獨一類，不算通過', () => {
  assert.equal(classify({ status: 0 }), 'passed')
  assert.equal(classify({ status: 1 }), 'failed')
  assert.equal(classify({ status: null, error: { code: 'ETIMEDOUT' } }), 'timeout')
  assert.equal(classify({ status: null, signal: 'SIGTERM' }), 'timeout')
  assert.equal(classify({ status: null }), 'failed', '沒有狀態碼也不是通過')
})

test('因 pglite 略過：tap 與 spec 兩種格式都認；原因沒提 pglite 的略過不算（例如 tenants_sql 的舊額度邏輯）', () => {
  const tap = [
    'ok 1 - 靜態：x',
    'ok 2 - 實跑（pglite）：共用案例 # SKIP 沒有安裝 @electric-sql/pglite',
    '    ok 1 - 子項 # SKIP 沒有安裝 @electric-sql/pglite（npm i --no-save @electric-sql/pglite），跳過資料庫測試\r',
    'ok 3 - 新使用者 # SKIP 需要舊 irori 應用的額度邏輯（repo 腳本沒有建立 usage_quota 的列）',
    'ok 4 - 名稱提到 pglite 但沒略過',
    '# skipped 3',
  ].join('\n')
  assert.equal(pgliteSkips(tap).length, 2)
  assert.match(pgliteSkips(tap)[0], /^ok 2 - /)
  const spec = '✔ 靜態 (1ms)\n﹣ 實跑（pglite）：權限 (0.2ms) # 沒有安裝 @electric-sql/pglite\n﹣ 新使用者 (0.1ms) # 需要舊 irori 應用的額度邏輯\nℹ skipped 2\n'
  assert.deepEqual(pgliteSkips(spec), ['﹣ 實跑（pglite）：權限 (0.2ms) # 沒有安裝 @electric-sql/pglite'])
  assert.deepEqual(pgliteSkips('ok 1 - 實跑（pglite）：#524 審查'), [], '沒略過就不算，名稱裡的 # 也不誤判')
  assert.deepEqual(pgliteSkips(undefined), [])
})

// #1379：測試檔生出孫程序、孫程序一直握著 stdout 管線時，逾時要收掉整個程序樹、不等管線關閉，幾秒內回報逾時。
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('逾時：生孫程序又一直佔住 stdout 的測試檔，逾時後數秒內回 timeout、孫程序也被收掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrt-1379-'))
  const pidFile = path.join(dir, 'grandchild.pid')
  const grand = path.join(dir, 'grand.mjs')
  const fake = path.join(dir, 'hang.test.mjs')
  fs.writeFileSync(grand, "setInterval(() => process.stdout.write('x'), 100)")
  fs.writeFileSync(fake, [
    "import { spawn } from 'node:child_process'",
    "import fs from 'node:fs'",
    `const g = spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: 'inherit' })`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))`,
    'setInterval(() => {}, 1000)',
  ].join(String.fromCharCode(10)))
  let gpid
  try {
    const t0 = Date.now()
    const r = await runOne(fake, 1, { args: [], graceSec: 1, cwd: dir })
    const took = Date.now() - t0
    gpid = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.equal(classify(r), 'timeout')
    assert.ok(took < 8000, `逾時後應在數秒內結束，實際 ${took}ms`)
    await sleep(500)
    assert.equal(alive(gpid), false, '孫程序要一起被收掉')
  } finally {
    if (gpid && alive(gpid)) { try { process.kill(gpid, 'SIGKILL') } catch { /* 已結束 */ } }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('正常結束：一般測試檔照舊回結果與輸出；失敗的回非 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrt-1379-'))
  try {
    const ok = path.join(dir, 'ok.mjs')
    const bad = path.join(dir, 'bad.mjs')
    fs.writeFileSync(ok, "console.log('hello')")
    fs.writeFileSync(bad, 'process.exit(3)')
    const a = await runOne(ok, 5, { args: [], cwd: dir })
    const b = await runOne(bad, 5, { args: [], cwd: dir })
    assert.equal(classify(a), 'passed')
    assert.match(a.stdout, /hello/)
    assert.equal(classify(b), 'failed')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// #1383：多支測試檔並行跑。
test('並行數：--jobs ＞ ROOT_TESTS_JOBS ＞ CPU 數；壞值略過；至少 1', () => {
  assert.equal(parseArgs(['--jobs=3']).jobs, 3)
  for (const bad of ['--jobs=0', '--jobs=-2', '--jobs=x', '--jobs=1.5', '--jobs=']) assert.equal(parseArgs([bad]).jobs, null, bad)
  assert.deepEqual(parseArgs(['--jobs=2', 'sql']).filters, ['sql'], '--jobs 不當檔名')
  assert.equal(resolveJobs(2, { ROOT_TESTS_JOBS: '5' }, 8), 2)
  assert.equal(resolveJobs(null, { ROOT_TESTS_JOBS: '5' }, 8), 5)
  assert.equal(resolveJobs(null, { ROOT_TESTS_JOBS: 'abc' }, 8), 8)
  assert.equal(resolveJobs(null, { ROOT_TESTS_JOBS: '0' }, 8), 8)
  assert.equal(resolveJobs(null, {}, 4), 4)
  assert.equal(resolveJobs(null, {}, 0), 1)
})

test('開跑順序：大檔先跑，同大小照檔名', () => {
  const size = { 'a.test.mjs': 10, 'b.test.mjs': 300, 'c.test.mjs': 10, 'd.test.mjs': 50 }
  assert.deepEqual(scheduleOrder(Object.keys(size), f => size[f]), ['b.test.mjs', 'd.test.mjs', 'a.test.mjs', 'c.test.mjs'])
})

test('失敗輸出節錄：挑 not ok／Error 行；挑不到就給最後 20 行', () => {
  assert.deepEqual(failureExcerpt('x\nnot ok 1 - a\ny\nError: boom\n'), ['not ok 1 - a', 'Error: boom'])
  const plain = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
  assert.deepEqual(failureExcerpt(plain), Array.from({ length: 20 }, (_, i) => `line${i + 10}`))
})

/** 在暫存目錄寫假測試檔（直接用 node 跑，不經 --test），回傳目錄 */
function fakeDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrt-1383-'))
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

// 每支：在 marks/ 放一個自己的記號 → 等 ms → 印出當下同時在跑幾支 → 拿掉記號 → 以失敗退出（失敗才會印輸出，順便驗失敗輸出有印）
const overlapProbe = (marks, ms) => [
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  `const marks = ${JSON.stringify(marks)}`,
  'const me = path.join(marks, String(process.pid))',
  "fs.writeFileSync(me, '')",
  `await new Promise(r => setTimeout(r, ${ms}))`,
  "console.log('peak=' + fs.readdirSync(marks).length)",
  'fs.rmSync(me)',
  'process.exit(1)',
].join('\n')

test('並行：同時在跑的支數不超過 jobs；jobs=2 時真的有兩支一起跑；jobs=1 就一支一支', async () => {
  const dir = fakeDir()
  const marks = path.join(dir, 'marks')
  fs.mkdirSync(marks)
  const files = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs']
  for (const f of files) fs.writeFileSync(path.join(dir, f), overlapProbe(marks, 1500))
  try {
    for (const jobs of [1, 2]) {
      const out = []
      const { code, res } = await runAll(files, { jobs, timeoutSec: 30, cwd: dir, dir: '.', runArgs: [], log: s => out.push(s) })
      assert.equal(code, 1)
      assert.equal(res.failed.length, 3)
      assert.equal(out.filter(s => s.startsWith('開始')).length, 3)
      const peaks = (out.join('\n').match(/peak=\d+/g) ?? []).map(s => Number(s.slice(5)))
      assert.equal(peaks.length, 3, out.join('\n'))
      assert.ok(Math.max(...peaks) <= jobs, `jobs=${jobs} 卻同時跑了 ${Math.max(...peaks)} 支`)
      if (jobs === 2) assert.equal(Math.max(...peaks), 2, 'jobs=2 應該真的有兩支同時跑')
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('並行：任一支失敗結束碼就非 0；失敗那支的輸出整組印在一起，不跟別支交錯', async () => {
  // 兩支失敗的同時跑、輸出時間上交錯；印出來要各自成組
  const chatty = tag => `for (let i = 1; i <= 5; i++) { console.log('not ok ${tag}-' + i); await new Promise(r => setTimeout(r, 120)) }\nprocess.exit(1)`
  const dir = fakeDir({ 'x.test.mjs': chatty('X'), 'y.test.mjs': chatty('Y'), 'ok.test.mjs': "console.log('fine')" })
  try {
    const out = []
    const { code, res } = await runAll(['x.test.mjs', 'y.test.mjs', 'ok.test.mjs'], { jobs: 3, timeoutSec: 30, cwd: dir, dir: '.', runArgs: [], log: s => out.push(s) })
    assert.equal(code, 1)
    assert.deepEqual([...res.failed].sort(), ['x.test.mjs', 'y.test.mjs'])
    assert.deepEqual(res.passed, ['ok.test.mjs'])
    for (const tag of ['X', 'Y']) {
      const block = out.find(s => s.startsWith(`失敗  ${tag.toLowerCase()}.test.mjs`))
      assert.ok(block, `要有 ${tag} 的失敗區塊`)
      const mine = block.split('\n').filter(l => /not ok [XY]-/.test(l)).map(l => l.replace(/^\s*│ /, ''))
      assert.deepEqual(mine, [1, 2, 3, 4, 5].map(i => `not ok ${tag}-${i}`), '自己的五行都在同一組、沒有別支的')
    }
    assert.ok(out.some(s => s.startsWith('過  ok.test.mjs')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('並行：逾時那支仍收掉整個程序樹，別支照常過', async () => {
  const dir = fakeDir({ 'grand.mjs': "setInterval(() => process.stdout.write('x'), 100)", 'ok.test.mjs': "console.log('fine')" })
  const pidFile = path.join(dir, 'grandchild.pid')
  fs.writeFileSync(path.join(dir, 'hang.test.mjs'), [
    "import { spawn } from 'node:child_process'",
    "import fs from 'node:fs'",
    `const g = spawn(process.execPath, [${JSON.stringify(path.join(dir, 'grand.mjs'))}], { stdio: 'inherit' })`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))`,
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  let gpid
  try {
    const t0 = Date.now()
    const { code, res } = await runAll(['hang.test.mjs', 'ok.test.mjs'], { jobs: 2, timeoutSec: 1, graceSec: 1, cwd: dir, dir: '.', runArgs: [], log: () => {} })
    gpid = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.equal(code, 1)
    assert.deepEqual(res.timeout, ['hang.test.mjs'])
    assert.deepEqual(res.passed, ['ok.test.mjs'])
    assert.ok(Date.now() - t0 < 10000, '逾時後應在數秒內結束')
    await sleep(500)
    assert.equal(alive(gpid), false, '孫程序要一起被收掉')
  } finally {
    if (gpid && alive(gpid)) { try { process.kill(gpid, 'SIGKILL') } catch { /* 已結束 */ } }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('隔離：每支拿到自己的暫存目錄（os.tmpdir() 各不相同），跑完就刪掉', async () => {
  const body = "import os from 'node:os'\nconsole.log('TMP=' + os.tmpdir())\nprocess.exit(1)"
  const dir = fakeDir({ 'a.test.mjs': body, 'b.test.mjs': body })
  try {
    const out = []
    await runAll(['a.test.mjs', 'b.test.mjs'], { jobs: 2, timeoutSec: 30, cwd: dir, dir: '.', runArgs: [], log: s => out.push(s) })
    const tmps = (out.join('\n').match(/TMP=.*$/gm) ?? []).map(s => s.slice(4).trim())
    assert.equal(tmps.length, 2, out.join('\n'))
    assert.notEqual(tmps[0], tmps[1])
    for (const t of tmps) {
      assert.match(path.basename(t), /^asn-rrt-/)
      assert.equal(fs.existsSync(t), false, '跑完要刪掉')
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('共用快取目錄：各支拿到同一個 ROOT_TESTS_SHARED_DIR，整批跑完就刪掉', async () => {
  const body = "console.log('SHARED=' + process.env.ROOT_TESTS_SHARED_DIR)\nprocess.exit(1)"
  const dir = fakeDir({ 'a.test.mjs': body, 'b.test.mjs': body })
  try {
    const out = []
    await runAll(['a.test.mjs', 'b.test.mjs'], { jobs: 2, timeoutSec: 30, cwd: dir, dir: '.', runArgs: [], log: s => out.push(s) })
    const shared = (out.join('\n').match(/SHARED=.*$/gm) ?? []).map(s => s.slice(7).trim())
    assert.equal(shared.length, 2, out.join('\n'))
    assert.equal(shared[0], shared[1])
    assert.match(path.basename(shared[0]), /^asn-rrt-shared-/)
    assert.equal(fs.existsSync(shared[0]), false, '跑完要刪掉')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('分份：--shard=i/n 解析；壞值是 invalid', () => {
  assert.deepEqual(parseArgs(['--shard=1/2']).shard, { index: 1, total: 2 })
  assert.deepEqual(parseArgs(['--shard=3/3']).shard, { index: 3, total: 3 })
  for (const bad of ['--shard=0/2', '--shard=3/2', '--shard=1', '--shard=a/b', '--shard=', '--shard=1/0']) assert.equal(parseArgs([bad]).shard, 'invalid', bad)
})

test('分份：n 份合起來剛好全部、不重複；大小平均；同樣輸入結果固定', () => {
  const size = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`f${String(i).padStart(2, '0')}.test.mjs`, ((i * 37) % 11 + 1) * 100]))
  const files = Object.keys(size)
  const sizeOf = f => size[f]
  for (const total of [1, 2, 3]) {
    const parts = Array.from({ length: total }, (_, i) => shardFiles(files, sizeOf, i + 1, total))
    assert.deepEqual(parts.flat().sort(), [...files].sort(), `total=${total}`)
    const loads = parts.map(p => p.reduce((s, f) => s + sizeOf(f), 0))
    assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...files.map(sizeOf)), `total=${total} 不平均：${loads}`)
    assert.deepEqual(parts, Array.from({ length: total }, (_, i) => shardFiles(files, sizeOf, i + 1, total)))
  }
})
