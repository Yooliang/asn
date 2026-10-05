// 收發室自己更新（self-update.mjs）：只在乾淨、在 main、沒有本機 commit、而且 relay/machine/ 有新版時才 fast-forward；
// 收尾要等轉交中的信送完（或等太久）。git 用假的 run 注入，另有一項用真的暫存 git repo 跑一次完整流程。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkAndUpdate, gitRunner, planUpdate, readyToRestart } from '../self-update.mjs'

const base = { branch: 'main', dirty: false, ahead: 0, behind: 2, changed: ['relay/machine/bridge.mjs'] }

test('planUpdate：在 main、乾淨、沒有本機 commit、relay/machine/ 有變動才更新', () => {
  assert.equal(planUpdate(base).action, 'update')
  assert.equal(planUpdate({ ...base, branch: 'life-sim' }).action, 'skip')
  assert.equal(planUpdate({ ...base, dirty: true }).action, 'skip')
  assert.equal(planUpdate({ ...base, ahead: 1 }).action, 'skip')
  assert.equal(planUpdate({ ...base, behind: 0, changed: [] }).action, 'none')
  // 別的目錄有新 commit、relay/machine/ 沒動：不替開發視窗拉
  assert.equal(planUpdate({ ...base, changed: [] }).action, 'none')
})

// 假 git：照指令回固定輸出，記下呼叫過哪些
function fakeGit(over = {}) {
  const calls = []
  const out = {
    fetch: '', 'rev-parse --abbrev-ref': 'main', status: '', 'rev-list': '0\t2', diff: 'relay/machine/bridge.mjs\nrelay/machine/send.mjs',
    'rev-parse --short': 'abc1234', merge: '', ...over,
  }
  const run = async args => {
    calls.push(args.join(' '))
    const key = args[0] === 'rev-parse' ? `rev-parse ${args[1]}` : args[0]
    const v = out[key]
    return typeof v === 'object' && v !== null ? v : { code: 0, out: v ?? '' }
  }
  return { run, calls }
}

test('checkAndUpdate：有新版就 fast-forward，回報從哪版到哪版、動到哪些檔', async () => {
  const g = fakeGit()
  const r = await checkAndUpdate(g.run)
  assert.equal(r.action, 'updated')
  assert.deepEqual(r.changed, ['relay/machine/bridge.mjs', 'relay/machine/send.mjs'])
  assert.ok(g.calls.some(c => c.startsWith('merge --ff-only')))
})

test('checkAndUpdate：工作樹髒、有本機 commit、不在 main 都不 merge', async () => {
  for (const over of [{ status: ' M relay/machine/bridge.mjs' }, { 'rev-list': '1\t2' }, { 'rev-parse --abbrev-ref': 'feature' }]) {
    const g = fakeGit(over)
    const r = await checkAndUpdate(g.run)
    assert.equal(r.action, 'skip', JSON.stringify(over))
    assert.ok(!g.calls.some(c => c.startsWith('merge')))
  }
})

test('checkAndUpdate：fetch 失敗（沒網路）回 error，不 merge、不丟例外', async () => {
  const g = fakeGit({ fetch: { code: 128, out: '' } })
  const r = await checkAndUpdate(g.run)
  assert.equal(r.action, 'error')
  assert.ok(!g.calls.some(c => c.startsWith('merge')))
})

test('readyToRestart：還有轉交中的信就等；沒有了、或等太久就重啟', () => {
  assert.equal(readyToRestart(['forwarding', 'waiting'], 0, 1000).ok, false)
  assert.equal(readyToRestart(['waiting', 'notified'], 0, 1000).ok, true) // 等回信的會存在 pending.json，重啟後接著等
  assert.equal(readyToRestart(['forwarding'], 0, 5 * 60_000).ok, true)
})

test('真的 git：上游改了 relay/machine/ → 本機 fast-forward；只改別的目錄 → 不動', { skip: !hasGit() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-'))
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  const up = path.join(dir, 'up.git'), dev = path.join(dir, 'dev'), node = path.join(dir, 'node')
  try {
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', up])
    execFileSync('git', ['clone', '-q', up, dev], { stdio: 'ignore' })
    for (const c of [dev]) { git(c, 'config', 'user.email', 't@t'); git(c, 'config', 'user.name', 't'); git(c, 'checkout', '-q', '-b', 'main') }
    fs.mkdirSync(path.join(dev, 'relay', 'machine'), { recursive: true })
    fs.writeFileSync(path.join(dev, 'relay', 'machine', 'bridge.mjs'), 'v1\n')
    git(dev, 'add', '-A'); git(dev, 'commit', '-qm', 'v1'); git(dev, 'push', '-q', 'origin', 'main')
    execFileSync('git', ['clone', '-q', up, node], { stdio: 'ignore' })
    // 上游只改別的目錄：不動
    fs.writeFileSync(path.join(dev, 'README.md'), 'docs\n')
    git(dev, 'add', '-A'); git(dev, 'commit', '-qm', 'docs'); git(dev, 'push', '-q', 'origin', 'main')
    const r1 = await checkAndUpdate(gitRunner(node))
    assert.equal(r1.action, 'none')
    // 上游改了 relay/machine/：拉下來
    fs.writeFileSync(path.join(dev, 'relay', 'machine', 'bridge.mjs'), 'v2\n')
    git(dev, 'add', '-A'); git(dev, 'commit', '-qm', 'v2'); git(dev, 'push', '-q', 'origin', 'main')
    const r2 = await checkAndUpdate(gitRunner(node))
    assert.equal(r2.action, 'updated')
    assert.equal(fs.readFileSync(path.join(node, 'relay', 'machine', 'bridge.mjs'), 'utf8').trim(), 'v2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function hasGit() { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } }

test('orphansOf：上一個橋不在了，父程序是它的才算孤兒；上一個橋還活著就都不碰', async () => {
  const { orphansOf } = await import('../self-update.mjs')
  const table = new Map([[10, { ppid: 1 }], [21, { ppid: 500 }], [22, { ppid: 500 }], [23, { ppid: 21 }], [99, { ppid: 1 }]])
  assert.deepEqual(orphansOf(table, 500, 99), [21, 22]) // 23 是 21 的子程序，砍 21 的整棵樹時一起結束
  assert.deepEqual(orphansOf(new Map([...table, [500, { ppid: 1 }]]), 500, 99), [])
  assert.deepEqual(orphansOf(table, 0, 99), [])
  assert.deepEqual(orphansOf(table, 99, 99), [])
})
