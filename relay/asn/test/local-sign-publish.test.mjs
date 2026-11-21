// tools/release/local_sign_publish.mjs（#1892 規格 2.5、第 6 節第 10 點）：本機簽章與發布。
// 全部用注入的假函式（gh、git、asn-cli、firebase、簽章、fetch、發 Release），不連網、不碰真金鑰；簽章用測試自己產的拋棄式金鑰
// （格式互通由 verify-sig.test.mjs 的 Tauri 黃金樣本負責，這裡只驗流程與順序）。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localSignPublish, parseArgs, compareVersions, WORKFLOW } from '../../../tools/release/local_sign_publish.mjs'
import { buildZip } from '../../../tools/release/zip_lite.mjs'

const V = '0.2.37'
const TAG = `v${V}`
const SHA = 'a'.repeat(40)
const ORIG = 'b'.repeat(40)
const EXE_NAME = `ASN_${V}_x64-setup.exe`
const SECRET_PASSWORD = 'PASSWORD-SHOULD-NEVER-APPEAR'
const SECRET_KEY = 'PRIVATE-KEY-BYTES-SHOULD-NEVER-APPEAR'
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const b64 = b => Buffer.from(b).toString('base64')

// ---- 拋棄式金鑰與 minisign 格式的簽章產生器
const kp = crypto.generateKeyPairSync('ed25519')
const keyId = crypto.randomBytes(8)
const pubRaw = Buffer.concat([Buffer.from('Ed'), keyId, kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(12)])
const PUBKEY_TEXT = b64(`untrusted comment: minisign public key: TEST\n${b64(pubRaw)}\n`)
function minisign(bytes, fileName, alg = 'ED') {
  const sig = crypto.sign(null, crypto.createHash('blake2b512').update(bytes).digest(), kp.privateKey)
  const trusted = `timestamp:1\tfile:${fileName}\tversion:${V}`
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), kp.privateKey)
  return b64(`untrusted comment: signature from tauri secret key\n${b64(Buffer.concat([Buffer.from(alg), keyId, sig]))}\ntrusted comment: ${trusted}\n${b64(global)}\n`)
}

const OLD_INDEX = '<a class="btn" href="https://asnmessenger.web.app/update/ASN_0.2.36_x64-setup.exe">下載</a>\n'
const CHANGELOG = `# ASN\n\n## ${V}（2026-11-21）\n- 新功能：甲\n\n## 0.2.36（2026-11-20）\n- 舊\n`
const SKILL_MD = '---\nversion: 3\n---\n說明\n'
const SKILL = { version: 3, sha256: sha256(Buffer.from(SKILL_MD)) }

