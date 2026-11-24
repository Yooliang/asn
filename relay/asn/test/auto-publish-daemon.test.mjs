import test from 'node:test'
import assert from 'node:assert/strict'
import { runOnce, toRuns, parseArgs, checkWorktree, checkStartup, runCommand, realDeps, resolveStatePath, REPO_ROOT, acquireLock, WORKFLOWS, REQUIRED_DEPS, BLOCKED_NOTICE_MS, GH_FAIL_NOTICE_MS } from '../../../tools/release/auto_publish.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve('/repo')
const inRepo = (p) => path.join(REPO, p)
const STATE = '/w/state.json'
const LOCK = `${STATE}.lock`
const SECRET = '子程序原文-不可貼群組-ABC123'
const T0 = Date.parse('2026-11-21T10:00:00Z')
// 鎖檔內容：pid 換行 時間戳
const lk = (pid, ts = T0 - 60_000) => `${pid}
${ts}`
// 核心現在要求先播種：預設的初始 state 是已播種（0.2.44 以下都算處理過）
const seededState = (extra = {}) => ({ v: 1, done: { 'desktop@0.2.44': { result: 'seeded', at: 'x', runId: null }, 'linux@0.2.44': { result: 'seeded', at: 'x', runId: null } }, pending: {}, inflight: null, seeded: true, since: { desktop: '0.2.44', linux: '0.2.44' }, seedNoticed: false, pausedNoticed: false, ...extra })

// 假環境：檔案、gh、git、子程序、asn-cli 全是假的
function env({ desktopRows = [], linuxRows = [], files = {}, alive = [], gitOver = {}, spawnStatus = 0, ghStatus = 0, noDeps = false, noState = false, online = '0.2.43' } = {}) {
  const fsMap = new Map(Object.entries(files).map(([k, v]) => [path.isAbsolute(k) ? k : inRepo(k), v]))
  if (!noState && !fsMap.has(STATE)) fsMap.set(STATE, JSON.stringify(seededState()))
  const clock = { t: T0 }
  if (!noDeps) for (const p of REQUIRED_DEPS) fsMap.set(inRepo(p), 'x')
  const calls = { gh: [], git: [], spawn: [], posts: [], fetch: [], logs: [], unlinks: [], ops: [] }
  const deps = {
    pid: 4242, repoRoot: REPO, now: () => clock.t,
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
    spawn: (bin, args, o) => { calls.spawn.push([bin, args, o]); return { status: spawnStatus, stdout: SECRET, stderr: SECRET } },
    asnCli: (args) => { calls.posts.push(args[args.indexOf('--body') + 1]); return { status: 0, stdout: '', stderr: '' } },
    exists: (p) => fsMap.has(p),
    readFile: (p) => { if (!fsMap.has(p)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return fsMap.get(p) },
    writeFile: (p, s) => { calls.ops.push(`write:${p}`); fsMap.set(p, s) },
    rename: (a, b) => { calls.ops.push(`rename:${a}>${b}`); if (!fsMap.has(a)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); fsMap.set(b, fsMap.get(a)); fsMap.delete(a) },
    createLock: (p, s) => { calls.ops.push(`lock:${p}`); if (fsMap.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); fsMap.set(p, s) },
    unlink: (p) => { calls.unlinks.push(p); fsMap.delete(p) },
    pidAlive: (pid) => alive.includes(pid),
    log: (m) => calls.logs.push(m),
    fetch: async (u) => { calls.fetch.push(u); if (online === null) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ version: online }) } },
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
  const BP = `${STATE}.blocked-since-4242`
  assert.ok(e.fsMap.has(BP), '被擋計時記在自己 pid 的檔')
  e.fsMap.delete(LOCK)
  await runOnce(opts, e.deps)
  assert.ok(!e.fsMap.has(BP), '取到鎖後清掉自己的計時檔')
})

test('#2003 被鎖住時不寫 notices（沒持鎖不准碰 notices 檔，計時只寫自己 pid 的檔）', async () => {
  const NP = `${STATE}.notices.json`
  const e = env({ files: { [LOCK]: lk(777, T0), [NP]: JSON.stringify({ badState: true, prep: 'x' }) }, alive: [777] })
  const before = e.fsMap.get(NP)
  for (const dt of [0, BLOCKED_NOTICE_MS + 1000, BLOCKED_NOTICE_MS + 2000]) { e.clock.t = T0 + dt; await runOnce(opts, e.deps) }
  assert.equal(e.calls.posts.length, 1)
  assert.equal(e.fsMap.get(NP), before, 'notices 內容不變')
  assert.ok(!e.calls.ops.some((o) => o.includes('.notices.json')), '沒有對 notices 的任何寫入或改名')
  assert.ok(!e.calls.unlinks.some((o) => o.includes('.notices.json')))
})

