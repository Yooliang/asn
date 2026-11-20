import test from 'node:test'
import assert from 'node:assert/strict'
import { runOnce, toRuns, parseArgs, checkWorktree, WORKFLOWS, REQUIRED_DEPS } from '../../../tools/release/auto_publish.mjs'
import fs from 'node:fs'

const STATE = '/w/state.json'
const LOCK = `${STATE}.lock`
const SECRET = '子程序原文-不可貼群組-ABC123'

// 假環境：檔案、gh、git、子程序、asn-cli 全是假的
function env({ desktopRows = [], linuxRows = [], files = {}, alive = [], gitOver = {}, spawnStatus = 0, ghStatus = 0, noDeps = false } = {}) {
  const fsMap = new Map(Object.entries(files))
  if (!noDeps) for (const p of REQUIRED_DEPS) fsMap.set(p, 'x')
  const calls = { gh: [], git: [], spawn: [], posts: [], logs: [], unlinks: [] }
  const deps = {
    pid: 4242, now: () => Date.parse('2026-11-21T10:00:00Z'),
    gh: (args) => {
      calls.gh.push(args)
      if (ghStatus) return { status: ghStatus, stdout: '', stderr: 'boom' }
      const wf = args[args.indexOf('--workflow') + 1]
      return { status: 0, stdout: JSON.stringify(wf === 'asn-release.yml' ? desktopRows : linuxRows), stderr: '' }
    },
    git: (args) => {
      const k = args.join(' ')
      calls.git.push(k)
      for (const [pat, fn] of Object.entries(gitOver)) if (k.startsWith(pat)) return fn(k)
      return { status: 0, stdout: '', stderr: '' }
    },
    spawn: (bin, args) => { calls.spawn.push([bin, args]); return { status: spawnStatus, stdout: SECRET, stderr: SECRET } },
    asnCli: (args) => { calls.posts.push(args[args.indexOf('--body') + 1]); return { status: 0, stdout: '', stderr: '' } },
    exists: (p) => fsMap.has(p),
    readFile: (p) => { if (!fsMap.has(p)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return fsMap.get(p) },
    writeFile: (p, s) => { fsMap.set(p, s) },
    writeExclusive: (p, s) => { if (fsMap.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); fsMap.set(p, s) },
    unlink: (p) => { calls.unlinks.push(p); fsMap.delete(p) },
    pidAlive: (pid) => alive.includes(pid),
    log: (m) => calls.logs.push(m),
  }
  return { deps, calls, fsMap }
}

const row = (branch, id = 100, over = {}) => ({ databaseId: id, headBranch: branch, status: 'completed', conclusion: 'success', createdAt: '2026-11-21T09:00:00Z', attempt: 1, ...over })
const opts = { state: STATE, room: 'r1', dryRunOnly: false }
const lastState = (fsMap) => JSON.parse(fsMap.get(STATE))

test('全綠：第一輪 dry-run、第二輪正式；電腦版帶 --with-play no 與 --run-id', async () => {
  const e = env({ desktopRows: [row('v0.2.45', 111)] })
  const r1 = await runOnce(opts, e.deps)
  assert.equal(r1.outcome, 'dryRun')
  const a1 = e.calls.spawn[0][1]
  assert.ok(a1.includes('--dry-run'))
  assert.deepEqual(a1.slice(a1.indexOf('--with-play'), a1.indexOf('--with-play') + 2), ['--with-play', 'no'])
  assert.equal(a1[a1.indexOf('--run-id') + 1], '111')
  assert.equal(a1[a1.indexOf('--tag') + 1], 'v0.2.45')
  assert.equal(a1[a1.indexOf('--room') + 1], 'r1')
  const r2 = await runOnce(opts, e.deps)
  assert.equal(r2.outcome, 'publish')
  const a2 = e.calls.spawn[1][1]
  assert.ok(!a2.includes('--dry-run'))
  assert.ok(a2.includes('--with-play'))
  assert.equal(lastState(e.fsMap).done['desktop@0.2.45'].result, 'published')
  assert.equal(e.calls.posts.length, 0)
})

test('Linux：帶 --platform linux 與 linux 標籤，不帶 --with-play', async () => {
  const e = env({
    desktopRows: [row('v0.2.45', 111)], linuxRows: [row('linux-v0.2.45', 222)],
    files: { [STATE]: JSON.stringify({ v: 1, done: { 'desktop@0.2.45': { result: 'published', at: 'x', runId: '111' } }, pending: {}, inflight: null }) },
  })
  await runOnce(opts, e.deps)
  const a = e.calls.spawn[0][1]
  assert.deepEqual(a.slice(a.indexOf('--platform'), a.indexOf('--platform') + 2), ['--platform', 'linux'])
  assert.equal(a[a.indexOf('--tag') + 1], 'linux-v0.2.45')
  assert.equal(a[a.indexOf('--run-id') + 1], '222')
  assert.ok(!a.includes('--with-play'))
})

test('dry-run 失敗：貼一次群組，之後不再跑', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], spawnStatus: 1 })
  const r1 = await runOnce(opts, e.deps)
  assert.equal(r1.outcome, 'dryRun-failed')
  assert.equal(e.calls.posts.length, 1)
  await runOnce(opts, e.deps)
  await runOnce(opts, e.deps)
  assert.equal(e.calls.spawn.length, 1)
  assert.equal(e.calls.posts.length, 1)
})

