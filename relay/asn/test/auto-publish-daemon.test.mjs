import test from 'node:test'
import assert from 'node:assert/strict'
import { runOnce, toRuns, parseArgs, checkWorktree, checkStartup, runCommand, realDeps, acquireLock, WORKFLOWS, REQUIRED_DEPS, BLOCKED_NOTICE_MS } from '../../../tools/release/auto_publish.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE = '/w/state.json'
const LOCK = `${STATE}.lock`
const SECRET = '子程序原文-不可貼群組-ABC123'
const T0 = Date.parse('2026-11-21T10:00:00Z')
// 鎖檔內容：pid 換行 時間戳
const lk = (pid, ts = T0 - 60_000) => `${pid}
${ts}`
// 核心現在要求先播種：預設的初始 state 是已播種（0.2.44 以下都算處理過）
const seededState = (extra = {}) => ({ v: 1, done: { 'desktop@0.2.44': { result: 'seeded', at: 'x', runId: null }, 'linux@0.2.44': { result: 'seeded', at: 'x', runId: null } }, pending: {}, inflight: null, seeded: true, seedNoticed: false, pausedNoticed: false, ...extra })

// 假環境：檔案、gh、git、子程序、asn-cli 全是假的
function env({ desktopRows = [], linuxRows = [], files = {}, alive = [], gitOver = {}, spawnStatus = 0, ghStatus = 0, noDeps = false, noState = false } = {}) {
  const fsMap = new Map(Object.entries(files))
  if (!noState && !fsMap.has(STATE)) fsMap.set(STATE, JSON.stringify(seededState()))
  const clock = { t: T0 }
  if (!noDeps) for (const p of REQUIRED_DEPS) fsMap.set(p, 'x')
  const calls = { gh: [], git: [], spawn: [], posts: [], logs: [], unlinks: [], ops: [] }
  const deps = {
    pid: 4242, now: () => clock.t,
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
    writeFile: (p, s) => { calls.ops.push(`write:${p}`); fsMap.set(p, s) },
    rename: (a, b) => { calls.ops.push(`rename:${a}>${b}`); if (!fsMap.has(a)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); fsMap.set(b, fsMap.get(a)); fsMap.delete(a) },
    createLock: (p, s) => { calls.ops.push(`lock:${p}`); if (fsMap.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); fsMap.set(p, s) },
    unlink: (p) => { calls.unlinks.push(p); fsMap.delete(p) },
    pidAlive: (pid) => alive.includes(pid),
    log: (m) => calls.logs.push(m),
  }
  return { deps, calls, fsMap, clock }
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
    files: { [STATE]: JSON.stringify(seededState({ done: { 'desktop@0.2.44': { result: 'seeded' }, 'linux@0.2.44': { result: 'seeded' }, 'desktop@0.2.45': { result: 'published', at: 'x', runId: '111' } } })) },
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
  const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: lk(777) }, alive: [777] })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'locked')
  assert.equal(e.calls.gh.length, 0)
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.fsMap.get(LOCK), lk(777))
})

test('殘留的鎖（pid 已死）：接手繼續，寫 log，結束後鎖已還', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: lk(999) }, alive: [] })
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
  assert.equal(r.outcome, 'prep-failed')
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.calls.posts.length, 1)
  assert.ok(e.calls.posts[0].includes('不一致'))
  assert.equal(lastState(e.fsMap).done['desktop@0.2.45'], undefined, '準備失敗不進 done')
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

// ───────── #1998 二審預審修正 ─────────
const STALE = `${LOCK}.stale-4242`
const HOUR = 3600_000

test('鎖檔是空的、pid 是 NaN、缺時間戳：視為剛建立，不刪、不搶、放棄這一輪', async () => {
  for (const content of ['', 'abc\n123', '777', '\n']) {
    const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: content }, alive: [] })
    const r = await runOnce(opts, e.deps)
    assert.equal(r.outcome, 'locked', JSON.stringify(content))
    assert.equal(e.fsMap.get(LOCK), content, '鎖檔原封不動')
    assert.equal(e.calls.unlinks.length, 0)
    assert.ok(!e.calls.ops.some((o) => o.startsWith(`rename:${LOCK}`)))
    assert.equal(e.calls.gh.length, 0)
  }
})

test('接手殘留鎖只准 rename 搶：先改名成 .stale-<pid>，成功才刪舊鎖、再建自己的鎖', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: lk(999) }, alive: [] })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun')
  const iRen = e.calls.ops.indexOf(`rename:${LOCK}>${STALE}`)
  assert.ok(iRen >= 0, `要用 rename 搶：${e.calls.ops}`)
  assert.equal(e.calls.unlinks[0], STALE, '第一個刪的是改名後的舊鎖，不是直接刪鎖檔')
  assert.ok(e.calls.ops.indexOf(`lock:${LOCK}`, iRen) > iRen, 'rename 之後才建自己的鎖')
})

