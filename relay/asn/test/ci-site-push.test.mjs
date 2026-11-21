// ci_site_push.mjs 的單元測試（#2022 ②-3）：fetch、git、檔案系統全部用假的，不碰網路、不碰真 repo、不碰 token。
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TRIES, SITE_FILES, parseArgs, realGit, run } from '../../../tools/release/ci_site_push.mjs'

const norm = p => p.replaceAll('\\', '/')
const latestText = v => `${JSON.stringify({ version: v, notes: 'x' }, null, 2)}\n`
const onlineFetch = v => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: v }) })

/** 假環境：fs 是記憶體 Map；git 記下每個呼叫；pushResults 決定每次 push 成不成功；onFetch 可以在 fetch 時改 main 上的檔（模擬別人推了新提交） */
const makeEnv = ({ mainVersion = '0.2.47', mainIndex = 'OLD', incoming = '0.2.48', incomingIndex = 'NEW', online = '0.2.47', pushResults = [true], onFetch } = {}) => {
  const disk = new Map()
  const files = new Map([['in/latest.json', latestText(incoming)], ['in/index.html', incomingIndex]])
  const main = new Map()
  if (mainVersion) main.set(SITE_FILES[0], latestText(mainVersion))
  main.set(SITE_FILES[1], mainIndex)
  const calls = []
  let staged = false, fetches = 0, pushes = 0
  const git = (args, opts = {}) => {
    calls.push({ args, auth: !!opts.auth })
    const c = args.find(a => ['fetch', 'reset', 'add', 'diff', 'commit', 'push'].includes(a))
    if (c === 'fetch') { fetches++; onFetch?.(main, fetches) }
    if (c === 'reset') { disk.clear(); for (const [k, v] of main) disk.set(k, v) }
    if (c === 'add') staged = SITE_FILES.some(f => disk.get(f) !== main.get(f))
    if (c === 'diff') return staged ? SITE_FILES.filter(f => disk.get(f) !== main.get(f)).join('\n') : ''
    if (c === 'push') {
      pushes++
      const ok = pushResults[Math.min(pushes - 1, pushResults.length - 1)]
      if (!ok) throw new Error('! [rejected] HEAD -> main (non-fast-forward)\nsecond line')
    }
    return ''
  }
  const deps = {
    git, fetchFn: onlineFetch(online), now: () => 1, log: m => logs.push(m),
    readFile: p => (norm(p).startsWith('in/') ? files.get(norm(p)) : disk.get(norm(p))),
    writeFile: (p, t) => disk.set(norm(p), t),
    exists: p => (norm(p).startsWith('in/') ? files.has(norm(p)) : disk.has(norm(p))),
  }
  const logs = []
  return { deps, calls, logs, disk, get fetches() { return fetches }, get pushes() { return pushes } }
}
const opts = (version = '0.2.48') => ({ version, files: 'in' })
const names = calls => calls.map(c => c.args.find(a => ['fetch', 'reset', 'add', 'diff', 'commit', 'push'].includes(a)))

test('正常：版本往前 → 覆蓋兩個檔、提交、推 HEAD:main 一次；提交訊息與作者照格式', async () => {
  const e = makeEnv()
  const r = await run(opts(), e.deps)
  assert.deepEqual(r, { pushed: true, attempts: 1 })
  assert.deepEqual(names(e.calls), ['fetch', 'reset', 'add', 'diff', 'commit', 'push'])
  assert.equal(e.disk.get(SITE_FILES[0]), latestText('0.2.48'))
  assert.equal(e.disk.get(SITE_FILES[1]), 'NEW')
  const commit = e.calls.find(c => c.args.includes('commit')).args
  assert.ok(commit.includes('發版 v0.2.48：更新 latest.json 與首頁下載連結'))
  assert.ok(commit.includes('user.name=github-actions[bot]'))
  assert.deepEqual(e.calls.find(c => c.args.includes('push')).args, ['push', 'origin', 'HEAD:main'])
  // 只有 fetch 與 push 帶憑證
  assert.deepEqual(e.calls.filter(c => c.auth).map(c => c.args[0]), ['fetch', 'push'])
  assert.ok(!e.calls.some(c => c.args.some(a => /force|^-f$|tags|^\+/.test(a))), '不准強推、不准推標籤')
})

test('版本退了要停：低於線上 → 丟錯、不提交不推', async () => {
  const e = makeEnv({ incoming: '0.2.46', online: '0.2.47', mainVersion: '0.2.45' })
  await assert.rejects(run(opts('0.2.46'), e.deps), /版本會倒退.*線上已是 0\.2\.47/)
  assert.ok(!names(e.calls).includes('commit') && !names(e.calls).includes('push'))
})