function world(mod = () => {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-repo-'))
  const wr = (rel, t) => { const f = path.join(repo, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t) }
  wr('tools/release/FIREBASE_TOOLS_VERSION', '# 註解\n15.35.0\n')
  wr('site/public/update/latest.json', '{"version":"0.2.36"}\n')
  wr('site/public/index.html', OLD_INDEX)
  wr('site/public/skill/version.json', JSON.stringify(SKILL))
  wr('site/public/skill/asn-cloud-agent.md', SKILL_MD)
  const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(1000)])
  const draft = { version: V, date: '2026-11-21', commit: SHA.slice(0, 8), items: ['新功能：甲'], platforms: ['官網'] }
  const zips = {
    1: buildZip([{ name: EXE_NAME, data: exe }, { name: 'SHA256SUMS.txt', data: Buffer.from(`${sha256(exe)}  ${EXE_NAME}\n`) }]),
    2: buildZip([{ name: 'site-record-draft.json', data: Buffer.from(JSON.stringify(draft)) }]),
  }
  const art = (id, name) => ({ id, name, expired: false, digest: `sha256:${sha256(zips[id] ?? Buffer.from(name))}`, workflow_run: { id: 555, head_sha: SHA } })
  const w = {
    repo, exe, events: [], logs: [], zips, deployed: false, fetchCount: 0, moveOnSecondFetch: false,
    shallow: false, hist: 'h1', ancestor: true, head: SHA, status: '', siteChanged: ' M site/public/update/latest.json\n M site/public/index.html',
    contains: 'origin/main', originMain: ORIG, wfBlob: { tag: 'blob1', main: 'blob1' }, staged: '', ghAuth: true, fbWho: 'dev@example.com', keyOk: true,
    run: { id: 555, path: WORKFLOW, event: 'push', head_sha: SHA, head_branch: TAG, conclusion: 'success', run_attempt: 1 },
    runs: null, artifacts: [art(1, 'asn-installer-unsigned'), art(2, 'asn-site-draft'), art(3, 'asn-aab'), art(4, 'asn-debug')],
    jobs: [{ name: 'android-upload', conclusion: 'success' }], attest: true, onlineVersion: '0.2.36', signMode: 'good', testsOk: true,
    mainBlobs: {}, pushCount: 0, pushFailTimes: 0, wtBase: null, wtFiles: null,
    asnStatus: {}, firebaseDeployFails: false, publishFails: false, room: 'room-1',
    conf: JSON.stringify({ plugins: { updater: { pubkey: PUBKEY_TEXT } } }), draft, changelog: CHANGELOG, index: OLD_INDEX,
  }
  mod(w)
  w.runs ??= [w.run]
  const ev = (k, a) => w.events.push({ k, a })
  const git = rawArgs => {
    // git -C <資料夾> ...：第 12 步在暫存 worktree 裡操作；事件照記，資料夾放在 inDir
    let args = rawArgs, inDir = null
    if (rawArgs[0] === '-C') { inDir = rawArgs[1]; args = rawArgs.slice(2) }
    const j = args.join(' ')
    if (args[0] === 'worktree') {
      ev(`git worktree ${args[1]}`, args)
      if (args[1] === 'add') w.wtBase = args.at(-1)
      return ''
    }
    if (inDir) {
      if (args[0] === 'add') { ev('git add', args); w.wtFiles = Object.fromEntries(args.slice(2).map(f => [f, fs.readFileSync(path.join(inDir, ...f.split('/')), 'utf8')])); return '' }
      if (j === 'diff --cached --name-only') return 'site/public/update/latest.json\nsite/public/index.html\n'
      if (args[0] === 'commit') { ev('git commit', args); return '' }
      if (j === 'rev-parse HEAD') return `${'f'.repeat(40)}\n`
      throw new Error(`假 git 不認得（-C）：${j}`)
    }
    const blobM = /^rev-parse (\S+):(site\/public\/\S+)$/.exec(j)
    if (blobM) return `${blobM[1] === TAG ? 'tagblob' : (w.mainBlobs[blobM[2]] ?? 'tagblob')}\n`
    if (args[0] === 'tag' && args[1] === '--list') { ev('git tag --list', args); return w.linuxTag ? args[2] : '' }
    if (args[0] === 'push') { w.pushCount++; ev('git push', args); if (w.pushFailTimes >= w.pushCount) throw new Error('rejected'); return '' }
    if (j === 'rev-parse --is-shallow-repository') return w.shallow ? 'true\n' : 'false\n'
    if (j.startsWith('log -n1')) { if (!w.hist) throw new Error('fatal'); return `${w.hist}\n` }
    if (args[0] === 'fetch') { w.fetchCount++; ev('git fetch', args); return '' }
    if (j === `rev-parse ${TAG}^{commit}`) return `${SHA}\n`
    if (j === 'rev-parse HEAD') return `${w.head}\n`
    if (j === 'status --porcelain') return w.status
    if (args[0] === 'status' && args.includes('--')) return w.siteChanged
    if (args[0] === 'branch') return w.contains
    if (j === 'rev-parse origin/main') return `${w.moveOnSecondFetch && w.fetchCount >= 2 ? 'c'.repeat(40) : w.originMain}\n`
    if (args[0] === 'merge-base') { if (!w.ancestor) throw new Error('not ancestor'); return '' }
    if (j === `rev-parse ${TAG}:${WORKFLOW}`) return `${w.wfBlob.tag}\n`
    if (j === `rev-parse origin/main:${WORKFLOW}`) return `${w.wfBlob.main}\n`
    if (j === `show ${TAG}:relay/asn/src-tauri/tauri.conf.json`) return w.conf
    if (j === `show ${TAG}:relay/asn/CHANGELOG.md`) return w.changelog
    if (j === `show ${TAG}:site/public/index.html`) return w.index
    if (j === 'diff --cached --name-only') return w.staged
    if (['add', 'commit', 'push'].includes(args[0])) { ev(`git ${args[0]}`, args); return '' }
    throw new Error(`假 git 不認得：${j}`)
  }
  const gh = args => {
    const j = args.join(' ')
    ev('gh', args)
    if (j === 'auth status') { if (!w.ghAuth) throw new Error('not logged in'); return '' }
    if (args[0] === 'attestation') { if (!w.attest) throw new Error('attestation failed'); return '' }
    if (/\/actions\/workflows\/asn-release\.yml\/runs\?/.test(j)) return JSON.stringify({ workflow_runs: w.runs })
    if (/\/actions\/runs\/\d+\/artifacts/.test(j)) return JSON.stringify({ artifacts: w.artifacts })
    if (/\/attempts\/\d+\/jobs/.test(j)) return JSON.stringify({ jobs: w.jobs })
    if (/\/actions\/runs\/\d+$/.test(j)) return JSON.stringify(w.run)
    throw new Error(`假 gh 不認得：${j}`)
  }
  const onlineFiles = () => ({
    '/update/latest.json': fs.readFileSync(path.join(repo, 'site/public/update/latest.json'), 'utf8'),
    [`/update/${EXE_NAME}`]: exe,
    [`/update/${EXE_NAME}.sig`]: w.sigText ?? '',
    '/': fs.readFileSync(path.join(repo, 'site/public/index.html'), 'utf8'),
    '/skill/version.json': JSON.stringify(SKILL), '/skill/asn-cloud-agent.md': SKILL_MD,
  })
  const deps = {
    repoRoot: repo, git, gh, log: m => w.logs.push(m), now: () => Date.parse('2026-11-21T00:00:00Z'), sleep: async () => {}, onlineAttempts: 2, onlineIntervalMs: 1,
    mkTmp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-dl-')),
    ghDownloadArtifact: (id, dest) => { ev('gh artifact', [id]); fs.writeFileSync(dest, w.zips[id]) },
    ghDownload: () => {},
    asnCli: async args => { ev(`asn-cli ${args[0]}`, args); return { status: w.asnStatus[args[0]] ?? 0, stdout: '', stderr: w.asnStderr?.[args[0]] ?? '' } },
    firebase: async ({ version, args }) => {
      ev(`firebase ${args[0]}`, [version, ...args])
      if (args[0] === 'login:list') return w.fbWho
      if (w.firebaseDeployFails) throw new Error('deploy failed')
      w.deployed = true
      return ''
    },
    signer: {
      check: async () => ({ ok: w.keyOk }),
      sign: async exeFile => {
        ev('sign', [exeFile])
        const bytes = fs.readFileSync(exeFile)
        const text = w.signMode === 'wrongFile' ? minisign(Buffer.from('other'), EXE_NAME)
          : w.signMode === 'wrongName' ? minisign(bytes, 'ASN_9.9.9_x64-setup.exe')
          : w.signMode === 'plainEd' ? minisign(bytes, EXE_NAME, 'Ed') : minisign(bytes, EXE_NAME)
        fs.writeFileSync(`${exeFile}.sig`, text)
        w.sigText = text
        return `${exeFile}.sig`
      },
    },
    fetchFn: async url => {
      const u = new URL(url)
      if (!w.deployed && u.pathname === '/update/latest.json') return { ok: true, status: 200, text: async () => JSON.stringify(w.onlineLinux ? { version: w.onlineVersion, platforms: { 'windows-x86_64': {}, 'linux-x86_64': {} } } : { version: w.onlineVersion }) }
      const body = onlineFiles()[u.pathname]
      if (body === undefined) return { ok: false, status: 404 }
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
      return { ok: true, status: 200, text: async () => buf.toString('utf8'), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
    },
    publishRelease: async args => {
      ev('release', Object.keys(args))
      w.siteAtRelease = fs.readFileSync(path.join(repo, 'site/public/update/latest.json'), 'utf8')
      w.releaseArgs = args
      if (w.publishFails) throw new Error('release failed')
    },
    runTests: () => { ev('tests', []); return { ok: w.testsOk } },
  }
  const opts = { ...parseArgs(['--tag', TAG]), room: w.room }
  return { w, deps, opts, repo }
}
const kinds = w => w.events.map(e => e.k)
const PUBLISH_KINDS = ['release', 'firebase deploy', 'asn-cli site', 'git push', 'git commit', 'git add']
const published = w => kinds(w).filter(k => PUBLISH_KINDS.includes(k))
const run = async (mod, optsMod) => {
  const x = world(mod ?? undefined)
  if (optsMod) Object.assign(x.opts, optsMod)
  const r = await localSignPublish(x.opts, x.deps)
  return { ...x, r }
}
const aborts = (x, step, re) => {
  assert.equal(x.r.ok, false, '應該中止')
  assert.equal(x.r.failedStep, step, `卡的步驟：${x.r.error}`)
  if (re) assert.match(x.r.error, re)
  const posts = x.w.events.filter(e => e.k === 'asn-cli send')
  if (!x.opts.dryRun) {
    assert.equal(posts.length, step === 12 ? 2 : 1, '失敗要貼群組一次（第 11 步已貼過完成）')
    assert.match(posts.at(-1).a[4], new RegExp(`卡在第 ${step} 步`))
  }
}