const GH_MSG = '自動發佈連續 30 分鐘查不到 GitHub 上的發版狀態，請檢查 gh 登入或網路'
const noticesOf = (e) => JSON.parse(e.fsMap.get(`${STATE}.notices.json`))
const ghEnv = () => { const e = env(); let fail = true; e.deps.gh = (args) => { e.calls.gh.push(args); return fail ? { status: 1, stdout: '', stderr: `HTTP 403 rate limit ${SECRET}` } : { status: 0, stdout: '[]', stderr: '' } }; e.setFail = (v) => { fail = v }; return e }

test('#2003 gh 連續失敗未滿 30 分鐘：不貼群組', async () => {
  const e = ghEnv()
  for (const dt of [0, 10 * 60_000, GH_FAIL_NOTICE_MS - 1000]) { e.clock.t = T0 + dt; assert.equal((await runOnce(opts, e.deps)).outcome, 'gh-failed') }
  assert.equal(e.calls.posts.length, 0)
  assert.equal(noticesOf(e).ghFailSince, T0)
})

test('#2003 gh 連續失敗超過 30 分鐘：只貼一次，群組文字固定、不含 stderr', async () => {
  const e = ghEnv()
  for (const dt of [0, GH_FAIL_NOTICE_MS + 1000, GH_FAIL_NOTICE_MS + 120_000, GH_FAIL_NOTICE_MS + 600_000]) { e.clock.t = T0 + dt; await runOnce(opts, e.deps) }
  assert.deepEqual(e.calls.posts, [GH_MSG])
  assert.ok(!e.calls.posts[0].includes(SECRET) && !e.calls.posts[0].includes('403'))
  assert.equal(e.fsMap.has(LOCK), false)
})