test('版本退了要停：低於 main 上目前的 latest.json（線上還沒更新）→ 丟錯、不提交不推', async () => {
  const e = makeEnv({ incoming: '0.2.46', online: '0.2.44', mainVersion: '0.2.47' })
  await assert.rejects(run(opts('0.2.46'), e.deps), /版本會倒退.*main 上的 latest\.json 已是 0\.2\.47/)
  assert.ok(!names(e.calls).includes('commit') && !names(e.calls).includes('push'))
})

test('版本退了要停：重試途中別人先推了更新的版本 → 第 2 輪重做檢查就停，不推', async () => {
  const e = makeEnv({ pushResults: [false, true], onFetch: (main, n) => { if (n === 2) main.set(SITE_FILES[0], latestText('0.2.49')) } })
  await assert.rejects(run(opts(), e.deps), /版本會倒退.*0\.2\.49/)
  assert.equal(e.pushes, 1)
})

test('線上讀不到：不猜，丟錯、不推', async () => {
  const e = makeEnv()
  e.deps.fetchFn = async () => ({ ok: false, status: 503, text: async () => '' })
  await assert.rejects(run(opts(), e.deps), /讀不到線上/)
  assert.equal(e.pushes, 0)
})

test('重跑且內容相同：不提交、不推，回 pushed:false（workflow 照常觸發部署）；線上等於這版也放行', async () => {
  const e = makeEnv({ mainVersion: '0.2.48', mainIndex: 'NEW', online: '0.2.48' })
  const r = await run(opts(), e.deps)
  assert.deepEqual(r, { pushed: false, attempts: 1, reason: 'same' })
  assert.ok(!names(e.calls).includes('commit') && !names(e.calls).includes('push'))
  assert.ok(e.logs.some(m => /不需要提交/.test(m)))
})

test('重跑但只有一個檔不同（latest.json 已推、首頁沒推）：還是會提交並推', async () => {
  const e = makeEnv({ mainVersion: '0.2.48', mainIndex: 'OLD', online: '0.2.47' })
  const r = await run(opts(), e.deps)
  assert.equal(r.pushed, true)
})

test('push 失敗會重試：第 1、2 次被拒、第 3 次成功；每輪都重新 fetch／reset／覆蓋', async () => {
  const e = makeEnv({ pushResults: [false, false, true] })
  const r = await run(opts(), e.deps)
  assert.deepEqual(r, { pushed: true, attempts: 3 })
  assert.equal(e.fetches, 3)
  assert.equal(names(e.calls).filter(n => n === 'reset').length, 3)
  assert.equal(names(e.calls).filter(n => n === 'push').length, 3)
  assert.equal(e.logs.filter(m => /推送被拒/.test(m)).length, 2)
})

test(`push 連續被拒 ${MAX_TRIES} 次才放棄：丟錯、剛好推 3 次、不多不少、不強推`, async () => {
  const e = makeEnv({ pushResults: [false] })
  await assert.rejects(run(opts(), e.deps), /連續被拒 3 次.*不強推/)
  assert.equal(MAX_TRIES, 3)
  assert.equal(e.pushes, 3)
  assert.equal(e.fetches, 3)
  assert.ok(!e.calls.some(c => c.args.some(a => /force|^-f$/.test(a))))
})

test('壞輸入：artifact 缺檔、版本與這次不符、main 上的 latest.json 壞掉都丟錯', async () => {
  const e1 = makeEnv(); e1.deps.exists = p => !p.endsWith('index.html') && (norm(p).startsWith('in/') || e1.disk.has(norm(p)))
  await assert.rejects(run(opts(), e1.deps), /少了 index\.html/)
  const e2 = makeEnv({ incoming: '0.2.50' })
  await assert.rejects(run(opts('0.2.48'), e2.deps), /不是這次的 0\.2\.48/)
  const e3 = makeEnv(); const orig = e3.deps.readFile
  e3.deps.readFile = p => (p === SITE_FILES[0] ? '{壞' : orig(p))
  await assert.rejects(run(opts(), e3.deps), /main 上的 latest\.json 不是合法 JSON/)
})

test('main 上還沒有 latest.json：不比 main，只比線上', async () => {
  const e = makeEnv({ mainVersion: null })
  const r = await run(opts(), e.deps)
  assert.equal(r.pushed, true)
})