test('全流程：順序是 簽章→Release→部署→官網紀錄→貼群組→提交推送；網站檔先寫好才發 Release', async () => {
  const x = await run()
  assert.equal(x.r.ok, true, x.r.error)
  const k = kinds(x.w)
  const at = n => k.indexOf(n)
  assert.ok(at('sign') < at('release') && at('release') < at('firebase deploy') && at('firebase deploy') < at('asn-cli site') && at('asn-cli site') < at('asn-cli send') && at('asn-cli send') < at('git push'), k.join(' > '))
  assert.equal(JSON.parse(x.w.siteAtRelease).version, V)
  const idx = fs.readFileSync(path.join(x.repo, 'site/public/index.html'), 'utf8')
  assert.match(idx, new RegExp(`ASN_${V}_x64-setup\\.exe`))
  assert.ok(!idx.includes('\r'))
  assert.equal(x.r.completed.length, 13)
  const site = x.w.events.find(e => e.k === 'asn-cli site').a
  assert.deepEqual(site.filter((_, i) => site[i - 1] === '--platform'), ['官網', 'Play'])
  assert.deepEqual(x.w.events.find(e => e.k === 'firebase deploy').a, ['15.35.0', 'deploy', '--only', 'hosting', '--project', 'asnmessenger'])
  assert.deepEqual(x.w.events.find(e => e.k === 'git push').a, ['push', 'origin', `${'f'.repeat(40)}:main`])
  assert.ok(x.w.events.find(e => e.k === 'git commit').a.includes('--'))
})