test('鎖被活著的 pid 佔住：什麼都不做、不呼叫 gh、不動鎖', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: '777' }, alive: [777] })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'locked')
  assert.equal(e.calls.gh.length, 0)
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.fsMap.get(LOCK), '777')
})

test('殘留的鎖（pid 已死）：接手繼續，寫 log，結束後鎖已還', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: '999' }, alive: [] })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun')
  assert.ok(e.calls.logs.some((l) => l.includes('殘留的鎖') && l.includes('999')))
  assert.equal(e.fsMap.has(LOCK), false)
})

const siteDirty = (extra = '') => ({ 'status --porcelain': () => ({ status: 0, stdout: ` M site/public/index.html\n M site/public/update/latest.json\n${extra}`, stderr: '' }) })

test('site 兩個檔跟 origin/main 不一致：停下回報，不跑 local_sign_publish', async () => {
  const e = env({
    desktopRows: [row('v0.2.45')],
    files: { 'site/public/index.html': 'AAA', 'site/public/update/latest.json': 'BBB' },
    gitOver: { ...siteDirty(), 'show origin/main:': () => ({ status: 0, stdout: 'DIFFERENT', stderr: '' }) },
  })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun-failed')
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.calls.posts.length, 1)
  assert.ok(e.calls.posts[0].includes('不一致'))
  assert.ok(!e.calls.git.some((g) => g.startsWith('restore')))
})

test('其他未提交改動：停下回報', async () => {
  const e = env({
    desktopRows: [row('v0.2.45')],
    gitOver: { 'status --porcelain': () => ({ status: 0, stdout: ' M src/foo.js\n', stderr: '' }) },
  })
  await runOnce(opts, e.deps)
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.calls.posts.length, 1)
})

test('site 只有換行不同：restore 之後照常跑', async () => {
  const e = env({
    desktopRows: [row('v0.2.45')],
    files: { 'site/public/index.html': 'a\r\nb\r\n', 'site/public/update/latest.json': '{"x":1}\r\n' },
    gitOver: {
      ...siteDirty(),
      'show origin/main:site/public/index.html': () => ({ status: 0, stdout: 'a\nb\n', stderr: '' }),
      'show origin/main:site/public/update/latest.json': () => ({ status: 0, stdout: '{"x":1}\n', stderr: '' }),
    },
  })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun')
  const iR = e.calls.git.indexOf('restore site')
  const iC = e.calls.git.indexOf('checkout --detach origin/main')
  assert.ok(iR >= 0 && iC > iR)
  assert.equal(e.calls.spawn.length, 1)
})