test('parseArgs：缺參數、不認得的參數、版本格式不對都丟錯', () => {
  assert.deepEqual(parseArgs(['--version', '0.2.48', '--files', 'x']), { version: '0.2.48', files: 'x' })
  assert.throws(() => parseArgs(['--version', '0.2.48']), /--files/)
  assert.throws(() => parseArgs(['--version', 'v0.2.48', '--files', 'x']), /版本格式/)
  assert.throws(() => parseArgs(['--x', '1']), /不認得/)
})

test('token 不進 log：realGit 只對 base64 值印 ::add-mask::，命令列沒有 token，真的呼叫的環境變數才帶 header（假 git 不執行；只檢查建構）', () => {
  const lines = []
  const git = realGit({ token: 'ghs_SECRET123', out: s => lines.push(s) })
  assert.equal(typeof git, 'function')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^::add-mask::[A-Za-z0-9+/=]+$/)
  assert.ok(!lines.join('\n').includes('ghs_SECRET123'))
  // 錯誤訊息會抹掉 token 與 base64：用一個一定失敗的 git 子命令，錯誤文字裡塞進 token 的 base64 不可能，所以改驗 scrub 的行為
  const b64 = Buffer.from('x-access-token:ghs_SECRET123').toString('base64')
  assert.equal(lines[0], `::add-mask::${b64}`)
  assert.throws(() => git(['--no-such-option-ghs_SECRET123']), err => !err.message.includes('ghs_SECRET123') && /\*\*\*|unknown option|--no-such/.test(err.message))
})

test('腳本原始碼守門：只推 HEAD:main、沒有 --force／-f／標籤、token 只從環境變數進來', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../tools/release/ci_site_push.mjs', import.meta.url), 'utf8')
  const pushes = [...src.matchAll(/\['push'[^\]]*\]/g)].map(m => m[0])
  assert.deepEqual(pushes, ["['push', 'origin', 'HEAD:main']"])
  assert.doesNotMatch(src.replace(/^\/\/.*$/gm, ''), /--force|--tags|refs\/tags|'-f'/)
  assert.match(src, /process\.env\.GH_TOKEN/)
  assert.doesNotMatch(src, /x-access-token:\$\{token\}@/)
})

test('真 git 整合（本機 bare 當遠端，不碰網路）：推得上去、內容與作者正確；內容相同再跑一次不產生新提交', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), { execFileSync } = await import('node:child_process')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-site-push-'))
  const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const remote = path.join(tmp, 'remote.git'), work = path.join(tmp, 'work'), inDir = path.join(tmp, 'in')
  fs.mkdirSync(remote); sh(remote, 'init', '--bare', '-b', 'main')
  sh(tmp, 'clone', remote, work)
  sh(work, 'config', 'user.name', 't'); sh(work, 'config', 'user.email', 't@x')
  fs.mkdirSync(path.join(work, 'site/public/update'), { recursive: true })
  fs.writeFileSync(path.join(work, SITE_FILES[0]), latestText('0.2.47')); fs.writeFileSync(path.join(work, SITE_FILES[1]), 'OLD')
  sh(work, 'add', '-A'); sh(work, 'commit', '-m', 'init'); sh(work, 'push', 'origin', 'HEAD:main')
  fs.mkdirSync(inDir); fs.writeFileSync(path.join(inDir, 'latest.json'), latestText('0.2.48')); fs.writeFileSync(path.join(inDir, 'index.html'), 'NEW')
  const real = realGit({ token: 'tok', cwd: work, out: () => {} })
  const deps = { git: real, fetchFn: onlineFetch('0.2.47'), log: () => {}, readFile: p => fs.readFileSync(path.resolve(work, p), 'utf8').replace(/^/, ''), writeFile: (p, t) => fs.writeFileSync(path.resolve(work, p), t), exists: p => fs.existsSync(path.resolve(work, p)) }
  // 輸入檔在 work 之外：用絕對路徑
  const r1 = await run({ version: '0.2.48', files: inDir }, deps)
  assert.equal(r1.pushed, true)
  assert.equal(sh(remote, 'show', 'main:site/public/index.html'), 'NEW')
  assert.equal(sh(remote, 'log', '-1', '--format=%an|%s', 'main').trim(), 'github-actions[bot]|發版 v0.2.48：更新 latest.json 與首頁下載連結')
  const head = sh(remote, 'rev-parse', 'main').trim()
  const r2 = await run({ version: '0.2.48', files: inDir }, { ...deps, fetchFn: onlineFetch('0.2.48') })
  assert.equal(r2.pushed, false)
  assert.equal(sh(remote, 'rev-parse', 'main').trim(), head)
  fs.rmSync(tmp, { recursive: true, force: true })
})