test('#2061 CI 多了 asn-installer-signed（desktop-sign 的產物）：允許存在、照常發佈，而且不下載它（本機照舊用未簽章那包自己簽）', async () => {
  const x = await run(w => { w.artifacts.push({ ...w.artifacts[0], id: 5, name: 'asn-installer-signed' }) })
  assert.equal(x.r.ok, true, x.r.error)
  const downloaded = x.w.events.filter(e => e.k === 'gh artifact').map(e => e.a[0])
  assert.ok(!downloaded.includes(5), `不該下載已簽章那包：${downloaded}`)
  assert.ok(downloaded.includes(1), '還是要下載未簽章那包')
  assert.ok(kinds(x.w).includes('sign'), '本機照舊簽章')
})

test('CI 多了 asn-e2e-shots-<次數>（e2e 截圖警告的產物）：允許存在、照常發佈，而且不下載它', async () => {
  const x = await run(w => { w.artifacts.push({ ...w.artifacts[0], id: 6, name: 'asn-e2e-shots-1' }) })
  assert.equal(x.r.ok, true, x.r.error)
  const downloaded = x.w.events.filter(e => e.k === 'gh artifact').map(e => e.a[0])
  assert.ok(!downloaded.includes(6), `不該下載截圖那包：${downloaded}`)
  assert.ok(kinds(x.w).includes('sign'), '本機照舊簽章')
})

test('白名單樣式只放 asn-e2e-shots-<數字>：名字變形的照樣擋下', async () => {
  for (const name of ['asn-e2e-shots-', 'asn-e2e-shots-1x', 'xasn-e2e-shots-1', 'asn-e2e-shots-1/../asn-installer-unsigned']) {
    const x = await run(w => { w.artifacts.push({ ...w.artifacts[0], id: 7, name }) })
    assert.equal(x.r.ok, false, name)
    assert.match(x.r.error, /不在白名單/, name)
  }
})

test('官網紀錄的平台：--with-play no 只寫官網；auto 看最新 attempt 的 android-upload；yes 直接寫 Play', async () => {
  const plat = x => { const a = x.w.events.find(e => e.k === 'asn-cli site').a; return a.filter((_, i) => a[i - 1] === '--platform') }
  assert.deepEqual(plat(await run(null, { withPlay: 'no' })), ['官網'])
  assert.deepEqual(plat(await run(w => { w.jobs = [{ name: 'android-upload', conclusion: 'failure' }] })), ['官網'])
  assert.deepEqual(plat(await run(w => { w.jobs = [] }, { withPlay: 'yes' })), ['官網', 'Play'])
  const x = await run()
  assert.ok(x.w.events.some(e => e.k === 'gh' && e.a.join(' ').includes('/attempts/1/jobs')))
})

test('--with-play auto：找不到 android-upload→第 1 步中止（要明確給 yes／no）；success→帶 Play；failure→不帶並印一句；yes／no 不看 jobs', async () => {
  const plat = x => { const a = x.w.events.find(e => e.k === 'asn-cli site').a; return a.filter((_, i) => a[i - 1] === '--platform') }
  const miss = await run(w => { w.jobs = [{ name: 'other', conclusion: 'success' }] })
  aborts(miss, 1, /--with-play yes 或 --with-play no/)
  assert.ok(!kinds(miss.w).includes('sign'))
  assert.ok(!/other|conclusion/.test(miss.r.error), '不貼 API 原文')
  assert.deepEqual(plat(await run(w => { w.jobs = [{ name: 'android-upload', conclusion: 'success' }] })), ['官網', 'Play'])
  const f = await run(w => { w.jobs = [{ name: 'android-upload', conclusion: 'failure' }] })
  assert.deepEqual(plat(f), ['官網'])
  assert.ok(f.w.logs.some(l => /android-upload 這個 job 沒有成功/.test(l)))
  assert.deepEqual(plat(await run(w => { w.jobs = [] }, { withPlay: 'no' })), ['官網'])
  assert.deepEqual(plat(await run(w => { w.jobs = [] }, { withPlay: 'yes' })), ['官網', 'Play'])
})