test('#2003 gh 恢復後：計時清掉並寫 log，下次再失敗重新計時', async () => {
  const e = ghEnv()
  await runOnce(opts, e.deps)
  e.clock.t = T0 + GH_FAIL_NOTICE_MS + 1000
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 1)
  e.setFail(false)
  e.clock.t = T0 + GH_FAIL_NOTICE_MS + 2000
  await runOnce(opts, e.deps)
  assert.ok(e.calls.logs.some((l) => l.includes('gh 已恢復')))
  assert.ok(!('ghFailSince' in noticesOf(e)) && !('ghFailNoticed' in noticesOf(e)))
  e.setFail(true)
  e.clock.t = T0 + GH_FAIL_NOTICE_MS + 3000
  await runOnce(opts, e.deps)
  assert.equal(noticesOf(e).ghFailSince, T0 + GH_FAIL_NOTICE_MS + 3000, '重新計時')
  e.clock.t += GH_FAIL_NOTICE_MS - 1000
  await runOnce(opts, e.deps)
  assert.equal(e.calls.posts.length, 1, '重新計時後未滿 30 分鐘不再貼')
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

test('state 能解析但結構不對：當 bad-state，不覆寫、不發佈、只貼一次群組', async () => {
  const bads = ['{}', 'null', '[]', '5', '"字串"', JSON.stringify({ done: {} }), JSON.stringify({ seeded: true }), JSON.stringify({ seeded: true, done: [] }), JSON.stringify({ seeded: true, done: null })]
  for (const text of bads) {
    const e = env({ desktopRows: [row('v0.2.45', 111)], files: { [STATE]: text } })
    assert.equal((await runOnce(opts, e.deps)).outcome, 'bad-state', text)
    assert.equal((await runOnce(opts, e.deps)).outcome, 'bad-state', text)
    assert.equal(e.calls.posts.length, 1, text)
    assert.equal(e.fsMap.get(STATE), text, `不覆寫：${text}`)
    assert.ok(!e.calls.ops.some((o) => o.includes(STATE) && !o.includes('.notices.json') && !o.includes('.lock')), text)
    assert.equal(e.calls.spawn.length, 0, `不呼叫 local_sign_publish：${text}`)
    assert.equal(e.calls.gh.length, 0, text)
  }
})

test('只有 notices 檔、沒有 state：拒絕啟動', () => {
  const e = env({ noState: true, files: { [`${STATE}.notices.json`]: '{}' } })
  const c = checkStartup(opts, e.deps)
  assert.equal(c.ok, false)
  assert.ok(c.why.includes('拒絕啟動') && c.why.includes('notices'), c.why)
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
  const e = env({ desktopRows: [row('v0.2.45')], files: { [STATE]: JSON.stringify(seededState({ seeded: false, since: null, done: {} })) } })
  assert.equal((await runOnce(opts, e.deps)).outcome, 'report')
  assert.equal(e.calls.spawn.length, 0)
  assert.ok(e.calls.logs.some((l) => l.includes('--seed')))
})

test('--seed 子命令：parseArgs、播種存檔、已有 state 拒絕、格式錯非零', async () => {
  const o = parseArgs(['--seed', '0.2.44', '--yes', '--state', STATE])
  assert.deepEqual([o.seedDesktop, o.seedLinux], ['0.2.44', '0.2.44'])
  const o2 = parseArgs(['--seed-desktop', '0.2.45', '--seed-linux', '0.2.40'])
  assert.deepEqual([o2.seedDesktop, o2.seedLinux], ['0.2.45', '0.2.40'])
  const e = env({ noState: true })
  const r = await runCommand(o, e.deps)
  assert.equal(r.code, 0)
  const st = lastState(e.fsMap)
  assert.equal(st.seeded, true)
  assert.equal(st.done['desktop@0.2.44'].result, 'seeded')
  assert.equal(st.done['linux@0.2.44'].result, 'seeded')
  assert.equal(e.fsMap.has(LOCK), false, '還鎖')
  assert.equal((await runCommand(o, e.deps)).code, 2, '已有 state 不可再播種')
  const bad = env({ noState: true })
  const rb = await runCommand(parseArgs(['--seed', 'abc', '--yes', '--state', STATE]), bad.deps)
  assert.notEqual(rb.code, 0)
  assert.equal(bad.fsMap.has(STATE), false)
  const only = env({ noState: true })
  assert.notEqual((await runCommand(parseArgs(['--seed-desktop', '0.2.44', '--yes', '--state', STATE]), only.deps)).code, 0)
})

test('--ack 子命令：標記已確認並存檔；找不到非零；鎖被佔用不動 state', async () => {
  const failed = seededState({ done: { 'desktop@0.2.44': { result: 'seeded' }, 'linux@0.2.44': { result: 'seeded' }, 'desktop@0.2.45': { result: 'dryrun-failed', at: 'x', runId: '1' } } })
  const e = env({ files: { [STATE]: JSON.stringify(failed) } })
  const o = parseArgs(['--ack', 'desktop@0.2.45', '--state', STATE])
  assert.equal(o.ack, 'desktop@0.2.45')
  assert.equal((await runCommand(o, e.deps)).code, 0)
  assert.ok(e.calls.logs.some((l) => l.includes('--ack') && l.includes('4242') && l.includes('desktop@0.2.45') && l.includes('dryrun-failed')), 'ack 要寫 log：pid、key、原結果')
  assert.ok(lastState(e.fsMap).done['desktop@0.2.45'].ackedAt)
  assert.notEqual((await runCommand({ ...o, ack: 'desktop@9.9.9' }, e.deps)).code, 0)
  const busy = env({ files: { [STATE]: JSON.stringify(failed), [LOCK]: lk(777) }, alive: [777] })
  assert.equal((await runCommand(o, busy.deps)).code, 3)
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

test('--ack 只准清失敗類：published／seeded／不存在都報錯且不寫檔；--ack 與 --seed 同給報錯', async () => {
  const st = seededState({ done: { 'desktop@0.2.44': { result: 'seeded' }, 'linux@0.2.44': { result: 'seeded' }, 'desktop@0.2.45': { result: 'published' }, 'linux@0.2.45': { result: 'blocked' } } })
  const e = env({ files: { [STATE]: JSON.stringify(st) } })
  const before = e.fsMap.get(STATE)
  for (const k of ['desktop@0.2.45', 'desktop@0.2.44', 'desktop@9.9.9']) {
    const r = await runCommand({ state: STATE, ack: k }, e.deps)
    assert.equal(r.code, 1, k)
    assert.equal(e.fsMap.get(STATE), before, '不寫檔')
  }
  assert.equal((await runCommand({ state: STATE, ack: 'linux@0.2.45' }, e.deps)).code, 0)
  assert.ok(lastState(e.fsMap).done['linux@0.2.45'].ackedAt)
  assert.equal(lastState(e.fsMap).done['linux@0.2.45'].result, 'blocked', '保留原結果')
  assert.match(parseArgs(['--ack', 'desktop@0.2.45', '--seed', '0.2.44']).error, /不能同時/)
})

const seedOpts = (extra = []) => parseArgs(['--seed', '0.2.44', '--state', STATE, ...extra])

test('--seed 沒帶 --yes：只印計畫（含 gh 最新成功版號與線上版號）、不寫檔、結束碼非零', async () => {
  const e = env({ noState: true, desktopRows: [row('v0.2.44', 5)], linuxRows: [row('linux-v0.2.43', 6)] })
  const r = await runCommand(seedOpts(), e.deps)
  assert.notEqual(r.code, 0)
  assert.equal(e.fsMap.has(STATE), false)
  assert.match(r.msg, /desktop 最新成功的 run 版號：0.2.44/)
  assert.match(r.msg, /linux 最新成功的 run 版號：0.2.43/)
  assert.match(r.msg, /線上 latest.json 版號：0.2.43/)
  assert.ok(e.calls.gh.every((a) => !['create', 'edit', 'delete', 'rerun', 'cancel'].includes(a[1])), 'gh 只讀')
  assert.ok(e.calls.gh.some((a) => a.includes('--status') && a.includes('success')))
})

test('--seed 起點低於線上版：拒絕並說明會重發舊版，不寫檔', async () => {
  const e = env({ noState: true, online: '0.2.50' })
  const r = await runCommand(seedOpts(['--yes']), e.deps)
  assert.notEqual(r.code, 0)
  assert.match(r.msg, /低於線上版/)
  assert.match(r.msg, /重發舊版/)
  assert.equal(e.fsMap.has(STATE), false)
  assert.deepEqual(e.calls.fetch, ['https://asnmessenger.web.app/update/latest.json'])
})

test('--seed 線上讀不到：拒絕並說明原因，不寫檔', async () => {
  const e = env({ noState: true, online: null })
  const r = await runCommand(seedOpts(['--yes']), e.deps)
  assert.notEqual(r.code, 0)
  assert.match(r.msg, /讀不到線上 latest.json（offline）/)
  assert.equal(e.fsMap.has(STATE), false)
})

test('--seed 正常情況（--yes、起點不低於線上版）會寫檔', async () => {
  const e = env({ noState: true, online: '0.2.43' })
  const r = await runCommand(seedOpts(['--yes']), e.deps)
  assert.equal(r.code, 0)
  assert.equal(lastState(e.fsMap).seeded, true)
})

test('接手殘留鎖：rename 後重讀發現已被換成別人的新鎖 B：放棄、不刪 B、鎖檔還是 B', async () => {
  const A = lk(999, T0 - 3 * 60 * 60 * 1000)
  const B = lk(555, T0 - 1000)
  const e = env({ files: { [LOCK]: A }, alive: [555] })
  const realRename = e.deps.rename
  e.deps.rename = (a, b) => { if (a === LOCK) e.fsMap.set(LOCK, B); return realRename(a, b) } // 讀完 A 之後、rename 之前，鎖被換成 B
  const r = acquireLock(LOCK, e.deps)
  assert.equal(r.got, false)
  assert.equal(e.fsMap.get(LOCK), B, '鎖檔最後還是 B')
  assert.equal(e.fsMap.has(`${LOCK}.stale-4242`), false)
  assert.equal(e.calls.unlinks.length, 0, '沒刪任何東西')
})

test('finally 還鎖：取鎖後鎖被換成別人的，不能刪別人的鎖；自己的鎖照常刪', async () => {
  const e = env({ desktopRows: [row('v0.2.45')] })
  const other = lk(777, T0 + 5)
  e.deps.spawn = (bin, args) => { e.fsMap.set(LOCK, other); return { status: 0, stdout: '', stderr: '' } } // 子程序執行期間鎖被換掉
  await runOnce(opts, e.deps)
  assert.equal(e.fsMap.get(LOCK), other, '別人的鎖還在')
  assert.ok(e.calls.logs.some((l) => l.includes('不刪')))
  const e2 = env({ desktopRows: [row('v0.2.45')] })
  await runOnce(opts, e2.deps)
  assert.equal(e2.fsMap.has(LOCK), false)
})

test('#2003c 從別的 cwd 呼叫：spawn 帶 cwd=repoRoot、腳本路徑與相依檢查都以 repoRoot 為基準', async () => {
  const e = env({ desktopRows: [row('v0.2.45', 111)] })
  const elsewhere = path.resolve('/某個別的啟動目錄')
  assert.notEqual(elsewhere, REPO)
  const checked = []
  const ex = e.deps.exists
  e.deps.exists = (p) => { checked.push(p); return ex(p) }
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun')
  const [bin, args, o] = e.calls.spawn[0]
  assert.equal(bin, 'node')
  assert.deepEqual(o, { cwd: REPO }, 'spawn 一定要帶 cwd: repoRoot')
  assert.equal(args[0], path.join(REPO, 'tools', 'release', 'local_sign_publish.mjs'))
  assert.ok(path.isAbsolute(args[0]), '腳本路徑是絕對路徑')
  for (const p of REQUIRED_DEPS) assert.ok(checked.includes(inRepo(p)), `相依檢查以 repoRoot 為基準：${p}`)
  assert.ok(!checked.some((p) => REQUIRED_DEPS.includes(p)), '不准用相對路徑檢查相依')
})

test('#2003c resolveStatePath：相對路徑以啟動目錄解析並留說明；絕對路徑不動；realDeps 預設 repoRoot 取自腳本位置', () => {
  const cwd = path.resolve('/launch')
  const a = resolveStatePath('s/state.json', cwd)
  assert.equal(a.state, path.resolve(cwd, 's/state.json'))
  assert.ok(a.note.includes(a.state) && a.note.includes('相對路徑'))
  const abs = path.resolve('/x/state.json')
  assert.deepEqual(resolveStatePath(abs, cwd), { state: abs, note: null })
  assert.equal(REPO_ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'))
  assert.equal(realDeps({ state: abs }).repoRoot, REPO_ROOT)
})

test('#2003c 運行手冊存在、涵蓋關鍵字，且手冊裡每個 --參數 parseArgs 都認得', () => {
  const doc = fs.readFileSync(new URL('../../../docs/release/自動發佈運行手冊.md', import.meta.url), 'utf8')
  for (const k of ['--seed', '--yes', '--ack', '--dry-run-only', '備援']) assert.ok(doc.includes(k), `手冊要提到 ${k}`)
  const flags = [...new Set(doc.match(/--[a-z][a-z-]*/g))]
  const needsVal = new Set(['--interval', '--state', '--room', '--seed', '--seed-desktop', '--seed-linux', '--ack'])
  for (const f of flags) {
    const o = parseArgs(needsVal.has(f) ? [f, f === '--interval' ? '120' : 'x'] : [f])
    assert.equal(o.error, null, `手冊提到的 ${f} 程式要認得：${o.error}`)
  }
})

test('#2003 (c) 核心的「需要播種」訊息講的是程式真的認得的參數（--seed／--yes），不是不存在的 --since', () => {
  const src = fs.readFileSync(new URL('../../../tools/release/auto_publish_core.mjs', import.meta.url), 'utf8')
  const msgs = [...src.matchAll(/message: '([^']*)'/g)].map(m => m[1])
  for (const m of msgs) for (const flag of m.match(/--[a-z][a-z-]*/g) ?? []) assert.ok(parseArgs([flag, ...(flag === '--seed' ? ['0.0.1'] : [])]).error == null || !/不認得|未知/.test(String(parseArgs([flag]).error)), `核心訊息提到 ${flag}，程式卻不認得`)
  assert.ok(msgs.some(m => /--seed/.test(m) && /--yes/.test(m)), '需要播種的訊息要寫出 --seed 與 --yes')
  assert.ok(!msgs.some(m => /--since/.test(m)), '不能再寫 --since')
})

// ---- #2229 告警檔 alert.json ----
const ALERT = path.join(path.dirname(STATE), 'alert.json')
const alertOf = (e) => JSON.parse(e.fsMap.get(ALERT))
const dirtyGit = { 'status --porcelain': () => ({ status: 0, stdout: ' M src/foo.js\n', stderr: '' }) }
const postFails = (e) => { e.deps.asnCli = () => ({ status: 2, stdout: '', stderr: '拒絕：找不到呼叫者所屬的 Claude 視窗' }) }

test('#2229 貼群組失敗：寫告警檔（類別、一句人話、次數、時間），發版照常', async () => {
  const e = env({ desktopRows: [row('v0.2.45')] })
  postFails(e)
  e.deps.spawn = () => ({ status: 1, stdout: '', stderr: '' }) // dry-run 失敗 → 會貼群組
  await runOnce(opts, e.deps)
  const a = alertOf(e).alerts['post-failed']
  assert.equal(a.status, 'active')
  assert.equal(a.count, 1)
  assert.equal(a.firstAt, a.lastAt)
  assert.ok(a.message.includes('通知群組失敗'))
  assert.ok(!JSON.stringify(a).includes('Claude 視窗'), '錯誤原文不進告警檔')
})

test('#2229 同原因再發生：只更新次數與最後時間，不重寫成新告警；原因改變才算新告警', async () => {
  let mode = 'dirty'
  const e = env({ desktopRows: [row('v0.2.45')] })
  const base = e.deps.git
  e.deps.git = (args, o) => (mode === 'dirty' && args.join(' ') === 'status --porcelain' ? dirtyGit['status --porcelain']() : mode === 'fetch' && args.join(' ') === 'fetch origin' ? { status: 1, stdout: '', stderr: 'x' } : base(args, o))
  await runOnce(opts, e.deps)
  const first = alertOf(e).alerts['prep-failed']
  assert.equal(first.count, 1)
  assert.equal(first.status, 'active')
  e.clock.t = T0 + 120_000
  await runOnce(opts, e.deps)
  const second = alertOf(e).alerts['prep-failed']
  assert.equal(second.count, 2)
  assert.equal(second.firstAt, first.firstAt, '第一次時間不變')
  assert.notEqual(second.lastAt, first.lastAt)
  mode = 'fetch'
  e.clock.t = T0 + 240_000
  await runOnce(opts, e.deps)
  const third = alertOf(e).alerts['prep-failed']
  assert.equal(third.count, 1, '原因改變＝新告警重新計')
  assert.notEqual(third.reason, first.reason)
})

test('#2229 狀況恢復：標成 resolved；之後再發生算新告警', async () => {
  let dirty = true
  const e = env({ desktopRows: [row('v0.2.45')] })
  const base = e.deps.git
  e.deps.git = (args, o) => (dirty && args.join(' ') === 'status --porcelain' ? dirtyGit['status --porcelain']() : base(args, o))
  await runOnce(opts, e.deps)
  dirty = false
  e.clock.t = T0 + 120_000
  assert.equal((await runOnce(opts, e.deps)).outcome, 'dryRun')
  const done = alertOf(e).alerts['prep-failed']
  assert.equal(done.status, 'resolved')
  assert.ok(done.resolvedAt)
  dirty = true
  e.fsMap.set(STATE, JSON.stringify(seededState()))
  e.clock.t = T0 + 240_000
  await runOnce(opts, e.deps)
  const again = alertOf(e).alerts['prep-failed']
  assert.equal(again.status, 'active')
  assert.equal(again.count, 1)
})

test('#2229 貼群組之後成功：post-failed 標成 resolved', async () => {
  const e = env({ desktopRows: [row('v0.2.45')] })
  postFails(e)
  e.deps.spawn = () => ({ status: 1, stdout: '', stderr: '' })
  await runOnce(opts, e.deps)
  e.deps.asnCli = () => ({ status: 0, stdout: '', stderr: '' })
  e.deps.spawn = () => ({ status: 1, stdout: '', stderr: '' })
  e.fsMap.set(STATE, JSON.stringify(seededState({ pending: {} })))
  e.clock.t = T0 + 120_000
  await runOnce(opts, e.deps)
  assert.equal(alertOf(e).alerts['post-failed'].status, 'resolved')
})

test('#2229 告警檔寫不進去：只記 log，不讓這一輪失敗、不影響發版', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], gitOver: dirtyGit })
  const w = e.deps.writeFile
  e.deps.writeFile = (p, s) => { if (p.includes('alert.json')) throw new Error('disk full'); w(p, s) }
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'prep-failed')
  assert.ok(e.calls.logs.some((l) => l.includes('寫告警檔失敗')))
  const ok = env({ desktopRows: [row('v0.2.45')] })
  const w2 = ok.deps.writeFile
  ok.deps.writeFile = (p, s) => { if (p.includes('alert.json')) throw new Error('disk full'); w2(p, s) }
  postFails(ok)
  assert.equal((await runOnce(opts, ok.deps)).outcome, 'dryRun')
})

