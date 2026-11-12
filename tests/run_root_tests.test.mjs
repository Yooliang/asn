// tools/run-root-tests.mjs 的純邏輯：參數解析、挑檔、結果分類（#284）、因 pglite 而略過的子測試（--require-pglite，CI 守門）。不真的跑別支測試。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classify, parseArgs, pickFiles, pgliteSkips, runOne } from '../tools/run-root-tests.mjs'

test('參數：預設 60 秒；--timeout 要正整數，壞的用預設；其餘當檔名篩選字（小寫）', () => {
  assert.deepEqual(parseArgs([]), { filters: [], timeoutSec: 60, requirePglite: false })
  assert.deepEqual(parseArgs(['Tenants', '--timeout=30', 'roadmap']), { filters: ['tenants', 'roadmap'], timeoutSec: 30, requirePglite: false })
  assert.deepEqual(parseArgs(['_sql', '--require-pglite', '--timeout=180']), { filters: ['_sql'], timeoutSec: 180, requirePglite: true })
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