// ---- 來源綁定：任一項不符，都在簽章前中止
const sourceBad = {
  '標籤 commit 不在 origin/main 上': w => { w.ancestor = false },
  '標籤上的 asn-release.yml 與 origin/main 不同': w => { w.wfBlob.main = 'other' },
  '來源證明驗不過': w => { w.attest = false },
  '沒有成功的 run': w => { w.run.conclusion = 'failure' },
  'run 的 path 不是 asn-release.yml': w => { w.run.path = '.github/workflows/other.yml' },
  'run 的 event 不是 push': w => { w.run.event = 'workflow_dispatch' },
  'run 的 head_sha 不是標籤': w => { w.run.head_sha = 'c'.repeat(40) },
  'artifact 名稱不在白名單': w => { w.artifacts.push({ ...w.artifacts[0], id: 9, name: 'evil-artifact' }) },
  'artifact 已過期': w => { w.artifacts[1].expired = true },
  'artifact 的 digest 與下載的 zip 不同': w => { w.artifacts[0].digest = `sha256:${'0'.repeat(64)}` },
  'artifact 沒有 digest': w => { delete w.artifacts[0].digest },
  'artifact 屬於別的 run': w => { w.artifacts[2].workflow_run.id = 1 },
  'artifact 的 head_sha 不是標籤': w => { w.artifacts[2].workflow_run.head_sha = 'c'.repeat(40) },
  '缺安裝檔 artifact': w => { w.artifacts = w.artifacts.filter(a => a.name !== 'asn-installer-unsigned') },
  'SHA256SUMS.txt 與安裝檔不符': w => { w.zips[1] = buildZip([{ name: EXE_NAME, data: w.exe }, { name: 'SHA256SUMS.txt', data: Buffer.from(`${'1'.repeat(64)}  ${EXE_NAME}\n`) }]); w.artifacts[0].digest = `sha256:${sha256(w.zips[1])}` },
  '官網紀錄草稿不合規則（HTML 標籤）': w => { w.zips[2] = buildZip([{ name: 'site-record-draft.json', data: Buffer.from(JSON.stringify({ ...w.draft, items: ['<script>x</script>'] })) }]); w.artifacts[1].digest = `sha256:${sha256(w.zips[2])}` },
}
for (const [name, mod] of Object.entries(sourceBad)) {
  test(`來源綁定：${name} → 簽章前中止，沒有任何發布動作`, async () => {
    const x = await run(mod)
    assert.equal(x.r.ok, false)
    assert.ok(x.r.failedStep <= 2, `卡在第 ${x.r.failedStep} 步：${x.r.error}`)
    assert.ok(!kinds(x.w).includes('sign'), '不該簽章')
    assert.deepEqual(published(x.w), [])
    assert.equal(x.w.events.filter(e => e.k === 'asn-cli send').length, 1)
  })
}

test('多個成功 run：中止並要求 --run-id；給了 --run-id 就用那一個；指到別的標籤的 run 也擋', async () => {
  const two = w => { w.runs = [w.run, { ...w.run, id: 556 }] }
  aborts(await run(two), 1, /--run-id/)
  const y = await run(two, { runId: '555' })
  assert.equal(y.r.ok, true, y.r.error)
  aborts(await run(w => { w.run.head_sha = 'd'.repeat(40) }, { runId: '555' }), 1, /head_sha/)
})

// ---- 起手檢查
const startBad = {
  '淺複製': [w => { w.shallow = true }, /淺複製/],
  'site/ 歷史讀不到': [w => { w.hist = '' }, /git 歷史/],
  '工作樹有別的改動': [w => { w.status = ' M relay/asn/src/x.rs\n M site/public/index.html' }, /不乾淨/],
  'HEAD 不是標籤的 commit': [w => { w.head = 'e'.repeat(40) }, /HEAD/],
  '標籤 commit 還沒在 origin': [w => { w.contains = '' }, /origin/],
  'gh 沒登入': [w => { w.ghAuth = false }, /gh/],
  'firebase 沒登入': [w => { w.fbWho = 'No authorized accounts, run firebase login' }, /firebase/],
  '金鑰檔不在': [w => { w.keyOk = false }, /金鑰/],
}
for (const [name, [mod, re]] of Object.entries(startBad)) {
  test(`起手檢查：${name} → 第 0 步中止`, async () => {
    const x = await run(mod)
    aborts(x, 0, re)
    assert.ok(!kinds(x.w).includes('sign'))
    assert.deepEqual(published(x.w), [])
  })
}
test('起手檢查：只有兩個網站檔有改動是允許的（重跑）', async () => {
  const x = await run(w => { w.status = ' M site/public/update/latest.json\n M site/public/index.html' })
  assert.equal(x.r.ok, true, x.r.error)
})
test('起手檢查：真的發布時沒有群組代號就中止', async () => {
  const x = await run(null, { room: null })
  assert.equal(x.r.failedStep, 0)
  assert.match(x.r.error, /群組/)
})