// ---- #2229 常駐程式單一實例鎖（pid 檔）----
import { acquireInstance, releaseInstance, pidFileOf } from '../../../tools/release/auto_publish.mjs'
const PIDF = pidFileOf(opts)
// 假行程表：alive＝活著的 pid；cmd＝pid → 是不是 auto_publish（沒列＝查不到 null）
function inst(e, { alive = [], cmd = {} } = {}) {
  const d = { ...e.deps, pidAlive: (p) => alive.includes(p), isAutoPublish: (p) => (p in cmd ? cmd[p] : null) }
  return d
}

test('#2229 單一實例：沒有 pid 檔 → 拿到鎖，內容是自己的 pid；結束時刪掉', () => {
  const e = env()
  const r = acquireInstance(opts, inst(e))
  assert.equal(r.got, true)
  assert.ok(String(e.fsMap.get(PIDF)).startsWith('4242\n'))
  releaseInstance(opts, inst(e), r.content)
  assert.equal(e.fsMap.has(PIDF), false)
})

test('#2229 單一實例：已有活著的 auto_publish → 拿不到鎖，pid 檔不動', () => {
  const e = env({ files: { [PIDF]: `777\n${T0}` } })
  const r = acquireInstance(opts, inst(e, { alive: [777], cmd: { 777: true } }))
  assert.equal(r.got, false)
  assert.equal(r.pid, 777)
  assert.equal(e.fsMap.get(PIDF), `777\n${T0}`)
})