test('兩個實例同時接手殘留鎖：第二個 rename 失敗，只有一個搶到', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: lk(999) }, alive: [] })
  const realRename = e.deps.rename
  // 模擬對方在我們 rename 之前已經把舊鎖搶走
  e.deps.rename = (a, b) => { e.fsMap.delete(LOCK); return realRename(a, b) }
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'locked')
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.calls.gh.length, 0)
  assert.equal(e.calls.unlinks.length, 0, '搶輸的不刪任何東西')
  assert.ok(!e.fsMap.has(STALE))
})

test('pid 還活著但鎖超過 2 小時：當成殘留接手（pid 可能被重用）', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: lk(777, T0 - 2 * HOUR - 1000) }, alive: [777] })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun')
  assert.ok(e.calls.logs.some((l) => l.includes('殘留的鎖') && l.includes('2 小時')))
  const young = env({ desktopRows: [row('v0.2.45')], files: { [LOCK]: lk(777, T0 - 2 * HOUR + 60_000) }, alive: [777] })
  assert.equal((await runOnce(opts, young.deps)).outcome, 'locked')
})

test('連續被鎖住超過 30 分鐘：只貼一次群組；取到鎖之後清掉計時', async () => {
  const e = env({ files: { [LOCK]: lk(777, T0) }, alive: [777] })
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 0)
  e.clock.t = T0 + BLOCKED_NOTICE_MS - 1000
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 0)
  e.clock.t = T0 + BLOCKED_NOTICE_MS + 1000
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 1)
  assert.ok(e.calls.posts[0].includes('被鎖住超過 30 分鐘'))
  e.clock.t = T0 + BLOCKED_NOTICE_MS + 60_000
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 1)
  e.fsMap.delete(LOCK)
  await runOnce(opts, e.deps)
  assert.ok(!('blockedSince' in JSON.parse(e.fsMap.get(`${STATE}.notices.json`))))
})

test('準備失敗：不進 done、下一輪再試、文案是「準備失敗，尚未發佈」、同原因只貼一次，成功後清掉', async () => {
  const gitOver = { 'fetch origin': () => ({ status: 1, stdout: '', stderr: 'network down' }) }
  const e = env({ desktopRows: [row('v0.2.45')], gitOver })
  for (let i = 0; i < 3; i++) assert.equal((await runOnce(opts, e.deps)).outcome, 'prep-failed')
  assert.equal(e.calls.git.filter((g) => g === 'fetch origin').length, 3, '每輪都再試')
  assert.equal(e.calls.spawn.length, 0)
  assert.equal(e.calls.posts.length, 1)
  assert.ok(e.calls.posts[0].includes('準備失敗，尚未發佈'))
  assert.ok(!e.calls.posts[0].includes('正式發佈失敗'))
  const st = lastState(e.fsMap)
  assert.equal(st.done['desktop@0.2.45'], undefined)
  assert.equal(st.inflight, null)
  delete gitOver['fetch origin']
  assert.equal((await runOnce(opts, e.deps)).outcome, 'dryRun')
  assert.equal(e.calls.spawn.length, 1)
  assert.ok(!('prep' in JSON.parse(e.fsMap.get(`${STATE}.notices.json`))), '成功後清掉去重標記')
})

test('fetch 失敗 stderr 帶 token URL：群組文字不得出現 SECRET 與 URL，log 要有', async () => {
  const url = 'https://x-access-token:SECRET@github.com/Yooliang/asn.git'
  const cases = {
    'fetch origin': 'fatal: unable to access ' + url,
    'fetch --tags': '! [rejected] v1 (would clobber) ' + url,
    'checkout --detach': 'error ' + url,
  }
  for (const [k, msg] of Object.entries(cases)) {
    const e = env({ desktopRows: [row('v0.2.45')], gitOver: { [k]: () => ({ status: 1, stdout: '', stderr: msg }) } })
    await runOnce(opts, e.deps)
    assert.equal(e.calls.posts.length, 1, k)
    assert.ok(!e.calls.posts[0].includes('SECRET') && !e.calls.posts[0].includes('https://') && !e.calls.posts[0].includes('github.com'), `${k}：${e.calls.posts[0]}`)
    assert.ok(e.calls.logs.some((l) => l.includes('SECRET')), `${k}：log 要有原文`)
  }
})

test('state 用 tmp 再 rename 寫入：不直接寫 state 檔', async () => {
  const e = env({ desktopRows: [row('v0.2.45')] })
  await runOnce(opts, e.deps)
  const tmp = `${STATE}.tmp-4242`
  const iW = e.calls.ops.indexOf(`write:${tmp}`)
  const iR = e.calls.ops.indexOf(`rename:${tmp}>${STATE}`)
  assert.ok(iW >= 0 && iR > iW, `${e.calls.ops}`)
  assert.ok(!e.calls.ops.includes(`write:${STATE}`))
  assert.ok(!e.fsMap.has(tmp))
})