// ---- 版本不退
test('版本不退：線上較新→中止；相等→要 --same-version；較舊→通過', async () => {
  aborts(await run(w => { w.onlineVersion = '0.2.38' }, { sameVersion: true }), 6, /倒退/)
  aborts(await run(w => { w.onlineVersion = V }), 6, /--same-version/)
  assert.equal((await run(w => { w.onlineVersion = V }, { sameVersion: true })).r.ok, true)
  assert.equal((await run(w => { w.onlineVersion = '0.2.36' })).r.ok, true)
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
})

// ---- 驗簽擋在發 Release 之前
const sigBad = {
  '簽章是別的檔案的': 'wrongFile',
  'trusted comment 的 file: 不是這個安裝檔': 'wrongName',
  '演算法標記是 Ed（非預雜湊）': 'plainEd',
}
for (const [name, mode] of Object.entries(sigBad)) {
  test(`驗簽不過就不發 Release、不部署：${name}`, async () => {
    const x = await run(w => { w.signMode = mode })
    aborts(x, 4, /驗簽沒過/)
    assert.deepEqual(published(x.w), [])
    assert.ok(kinds(x.w).includes('sign'))
  })
}

// ---- --dry-run
test('--dry-run：只跑到版本不退，不呼叫任何發布類函式、不貼群組、不寫工作樹', async () => {
  const x = await run(null, { dryRun: true })
  assert.equal(x.r.ok, true, x.r.error)
  assert.equal(x.r.completed.length, 7)
  assert.deepEqual(published(x.w), [])
  assert.ok(!kinds(x.w).includes('asn-cli send'))
  assert.ok(!kinds(x.w).includes('tests'))
  assert.equal(fs.readFileSync(path.join(x.repo, 'site/public/update/latest.json'), 'utf8'), '{"version":"0.2.36"}\n')
  assert.equal(fs.readFileSync(path.join(x.repo, 'site/public/index.html'), 'utf8'), OLD_INDEX)
  assert.ok(fs.existsSync(path.join(x.r.dir, 'site-out', 'latest.json')), '產物寫在暫存資料夾')
  assert.ok(x.r.dir.startsWith(os.tmpdir()))
})
test('--dry-run 失敗時也不貼群組（只印在終端機）', async () => {
  const x = await run(w => { w.ancestor = false }, { dryRun: true })
  assert.equal(x.r.ok, false)
  assert.ok(!kinds(x.w).includes('asn-cli send'))
  assert.ok(x.w.logs.some(l => /卡在第 1 步/.test(l)))
})

// ---- 失敗就停、貼群組
test('失敗就停：Release 失敗後不部署；群組訊息寫「卡在第 N 步、已完成」且不貼外部錯誤原文', async () => {
  const x = await run(w => { w.publishFails = true })
  aborts(x, 7)
  assert.ok(!kinds(x.w).includes('firebase deploy'))
  const send = x.w.events.find(e => e.k === 'asn-cli send').a
  assert.match(send[4], /已完成：0 起手檢查、1 來源綁定/)
  assert.ok(!/release failed/.test(send[4]))
  assert.deepEqual(send.slice(0, 4), ['send', '--room', 'room-1', '--body'])
})
test('失敗就停：部署失敗不寫官網紀錄；官網紀錄失敗不貼完成、不提交', async () => {
  const a = await run(w => { w.firebaseDeployFails = true })
  aborts(a, 8)
  assert.ok(!kinds(a.w).includes('asn-cli site'))
  const c = await run(w => { w.asnStatus.site = 1 })
  aborts(c, 10)
  assert.ok(!c.w.events.some(e => e.k === 'asn-cli send' && /發版完成/.test(e.a[4])))
  assert.ok(!kinds(c.w).includes('git push'))
})
test('線上核對一直不過（上線的 .sig 不對）→ 第 9 步中止，不寫官網紀錄', async () => {
  const y = world()
  const orig = y.deps.fetchFn
  y.deps.fetchFn = async url => { const u = new URL(url); return y.w.deployed && u.pathname.endsWith('.sig') ? { ok: true, status: 200, text: async () => 'WRONG' } : orig(url) }
  const r = await localSignPublish(y.opts, y.deps)
  assert.equal(r.failedStep, 9)
  assert.ok(!kinds(y.w).includes('asn-cli site'))
})
test('群組貼文失敗：終端機要印出（不當成沒事）', async () => {
  const x = world(w => { w.ancestor = false })
  x.w.asnStatus.send = 1
  const r = await localSignPublish(x.opts, x.deps)
  assert.equal(r.ok, false)
  assert.ok(x.w.logs.some(l => /貼群組失敗（結束碼 1）/.test(l)))
})