test('#2229 單一實例：殘留 pid 檔（行程已不在）→ 接手照常啟動', () => {
  const e = env({ files: { [PIDF]: `777\n${T0}` } })
  const r = acquireInstance(opts, inst(e, { alive: [] }))
  assert.equal(r.got, true)
  assert.equal(r.tookOver, 777)
  assert.ok(String(e.fsMap.get(PIDF)).startsWith('4242\n'))
})

test('#2229 單一實例：pid 被別的程式重用（活著但不是 auto_publish）→ 不誤判，接手', () => {
  const e = env({ files: { [PIDF]: `777\n${T0}` } })
  const r = acquireInstance(opts, inst(e, { alive: [777], cmd: { 777: false } }))
  assert.equal(r.got, true)
})

test('#2229 單一實例：查不到那個 pid 是什麼程式 → 保守不啟動（避免兩個同時發版）', () => {
  const e = env({ files: { [PIDF]: `777\n${T0}` } })
  const r = acquireInstance(opts, inst(e, { alive: [777] }))
  assert.equal(r.got, false)
  assert.equal(r.unknown, true)
})

test('#2229 單一實例：兩個同時啟動只有一個拿到鎖', () => {
  const e = env()
  const a = inst(e, { alive: [4242, 5151], cmd: { 4242: true, 5151: true } })
  const b = { ...a, pid: 5151 }
  const ra = acquireInstance(opts, a)
  const rb = acquireInstance(opts, b)
  assert.deepEqual([ra.got, rb.got], [true, false])
  assert.equal(rb.pid, 4242)
})