test('state 讀不懂：不覆寫、連續出現只貼一次群組；恢復後清掉', async () => {
  const e = env({ files: { [STATE]: '{壞掉' } })
  assert.equal((await runOnce(opts, e.deps)).outcome, 'bad-state')
  assert.equal((await runOnce(opts, e.deps)).outcome, 'bad-state')
  assert.equal(e.calls.posts.length, 1)
  assert.equal(e.fsMap.get(STATE), '{壞掉')
  assert.ok(!e.calls.ops.some((o) => o.includes(STATE) && !o.includes('.notices.json') && !o.includes('.lock')))
  e.fsMap.set(STATE, JSON.stringify(seededState()))
  await runOnce(opts, e.deps)
  e.fsMap.set(STATE, '{又壞')
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 2)
})

test('沒播種、沒痕跡：啟動提示要先 --seed；runOnce 不自動建 state', async () => {
  const e = env({ noState: true })
  const c = checkStartup(opts, e.deps)
  assert.equal(c.ok, false)
  assert.ok(c.why.includes('--seed'))
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'no-state')
  assert.equal(e.fsMap.has(STATE), false)
})

test('沒有 state 但有 log 或鎖檔：拒絕啟動，不自動播種', () => {
  for (const trace of [path.join(path.dirname(STATE), 'auto-publish.log'), LOCK]) {
    const e = env({ noState: true, files: { [trace]: 'x' } })
    const c = checkStartup(opts, e.deps)
    assert.equal(c.ok, false)
    assert.ok(c.why.includes('拒絕啟動') && c.why.includes('跑過'), c.why)
  }
  assert.equal(checkStartup(opts, env().deps).ok, true)
})

test('state 存在但沒播種：核心回報一次，log 有 --seed 提示', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], files: { [STATE]: JSON.stringify(seededState({ seeded: false, done: {} })) } })
  assert.equal((await runOnce(opts, e.deps)).outcome, 'report')
  assert.equal(e.calls.spawn.length, 0)
  assert.ok(e.calls.logs.some((l) => l.includes('--seed')))
})

test('--seed 子命令：parseArgs、播種存檔、已有 state 拒絕、格式錯非零', () => {
  const o = parseArgs(['--seed', '0.2.44', '--state', STATE])
  assert.deepEqual([o.seedDesktop, o.seedLinux], ['0.2.44', '0.2.44'])
  const o2 = parseArgs(['--seed-desktop', '0.2.45', '--seed-linux', '0.2.40'])
  assert.deepEqual([o2.seedDesktop, o2.seedLinux], ['0.2.45', '0.2.40'])
  const e = env({ noState: true })
  const r = runCommand(o, e.deps)
  assert.equal(r.code, 0)
  const st = lastState(e.fsMap)
  assert.equal(st.seeded, true)
  assert.equal(st.done['desktop@0.2.44'].result, 'seeded')
  assert.equal(st.done['linux@0.2.44'].result, 'seeded')
  assert.equal(e.fsMap.has(LOCK), false, '還鎖')
  assert.equal(runCommand(o, e.deps).code, 2, '已有 state 不可再播種')
  const bad = env({ noState: true })
  const rb = runCommand(parseArgs(['--seed', 'abc', '--state', STATE]), bad.deps)
  assert.notEqual(rb.code, 0)
  assert.equal(bad.fsMap.has(STATE), false)
  const only = env({ noState: true })
  assert.notEqual(runCommand(parseArgs(['--seed-desktop', '0.2.1', '--state', STATE]), only.deps).code, 0)
})

test('--ack 子命令：標記已確認並存檔；找不到非零；鎖被佔用不動 state', () => {
  const failed = seededState({ done: { 'desktop@0.2.44': { result: 'seeded' }, 'linux@0.2.44': { result: 'seeded' }, 'desktop@0.2.45': { result: 'dryrun-failed', at: 'x', runId: '1' } } })
  const e = env({ files: { [STATE]: JSON.stringify(failed) } })
  const o = parseArgs(['--ack', 'desktop@0.2.45', '--state', STATE])
  assert.equal(o.ack, 'desktop@0.2.45')
  assert.equal(runCommand(o, e.deps).code, 0)
  assert.ok(lastState(e.fsMap).done['desktop@0.2.45'].ackedAt)
  assert.notEqual(runCommand({ ...o, ack: 'desktop@9.9.9' }, e.deps).code, 0)
  const busy = env({ files: { [STATE]: JSON.stringify(failed), [LOCK]: lk(777) }, alive: [777] })
  assert.equal(runCommand(o, busy.deps).code, 3)
  assert.equal(busy.fsMap.get(STATE), JSON.stringify(failed))
})

test('真實 createLock：鎖檔一出現就是完整內容、已存在就 EEXIST、不留暫存檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lock-'))
  try {
    const d = realDeps({ state: path.join(dir, 'state.json') })
    const lock = path.join(dir, 'state.json.lock')
    d.createLock(lock, '123\n456')
    assert.equal(fs.readFileSync(lock, 'utf8'), '123\n456')
    assert.throws(() => d.createLock(lock, '999\n1'), (e) => e.code === 'EEXIST')
    assert.equal(fs.readFileSync(lock, 'utf8'), '123\n456', '不覆蓋別人的鎖')
    assert.deepEqual(fs.readdirSync(dir), ['state.json.lock'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