// ---- 提交回 main
test('提交回 main：暫存區有別的檔→中止、不提交', async () => {
  const x = await run(w => { w.staged = 'relay/asn/foo.rs\nsite/public/index.html' })
  aborts(x, 12, /暫存區/)
  assert.ok(!kinds(x.w).includes('git commit'))
})
test('提交回 main：相關測試沒過→不提交', async () => {
  const b = await run(w => { w.testsOk = false })
  aborts(b, 12, /測試/)
  assert.ok(!kinds(b.w).includes('git commit'))
})
test('提交回 main：標籤落後 origin/main→提交以最新 origin/main 為父、只含兩個網站檔、推的是該提交', async () => {
  const NEWMAIN = 'd'.repeat(40)
  const x = await run(w => { w.originMain = NEWMAIN })
  assert.equal(x.r.ok, true, x.r.error)
  assert.equal(x.w.wtBase, NEWMAIN, '暫存 worktree 要從最新 origin/main 開')
  assert.deepEqual(Object.keys(x.w.wtFiles).sort(), ['site/public/index.html', 'site/public/update/latest.json'])
  assert.equal(JSON.parse(x.w.wtFiles['site/public/update/latest.json']).version, V, '內容是本次產生的版本')
  assert.match(x.w.wtFiles['site/public/index.html'], new RegExp(`ASN_${V}_x64-setup`))
  assert.deepEqual(x.w.events.find(e => e.k === 'git commit').a.slice(-3), ['--', 'site/public/update/latest.json', 'site/public/index.html'])
  const push = x.w.events.find(e => e.k === 'git push').a
  assert.deepEqual(push, ['push', 'origin', `${'f'.repeat(40)}:main`])
  assert.ok(!push.includes('HEAD:main') && !push.includes('--force'))
  assert.ok(kinds(x.w).includes('git worktree remove'), '暫存 worktree 要清掉')
})
test('提交回 main：標籤之後最新 main 上的網站檔被改過→中止、不提交不推送', async () => {
  const x = await run(w => { w.originMain = 'd'.repeat(40); w.mainBlobs['site/public/index.html'] = 'someone-else' })
  aborts(x, 12, /不覆蓋/)
  assert.ok(!kinds(x.w).includes('git push') && !kinds(x.w).includes('git commit'))
})
test('提交回 main：推送被拒→重新 fetch 重做（最多 3 次）；用盡就中止並貼群組', async () => {
  const a = await run(w => { w.pushFailTimes = 2 })
  assert.equal(a.r.ok, true, a.r.error)
  assert.equal(a.w.pushCount, 3)
  assert.ok(a.w.events.filter(e => e.k === 'git fetch').length >= 3 + 1, '每次重做前都重新 fetch')
  assert.equal(kinds(a.w).filter(k => k === 'git commit').length, 3)
  const b = await run(w => { w.pushFailTimes = 99 })
  aborts(b, 12, /連續被拒 3 次/)
  assert.equal(b.w.pushCount, 3)
  assert.ok(!b.w.events.some(e => e.k === 'git push' && e.a.includes('--force')))
})
test('提交回 main：兩個網站檔沒變就不提交', async () => {
  const x = await run(w => { w.siteChanged = '' })
  assert.equal(x.r.ok, true)
  assert.ok(!kinds(x.w).includes('git commit') && !kinds(x.w).includes('git push'))
})

// ---- 金鑰與密碼
test('金鑰與密碼不出現在傳給任何注入函式的參數與輸出', async () => {
  const x = world()
  // 簽章函式回傳一堆含秘密的東西，流程不得轉印或轉傳
  x.deps.signer.check = async () => ({ ok: true, keyFile: `C:/keys/${SECRET_KEY}`, password: SECRET_PASSWORD })
  const r = await localSignPublish(x.opts, x.deps)
  assert.equal(r.ok, true, r.error)
  const dump = JSON.stringify([x.w.events, x.w.logs, r.completed, x.w.releaseArgs && Object.keys(x.w.releaseArgs)])
  assert.ok(!dump.includes(SECRET_PASSWORD) && !dump.includes(SECRET_KEY), '秘密外洩')
  // 簽章函式自己只收到安裝檔路徑（密碼由它自己走環境變數，不經過流程）
  assert.equal(x.w.events.find(e => e.k === 'sign').a.length, 1)
})

test('parseArgs：旗標與錯誤', () => {
  const p = parseArgs(['--version', '0.2.37', '--dry-run', '--with-play', 'no', '--same-version', '--run-id', '12', '--items-file', 'x.json', '--room', 'r'])
  assert.deepEqual([p.tag, p.version, p.dryRun, p.withPlay, p.sameVersion, p.runId, p.itemsFile, p.room, p.error], ['v0.2.37', '0.2.37', true, 'no', true, '12', 'x.json', 'r', null])
  for (const bad of [[], ['--tag', 'v0.2.37-rc1'], ['--tag', 'v1.2.3', '--version', '1.2.4'], ['--tag', 'v1.2.3', '--with-play', 'maybe'], ['--tag', 'v1.2.3', '--run-id', 'x'], ['--tag', 'v1.2.3', '--zzz']]) {
    assert.ok(parseArgs(bad).error, bad.join(' '))
  }
})