test('#2229 單一實例：兩個同時接手同一份殘留，只有一個贏', () => {
  const e = env({ files: { [PIDF]: `777\n${T0}` } })
  const a = inst(e)
  const b = { ...a, pid: 5151 }
  // b 在 a 接手過程中才動手：a 先完成接手後 b 再來，看到的是 a 活著的鎖
  const ra = acquireInstance(opts, a)
  const b2 = { ...b, pidAlive: (p) => p === 4242, isAutoPublish: () => true }
  const rb = acquireInstance(opts, b2)
  assert.deepEqual([ra.got, rb.got], [true, false])
})

test('#2229 單一實例：結束時 pid 檔已被別人換掉就不刪', () => {
  const e = env()
  const r = acquireInstance(opts, inst(e))
  e.fsMap.set(PIDF, `9999\n${T0}`)
  releaseInstance(opts, inst(e), r.content)
  assert.equal(e.fsMap.get(PIDF), `9999\n${T0}`)
})

test('#2229 單一實例：已有活著的 → claimInstance 寫告警（already-running，白話說明）且不動 pid 檔', async () => {
  const { claimInstance } = await import('../../../tools/release/auto_publish.mjs')
  const e = env({ files: { [PIDF]: `777\n${T0}` } })
  const r = claimInstance(opts, inst(e, { alive: [777], cmd: { 777: true } }))
  assert.equal(r.got, false)
  const a = alertOf(e).alerts['already-running']
  assert.equal(a.status, 'active')
  assert.ok(a.message.includes('已經有一個') && a.message.includes('先停掉舊的'))
  assert.equal(e.fsMap.get(PIDF), `777\n${T0}`)
})