test('fetch tags 被拒：停下回報，不強蓋、不跑', async () => {
  const e = env({
    desktopRows: [row('v0.2.45')],
    gitOver: { 'fetch --tags': () => ({ status: 1, stdout: '', stderr: '! [rejected] v0.2.1 -> v0.2.1 (would clobber existing tag)' }) },
  })
  await runOnce(opts, e.deps)
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.calls.posts.length, 1)
  assert.ok(e.calls.posts[0].includes('標籤'))
  assert.ok(!e.calls.git.some((g) => g.includes('--force') || g.includes(' -f')))
})

test('子程序輸出原文只進 log，不進群組文字', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], spawnStatus: 3 })
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 1)
  assert.ok(!e.calls.posts[0].includes(SECRET))
  assert.ok(e.calls.logs.some((l) => l.includes(SECRET)))
})

test('每一輪結束鎖都有還（含失敗、gh 失敗、例外）', async () => {
  for (const o of [{ desktopRows: [row('v0.2.45')] }, { desktopRows: [row('v0.2.45')], spawnStatus: 1 }, { ghStatus: 1 }, {}]) {
    const e = env(o)
    await runOnce(opts, e.deps)
    assert.equal(e.fsMap.has(LOCK), false)
  }
  const e = env({ desktopRows: [row('v0.2.45')] })
  e.deps.spawn = () => { throw new Error('爆了') }
  await assert.rejects(runOnce(opts, e.deps))
  assert.equal(e.fsMap.has(LOCK), false)
})

test('--dry-run-only：待正式的不執行', async () => {
  const e = env({ desktopRows: [row('v0.2.45')] })
  const o = { ...opts, dryRunOnly: true }
  await runOnce(o, e.deps)
  const n = e.calls.spawn.length
  const r = await runOnce(o, e.deps)
  assert.equal(r.outcome, 'dry-run-only')
  assert.equal(e.calls.spawn.length, n)
})

test('toRuns：只收符合標籤的；同 runId 取最新 attempt；不用 gh run watch', () => {
  const w = WORKFLOWS[0]
  const runs = toRuns(w.platform, w.re, [
    row('v0.2.45', 1, { attempt: 1, conclusion: 'failure' }),
    row('v0.2.45', 1, { attempt: 2, conclusion: 'success' }),
    row('main', 2),
  ])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].conclusion, 'success')
  assert.equal(runs[0].version, '0.2.45')
})

test('checkWorktree：主 checkout 拒絕、worktree 通過；parseArgs', () => {
  const mk = (a, b) => (args) => ({ status: 0, stdout: args.includes('--absolute-git-dir') ? a : b, stderr: '' })
  assert.equal(checkWorktree(mk('/r/.git', '/r/.git')).ok, false)
  assert.equal(checkWorktree(mk('/r/.git/worktrees/x', '/r/.git')).ok, true)
  assert.equal(parseArgs(['--once', '--interval', '5']).error !== null, true)
  const o = parseArgs(['--once', '--room', 'g', '--state', '/s'])
  assert.deepEqual([o.once, o.room, o.state, o.interval], [true, 'g', '/s', 120])
})

test('#1980 雯 #4536：專用工作樹缺 node_modules（簽章要用）→ 跑之前就停下回報，不等到正式那步才炸', async () => {
  const e = env({ desktopRows: [row('v0.2.45', 111)], noDeps: true })
  const r = await runOnce(opts, e.deps)
  assert.equal(e.calls.spawn.length, 0, '不跑 local_sign_publish')
  assert.ok(e.calls.posts.some(p => /npm ci/.test(p)), `要回報缺相依：${e.calls.posts}`)
  assert.notEqual(r.outcome, 'dryRun')
})

test('#1980 雯 #4536：程式裡不准出現 git clean（junction 會刪到主 checkout 的 node_modules）', () => {
  const src = fs.readFileSync(new URL('../../../tools/release/auto_publish.mjs', import.meta.url), 'utf8')
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  assert.ok(!/['"]clean['"]/.test(code), '不能呼叫 git clean')
})