test('--items-file：優先於 CI 草稿，仍過同一組檢查', async () => {
  const f = path.join(os.tmpdir(), `items-${process.pid}.json`)
  fs.writeFileSync(f, JSON.stringify({ date: '2026-11-21', items: ['人工改過的條目'] }))
  const ok = await run(w => { w.artifacts = w.artifacts.filter(a => a.name !== 'asn-site-draft') }, { itemsFile: f })
  assert.equal(ok.r.ok, true, ok.r.error)
  assert.ok(ok.w.events.find(e => e.k === 'asn-cli site').a.includes('人工改過的條目'))
  fs.writeFileSync(f, JSON.stringify(['<b>x</b>']))
  const bad = await run(null, { itemsFile: f })
  assert.equal(bad.r.ok, false)
  fs.rmSync(f)
})
test('#1966 asn-cli 失敗：stderr 原文只進終端機，貼到群組的中止訊息不含原文', async () => {
  const SECRET = '原文-不能上群組-7f3a'
  const c = await run(w => { w.asnStatus.site = 1; w.asnStderr = { site: SECRET } })
  aborts(c, 10)
  const posts = c.w.events.filter(e => e.k === 'asn-cli send').map(e => e.a[4])
  assert.ok(posts.length >= 1, '前提：有貼中止訊息')
  assert.ok(posts.every(p => !p.includes(SECRET)), `群組文字不能帶 stderr：${posts.join(' | ')}`)
  assert.ok(posts.some(p => /asn-cli site release 失敗（結束碼 1/.test(p)))
  assert.ok(c.w.logs.some(l => l.includes(SECRET)), '終端機要印出原文')
})
test('#1999 部署之後才中止（推送回 main 用盡）：群組中止訊息標明「線上已是 vX、網站檔沒回 main」；部署前中止不加', async () => {
  const b = await run(w => { w.pushFailTimes = 99 })
  const posts = b.w.events.filter(e => e.k === 'asn-cli send').map(e => e.a[4])
  assert.ok(posts.some(p => /發版中止/.test(p) && /⚠ 線上已是 v\d+\.\d+\.\d+、網站檔沒回 main/.test(p)), posts.join(' | '))
  const c = await run(w => { w.asnStatus.site = 1 }) // 第 10 步（部署之後）
  assert.ok(c.w.events.filter(e => e.k === 'asn-cli send').some(e => /線上已是/.test(e.a[4])))
  const a = await run(w => { w.firebaseDeployFails = true }) // 第 8 步部署本身失敗
  assert.ok(!a.w.events.filter(e => e.k === 'asn-cli send').some(e => /線上已是/.test(e.a[4])), '部署沒成功不能說線上已更新')
})

// ---- #1964 Linux 項暫時移除：不靜默
test('#1964 有發 Linux（有 linux-v 標籤）：只寫 log，不貼群組', async () => {
  const x = await run(w => { w.onlineLinux = true; w.linuxTag = true })
  assert.equal(x.r.ok, true, x.r.error)
  assert.ok(x.w.logs.some(l => /Linux 項已暫時移除.*等 Linux 發佈補回/.test(l)), x.w.logs.join(' | '))
  const posts = x.w.events.filter(e => e.k === 'asn-cli send').map(e => e.a[4])
  assert.ok(!posts.some(p => /Linux 更新資訊暫停/.test(p)), posts.join(' | '))
})
test('#1964 這版不發 Linux（沒有 linux-v 標籤）：log＋群組通知都有，寫明停在上一版', async () => {
  const x = await run(w => { w.onlineLinux = true; w.linuxTag = false })
  assert.equal(x.r.ok, true, x.r.error)
  assert.ok(x.w.logs.some(l => /Linux 項已暫時移除.*Linux 使用者停在上一版/.test(l)))
  const posts = x.w.events.filter(e => e.k === 'asn-cli send').map(e => e.a[4])
  assert.ok(posts.some(p => /這版不發 Linux，Linux 使用者停在上一版，直到下一個有 Linux 的版本/.test(p)), posts.join(' | '))
})
test('#1964 線上本來就沒有 Linux 項：不寫、不貼', async () => {
  const x = await run(w => { w.onlineLinux = false })
  assert.ok(!x.w.logs.some(l => /Linux 項已暫時移除/.test(l)))
  assert.ok(!x.w.events.some(e => e.k === 'asn-cli send' && /Linux 更新資訊暫停/.test(e.a[4])))
})