// ---- #2229 無害雜檔（*.stackdump）不卡工作樹 ----
const statusOut = (out) => ({ 'status --porcelain': () => ({ status: 0, stdout: out, stderr: '' }) })

test('#2229 根目錄的未追蹤 *.stackdump：刪掉、記 log，照常往下跑', async () => {
  const e = env({
    desktopRows: [row('v0.2.45')],
    files: { 'bash.exe.stackdump': 'crash' },
    gitOver: statusOut('?? bash.exe.stackdump\n'),
  })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun')
  assert.deepEqual(e.calls.unlinks.filter((p) => p.endsWith('.stackdump')), [inRepo('bash.exe.stackdump')])
  assert.ok(e.calls.logs.some((l) => l.includes('bash.exe.stackdump') && l.includes('雜檔')))
  assert.equal(e.calls.spawn.length, 1)
})

test('#2229 清單外的未追蹤檔仍然卡住，且連 stackdump 也不刪', async () => {
  const e = env({
    desktopRows: [row('v0.2.45')],
    files: { 'bash.exe.stackdump': 'crash' },
    gitOver: statusOut('?? bash.exe.stackdump\n?? notes.txt\n'),
  })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'prep-failed')
  assert.equal(e.calls.spawn.length, 0)
  assert.deepEqual(e.calls.unlinks.filter((p) => !p.includes(".lock")), [])
  assert.ok(e.calls.logs.some((l) => l.includes('notes.txt')))
})

test('#2229 已追蹤檔被改動（即使檔名像雜檔）仍然卡住', async () => {
  const e = env({
    desktopRows: [row('v0.2.45')],
    gitOver: statusOut(' M src/foo.js\n M tracked.stackdump\n'),
  })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'prep-failed')
  assert.equal(e.calls.spawn.length, 0)
  assert.deepEqual(e.calls.unlinks.filter((p) => !p.includes(".lock")), [])
})

test('#2229 子資料夾裡的 *.stackdump 與資料夾整包未追蹤不算雜檔，照舊卡住', async () => {
  for (const line of ['?? relay/asn/x.stackdump\n', '?? tmpdir/\n', '?? x.stackdump.bak\n']) {
    const e = env({ desktopRows: [row('v0.2.45')], gitOver: statusOut(line) })
    const r = await runOnce(opts, e.deps)
    assert.equal(r.outcome, 'prep-failed', line)
    assert.deepEqual(e.calls.unlinks.filter((p) => !p.includes(".lock")), [], line)
  }
})

test('#2229 雜檔刪不掉：停下回報，不跑發佈', async () => {
  const e = env({ desktopRows: [row('v0.2.45')], gitOver: statusOut('?? bash.exe.stackdump\n') })
  e.deps.unlink = () => { throw new Error('EBUSY') }
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'prep-failed')
  assert.equal(e.calls.spawn.length, 0)
})

test('#2229 雜檔刪不掉、或有清單外改動而停下：都寫 prep-failed 告警（原因不同＝各自一筆新告警）', async () => {
  const a = env({ desktopRows: [row('v0.2.45')], gitOver: statusOut('?? bash.exe.stackdump\n') })
  a.deps.unlink = (p) => { if (p.endsWith('.stackdump')) throw new Error('EBUSY'); return env().deps.unlink(p) }
  await runOnce(opts, a.deps)
  assert.equal(alertOf(a).alerts['prep-failed'].reason, '工作樹有無法刪除的雜檔，請人工處理')
  const b = env({ desktopRows: [row('v0.2.45')], gitOver: statusOut('?? bash.exe.stackdump\n?? notes.txt\n') })
  await runOnce(opts, b.deps)
  const x = alertOf(b).alerts['prep-failed']
  assert.equal(x.reason, '工作樹有其他未提交的改動，不自動清理')
  assert.equal(x.status, 'active')
  assert.ok(x.message.includes('還沒發佈'))
})
