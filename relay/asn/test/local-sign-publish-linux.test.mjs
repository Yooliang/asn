// tools/release/local_sign_publish.mjs 的 Linux 模式（--platform linux，實作在 linux_publish.mjs）。
// 風格同 local-sign-publish.test.mjs：全部注入假函式，不連網、不碰真金鑰；簽章用測試自己產的拋棄式金鑰。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localSignPublish, parseArgs } from '../../../tools/release/local_sign_publish.mjs'
import { LINUX_WORKFLOW, mergeLinuxLatest, patchLinuxLinks } from '../../../tools/release/linux_publish.mjs'
import { attachToRelease, INSTALLER_FILE_RE } from '../../../tools/release/github_release.mjs'
import { verifyOnlineLinux } from '../../../tools/release/verify_online.mjs'
import { buildZip } from '../../../tools/release/zip_lite.mjs'

const V = '0.2.38'
const TAG = `linux-v${V}`
const SHA = 'a'.repeat(40)
const ORIG = 'b'.repeat(40)
const APP = `ASN_${V}_amd64.AppImage`
const DEB = `ASN_${V}_amd64.deb`
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const b64 = b => Buffer.from(b).toString('base64')

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

const WIN_URL = `https://asnmessenger.web.app/update/ASN_${V}_x64-setup.exe`
const WIN = { signature: 'V0lOLVNJRw==', url: WIN_URL }
const LATEST = { version: V, notes: '- 修正：甲', pub_date: '2026-11-21T01:00:00.000Z', platforms: { 'windows-x86_64': WIN } }
const LATEST_TEXT = `${JSON.stringify(LATEST, null, 2)}\n`
const INDEX = `<html>\n<body>\n<section id="download">\n  <div>\n        <a class="btn" href="${WIN_URL}">下載 Windows 版</a>\n        <div>Edge</div>\n  </div>\n</section>\n</body>\n</html>\n`

function world(mod = () => {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lin-repo-'))
  const wr = (rel, t) => { const f = path.join(repo, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t) }
  wr('tools/release/FIREBASE_TOOLS_VERSION', '15.35.0\n')
  wr('site/public/update/latest.json', LATEST_TEXT)
  wr('site/public/index.html', INDEX)
  const app = Buffer.concat([Buffer.from('AI'), crypto.randomBytes(900)])
  const deb = Buffer.concat([Buffer.from('!<arch>'), crypto.randomBytes(700)])
  const mkZip = (a, d, sums) => buildZip([{ name: APP, data: a }, { name: DEB, data: d }, { name: 'SHA256SUMS.txt', data: Buffer.from(sums ?? `${sha256(a)}  ${APP}\n${sha256(d)}  ${DEB}\n`) }])
  const w = {
    repo, app, deb, events: [], logs: [], deployed: false, mkZip, sigText: '',
    shallow: false, hist: 'h1', ancestor: true, head: ORIG, status: '', contains: 'origin/main', wfBlob: { tag: 'blob1', main: 'blob1' },
    ghAuth: true, fbWho: 'dev@example.com', keyOk: true, attest: true, signMode: 'good', testsOk: true, pushFailTimes: 0, pushCount: 0,
    mainSiteBlobAfter: 'blobA', release: { isDraft: false, assets: [{ name: `ASN_${V}_x64-setup.exe`, size: 5 }, { name: `ASN_${V}_x64-setup.exe.sig`, size: 5 }] },
    run: { id: 555, path: LINUX_WORKFLOW, event: 'push', head_sha: SHA, head_branch: TAG, conclusion: 'success' }, runs: null,
    online: LATEST, attachFails: false, firebaseDeployFails: false, asnStatus: {}, room: 'room-1',
    conf: JSON.stringify({ plugins: { updater: { pubkey: PUBKEY_TEXT } } }),
  }
  w.zip = mkZip(app, deb)
  w.art = { id: 1, name: 'asn-linux-unsigned', expired: false, digest: `sha256:${sha256(w.zip)}`, workflow_run: { id: 555, head_sha: SHA } }
  w.artifacts = [w.art]
  mod(w)
  if (w.zipDirty) { w.art.digest = `sha256:${sha256(w.zip)}` }
  w.runs ??= [w.run]
  const ev = (k, a) => w.events.push({ k, a })
  const git = rawArgs => {
    let args = rawArgs, inDir = null
    if (rawArgs[0] === '-C') { inDir = rawArgs[1]; args = rawArgs.slice(2) }
    const j = args.join(' ')
    if (args[0] === 'worktree') { ev(`git worktree ${args[1]}`, args); return '' }
    if (inDir) {
      if (args[0] === 'add') { ev('git add', args); w.committed = Object.fromEntries(args.slice(2).map(f => [f, fs.readFileSync(path.join(inDir, ...f.split('/')), 'utf8')])); return '' }
      if (j === 'diff --cached --name-only') return 'site/public/update/latest.json\nsite/public/index.html\n'
      if (args[0] === 'commit') { ev('git commit', args); return '' }
      if (j === 'rev-parse HEAD') return `${'f'.repeat(40)}\n`
      throw new Error(`假 git 不認得（-C）：${j}`)
    }
    const blobM = /^rev-parse (\S+):(site\/public\/\S+)$/.exec(j)
    if (blobM) return `${blobM[1] === 'origin/main' ? 'blobA' : w.mainSiteBlobAfter}\n`
    if (args[0] === 'push') { w.pushCount++; ev('git push', args); if (w.pushFailTimes >= w.pushCount) throw new Error('rejected'); return '' }
    if (j === 'rev-parse --is-shallow-repository') return w.shallow ? 'true\n' : 'false\n'
    if (j.startsWith('log -n1')) { if (!w.hist) throw new Error('fatal'); return `${w.hist}\n` }
    if (args[0] === 'fetch') { ev('git fetch', args); return '' }
    if (j === `rev-parse ${TAG}^{commit}`) return `${SHA}\n`
    if (j === 'rev-parse HEAD') return `${w.head}\n`
    if (j === 'rev-parse origin/main') return `${ORIG}\n`
    if (j === 'status --porcelain') return w.status
    if (args[0] === 'status' && args.includes('--')) return ' M site/public/update/latest.json\n M site/public/index.html'
    if (args[0] === 'branch') return w.contains
    if (args[0] === 'merge-base') { if (!w.ancestor) throw new Error('not ancestor'); return '' }
    if (j === `rev-parse ${TAG}:${LINUX_WORKFLOW}`) return `${w.wfBlob.tag}\n`
    if (j === `rev-parse origin/main:${LINUX_WORKFLOW}`) return `${w.wfBlob.main}\n`
    if (j === `show ${TAG}:relay/asn/src-tauri/tauri.conf.json`) return w.conf
    if (j === 'diff --cached --name-only') return ''
    throw new Error(`假 git 不認得：${j}`)
  }
  const gh = args => {
    const j = args.join(' ')
    ev('gh', args)
    if (j === 'auth status') { if (!w.ghAuth) throw new Error('not logged in'); return '' }
    if (args[0] === 'attestation') { if (!w.attest) throw new Error('attestation failed'); return '' }
    if (args[0] === 'release' && args[1] === 'view') {
      if (!w.release) throw new Error('release not found')
      return JSON.stringify({ tagName: `v${V}`, isDraft: w.release.isDraft, assets: w.release.assets })
    }
    if (args[0] === 'release' && args[1] === 'upload') { w.uploaded ??= []; w.uploaded.push(path.basename(args[3])); return '' }
    if (/\/actions\/workflows\/asn-release-linux\.yml\/runs\?/.test(j)) return JSON.stringify({ workflow_runs: w.runs })
    if (/\/actions\/runs\/\d+\/artifacts/.test(j)) return JSON.stringify({ artifacts: w.artifacts })
    if (/\/actions\/runs\/\d+$/.test(j)) return JSON.stringify(w.run)
    throw new Error(`假 gh 不認得：${j}`)
  }
  const siteUrl = n => `/update/${encodeURIComponent(n)}`
  const onlineFiles = () => ({
    '/update/latest.json': fs.readFileSync(path.join(repo, 'site/public/update/latest.json'), 'utf8'),
    [siteUrl(APP)]: app, [siteUrl(DEB)]: deb, [`${siteUrl(APP)}.sig`]: w.sigText,
    '/': fs.readFileSync(path.join(repo, 'site/public/index.html'), 'utf8'),
  })
  const deps = {
    repoRoot: repo, git, gh, log: m => w.logs.push(m), now: () => Date.parse('2026-11-21T00:00:00Z'), sleep: async () => {}, onlineAttempts: 2, onlineIntervalMs: 1,
    mkTmp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'lin-dl-')),
    ghDownloadArtifact: (id, dest) => { ev('gh artifact', [id]); fs.writeFileSync(dest, w.zip) },
    ghDownload: () => {},
    asnCli: async args => { ev(`asn-cli ${args[0]}`, args); return { status: w.asnStatus[args[0]] ?? 0 } },
    firebase: async ({ args }) => {
      ev(`firebase ${args[0]}`, args)
      if (args[0] === 'login:list') return w.fbWho
      if (w.firebaseDeployFails) throw new Error('deploy failed')
      w.deployed = true
      return ''
    },
    signer: {
      check: async () => ({ ok: w.keyOk }),
      sign: async (...a) => {
        const f = a[0]; w.signArgCount = a.length
        ev('sign', [path.basename(f)])
        const bytes = fs.readFileSync(f)
        if (w.signMode === 'tamperAfter') { fs.appendFileSync(f, 'X') }
        const text = w.signMode === 'wrongFile' ? minisign(Buffer.from('other'), APP) : w.signMode === 'wrongName' ? minisign(bytes, 'ASN_9.9.9_amd64.AppImage')
          : w.signMode === 'plainEd' ? minisign(bytes, APP, 'Ed') : minisign(bytes, APP)
        fs.writeFileSync(`${f}.sig`, text)
        w.sigText = text
        return `${f}.sig`
      },
    },
    fetchFn: async url => {
      const u = new URL(url)
      if (!w.deployed && u.pathname === '/update/latest.json') return { ok: true, status: 200, text: async () => JSON.stringify(w.online) }
      const body = onlineFiles()[u.pathname]
      if (body === undefined) return { ok: false, status: 404 }
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
      return { ok: true, status: 200, text: async () => buf.toString('utf8'), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
    },
    attachRelease: async args => { ev('attach', args.files.map(f => f.name)); w.siteAtAttach = fs.readFileSync(path.join(repo, 'site/public/update/latest.json'), 'utf8'); if (w.attachFails) throw new Error('attach failed') },
    runTests: () => { ev('tests', []); return { ok: w.testsOk } },
  }
  const opts = { ...parseArgs(['--platform', 'linux', '--tag', TAG]), room: w.room }
  return { w, deps, opts, repo }
}
const kinds = w => w.events.map(e => e.k)
const PUBLISH = ['attach', 'firebase deploy', 'git push', 'git commit', 'git add']
const published = w => kinds(w).filter(k => PUBLISH.includes(k))
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
}
const read = (x, rel) => fs.readFileSync(path.join(x.repo, ...rel.split('/')), 'utf8')

test('全流程：簽章→附加 Release→部署→提交推送→貼群組；網站檔先寫好才附加；Release 已公開是預期狀態', async () => {
  const x = await run()
  assert.equal(x.r.ok, true, x.r.error)
  const k = kinds(x.w), at = n => k.indexOf(n)
  assert.ok(at('sign') < at('attach') && at('attach') < at('firebase deploy') && at('firebase deploy') < at('git push') && at('git push') < at('asn-cli send'), k.join(' > '))
  assert.deepEqual(x.w.events.find(e => e.k === 'attach').a, [DEB, APP, `${APP}.sig`])
  assert.deepEqual(JSON.parse(x.w.siteAtAttach).platforms['linux-x86_64'].url, `https://asnmessenger.web.app/update/${APP}`)
  assert.ok(!kinds(x.w).includes('asn-cli site'), 'Linux 不寫官網版本紀錄（電腦版已寫）')
  assert.deepEqual(x.w.events.find(e => e.k === 'git push').a, ['push', 'origin', `${'f'.repeat(40)}:main`])
  assert.equal(x.w.committed['site/public/update/latest.json'], read(x, 'site/public/update/latest.json'))
})

test('latest.json 只新增 linux-x86_64，windows 項與其他欄位逐字不變；.sig 原文就是 signature', async () => {
  const x = await run()
  const j = JSON.parse(read(x, 'site/public/update/latest.json'))
  assert.deepEqual(j.platforms['windows-x86_64'], WIN)
  assert.equal(j.version, LATEST.version); assert.equal(j.notes, LATEST.notes); assert.equal(j.pub_date, LATEST.pub_date)
  assert.deepEqual(Object.keys(j.platforms), ['windows-x86_64', 'linux-x86_64'])
  assert.equal(j.platforms['linux-x86_64'].signature, x.w.sigText.replace(/[\r\n]+$/, ''))
  assert.ok(INSTALLER_FILE_RE.test(`ASN_${V}_amd64.AppImage.sig`) && INSTALLER_FILE_RE.test(DEB))
})

test('首頁只加 Linux 連結（deb 與 AppImage），其餘原樣', async () => {
  const x = await run()
  const html = read(x, 'site/public/index.html')
  assert.ok(html.includes(`href="https://asnmessenger.web.app/update/${APP}"`) && html.includes(`href="https://asnmessenger.web.app/update/${DEB}"`))
  assert.equal(html.replace(/\n        <p>Linux[^\n]*<\/p>/, ''), INDEX)
})

test('patchLinuxLinks：首頁已有舊版 Linux 連結（第二次 Linux 發版）→換成這一版，其他連結與文字不動', () => {
  const OLD = '0.2.37'
  const old = patchLinuxLinks(INDEX, OLD)
  assert.ok(old.includes(`ASN_${OLD}_amd64.AppImage`) && old.includes(`ASN_${OLD}_amd64.deb`))
  const next = patchLinuxLinks(old, V)
  assert.ok(next.includes(`/update/${APP}"`) && next.includes(`/update/${DEB}"`))
  assert.ok(!next.includes(OLD), '舊版連結都換掉了')
  assert.equal(next, patchLinuxLinks(INDEX, V), '結果與全新加入一致')
  assert.ok(next.includes(WIN_URL), '電腦版連結不動')
  assert.equal(patchLinuxLinks(next, V), next, '同版重跑結果不變')
})
test('流程：首頁已有舊版 Linux 連結→第二次發版照常完成並換成新版', async () => {
  const x = await run(w => { fs.writeFileSync(path.join(w.repo, 'site/public/index.html'), patchLinuxLinks(INDEX, '0.2.37')) })
  assert.equal(x.r.ok, true, x.r.error)
  const html = read(x, 'site/public/index.html')
  assert.ok(html.includes(`/update/${APP}"`) && !html.includes('0.2.37'))
})
test('mergeLinuxLatest／patchLinuxLinks：版本不符、沒有電腦版項、已有 Linux 項、首頁連結不成對都擋', () => {
  const ok = { latestText: LATEST_TEXT, version: V, signature: 'S', url: 'u' }
  assert.ok(mergeLinuxLatest(ok).latest.platforms['linux-x86_64'])
  assert.throws(() => mergeLinuxLatest({ ...ok, version: '0.2.39' }), /先發電腦版/)
  assert.throws(() => mergeLinuxLatest({ ...ok, latestText: JSON.stringify({ version: V, platforms: {} }) }), /windows-x86_64/)
  assert.throws(() => mergeLinuxLatest({ ...ok, latestText: mergeLinuxLatest(ok).text }), /已經有 linux-x86_64/)
  assert.throws(() => patchLinuxLinks(INDEX.replace('</section>', `<a href="https://asnmessenger.web.app/update/ASN_0.2.37_amd64.deb">d</a></section>`), V), /各一個/)
  assert.throws(() => patchLinuxLinks('<html></html>', V), /找不到下載區/)
})

// ---- Release 附加（真的 attachToRelease，注入 gh 與 fetch）
function attachWorld(release, { tamper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lin-att-'))
  const files = [DEB, APP, `${APP}.sig`].map(n => { const f = path.join(dir, n); fs.writeFileSync(f, `content-of-${n}`); return { name: n, file: f } })
  const calls = []
  const gh = a => {
    calls.push(a)
    if (a[1] === 'view') { if (!release) throw new Error('release not found'); return JSON.stringify({ tagName: `v${V}`, isDraft: release.isDraft, assets: release.assets }) }
    return ''
  }
  const fetchFn = async url => {
    const n = decodeURIComponent(url.split('/').pop())
    const body = Buffer.from(tamper ? 'WRONG' : `content-of-${n}`)
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) }
  }
  return { files, calls, gh, fetchFn, tmp: dir }
}
test('附加：Release 已公開仍可附加三個檔，不建、不轉正式、不改 Latest', async () => {
  const a = attachWorld({ isDraft: false, assets: [{ name: `ASN_${V}_x64-setup.exe`, size: 1 }] })
  const r = await attachToRelease({ version: V, files: a.files, gh: a.gh, ghDownload: () => {}, fetchFn: a.fetchFn, tmp: a.tmp })
  assert.deepEqual(r.attached, [DEB, APP, `${APP}.sig`])
  assert.deepEqual(a.calls.filter(c => c[1] === 'upload').map(c => path.basename(c[3])), [DEB, APP, `${APP}.sig`])
  assert.ok(!a.calls.some(c => ['create', 'edit', 'delete', 'delete-asset'].includes(c[1])))
})
test('附加：同名檔已存在就停，什麼都不上傳（不覆蓋）；Release 不存在也停', async () => {
  const a = attachWorld({ isDraft: false, assets: [{ name: APP, size: 3 }] })
  await assert.rejects(attachToRelease({ version: V, files: a.files, gh: a.gh, ghDownload: () => {}, fetchFn: a.fetchFn, tmp: a.tmp }), /已經有 .*AppImage.*不覆蓋/)
  assert.ok(!a.calls.some(c => c[1] === 'upload'))
  const b = attachWorld(null)
  await assert.rejects(attachToRelease({ version: V, files: b.files, gh: b.gh, ghDownload: () => {}, fetchFn: b.fetchFn, tmp: b.tmp }), /Release 不存在/)
})
test('附加：上傳後下載比對不一致→報錯且不自動刪檔', async () => {
  const a = attachWorld({ isDraft: false, assets: [] }, { tamper: true })
  await assert.rejects(attachToRelease({ version: V, files: a.files, gh: a.gh, ghDownload: () => {}, fetchFn: a.fetchFn, tmp: a.tmp }), /sha256 跟本機的不一樣/)
  assert.ok(!a.calls.some(c => c[1].startsWith('delete')))
})
test('流程：Release 上已有同名檔→簽章前（第 1 步）就停；沒有 Release 也是', async () => {
  const x = await run(w => { w.release.assets.push({ name: DEB, size: 1 }) })
  aborts(x, 1, /已經有 .*deb/)
  assert.ok(!kinds(x.w).includes('sign')); assert.deepEqual(published(x.w), [])
  const y = await run(w => { w.release = null })
  aborts(y, 1, /Release v0\.2\.38 不存在/)
})
test('附加：目標 Release 是草稿就停，什麼都不上傳（官網連結會指到草稿、匿名 404）', async () => {
  const a = attachWorld({ isDraft: true, assets: [] })
  await assert.rejects(attachToRelease({ version: V, files: a.files, gh: a.gh, ghDownload: () => {}, fetchFn: a.fetchFn, tmp: a.tmp }), /還是草稿/)
  assert.ok(!a.calls.some(c => c[1] === 'upload'))
})
test('流程：Release 是草稿→簽章前（第 1 步）就停，不簽章不發布', async () => {
  const x = await run(w => { w.release.isDraft = true })
  aborts(x, 1, /還是草稿/)
  assert.ok(!kinds(x.w).includes('sign')); assert.deepEqual(published(x.w), [])
})
test('貼群組失敗不中止：網站檔已先提交推送，整體仍成功，只記 log；貼群組丟例外也一樣', async () => {
  const x = await run(w => { w.asnStatus.send = 1 })
  assert.equal(x.r.ok, true, x.r.error)
  assert.ok(kinds(x.w).indexOf('git push') >= 0 && kinds(x.w).indexOf('git push') < kinds(x.w).indexOf('asn-cli send'))
  assert.ok(x.w.logs.some(l => /貼群組失敗/.test(l)))
  const y = world()
  y.deps.asnCli = async () => { throw new Error('boom') }
  const r = await localSignPublish(y.opts, y.deps)
  assert.equal(r.ok, true, r.error)
  assert.ok(kinds(y.w).includes('git push'))
})
test('流程：附加失敗→不部署、不貼完成', async () => {
  const x = await run(w => { w.attachFails = true })
  aborts(x, 6)
  assert.ok(!kinds(x.w).includes('firebase deploy'))
  assert.equal(x.w.events.filter(e => e.k === 'asn-cli send').length, 1)
})

test('來源證明：兩個檔都驗，且帶 --repo／--signer-workflow／--source-ref／--source-digest', async () => {
  const x = await run()
  const att = x.w.events.filter(e => e.k === 'gh' && e.a[0] === 'attestation').map(e => e.a)
  assert.equal(att.length, 2)
  assert.deepEqual(att.map(a => path.basename(a[2])).sort(), [APP, DEB].sort())
  for (const a of att) {
    const opt = k => a[a.indexOf(k) + 1]
    assert.deepEqual(a.slice(0, 2), ['attestation', 'verify'])
    assert.equal(opt('--repo'), 'Yooliang/asn')
    assert.equal(opt('--signer-workflow'), `Yooliang/asn/${LINUX_WORKFLOW}`)
    assert.equal(opt('--source-ref'), `refs/tags/${TAG}`)
    assert.equal(opt('--source-digest'), SHA)
  }
})
test('簽章只收一個路徑且只簽 AppImage（不簽 deb、不簽別的）', async () => {
  const x = await run()
  const signs = x.w.events.filter(e => e.k === 'sign')
  assert.equal(signs.length, 1)
  assert.deepEqual(signs[0].a, [APP])
  assert.equal(x.w.signArgCount, 1)
})
test('簽章後檔案被改動→第 3 步中止（簽章前後雜湊要一致），不附加', async () => {
  const x = await run(w => { w.signMode = 'tamperAfter' })
  aborts(x, 3, /簽章過程中 AppImage 被改動/)
  assert.deepEqual(published(x.w), [])
})

// ---- 驗簽不過就不附加
for (const [name, mode] of Object.entries({ '簽章是別的檔案的': 'wrongFile', 'trusted comment 的 file: 不是這個 AppImage': 'wrongName', '演算法標記是 Ed': 'plainEd' })) {
  test(`驗簽不過就不附加、不部署：${name}`, async () => {
    const x = await run(w => { w.signMode = mode })
    aborts(x, 4, /驗簽沒過/)
    assert.deepEqual(published(x.w), [])
  })
}

// ---- 來源綁定與簽章前檢查
const bad = {
  '標籤 commit 不在 origin/main 上': w => { w.ancestor = false },
  '標籤上的 workflow 與 main 不同': w => { w.wfBlob.main = 'other' },
  '來源證明驗不過': w => { w.attest = false },
  'run 的 event 不是 push': w => { w.run.event = 'workflow_dispatch' },
  'artifact 的 head_sha 不是標籤的 commit': w => { w.art.workflow_run.head_sha = 'c'.repeat(40) },
  '沒有成功的 run': w => { w.run.conclusion = 'failure' },
  'run 的 path 不是 asn-release-linux.yml': w => { w.run.path = '.github/workflows/asn-release.yml' },
  'artifact 名稱不在白名單（電腦版的 artifact）': w => { w.artifacts.push({ ...w.art, id: 9, name: 'asn-installer-unsigned' }) },
  'artifact 已過期': w => { w.art.expired = true },
  'artifact 的 digest 與 zip 不同': w => { w.art.digest = `sha256:${'0'.repeat(64)}` },
  'artifact 沒有 digest': w => { delete w.art.digest },
  '缺 artifact': w => { w.artifacts = [] },
  'SHA256SUMS.txt 與 AppImage 不符': w => { w.zip = w.mkZip(w.app, w.deb, `${'1'.repeat(64)}  ${APP}\n${sha256(w.deb)}  ${DEB}\n`); w.zipDirty = true },
  'SHA256SUMS.txt 與 deb 不符': w => { w.zip = w.mkZip(w.app, w.deb, `${sha256(w.app)}  ${APP}\n${'1'.repeat(64)}  ${DEB}\n`); w.zipDirty = true },
  'zip 裡少了 deb': w => { w.zip = buildZip([{ name: APP, data: w.app }, { name: 'SHA256SUMS.txt', data: Buffer.from(`${sha256(w.app)}  ${APP}\n`) }]); w.zipDirty = true },
  '官網 latest.json 還是舊版（電腦版沒發）': w => { fs.writeFileSync(path.join(w.repo, 'site/public/update/latest.json'), `${JSON.stringify({ ...LATEST, version: '0.2.37' })}\n`) },
  '官網 latest.json 已有 linux 項': w => { fs.writeFileSync(path.join(w.repo, 'site/public/update/latest.json'), `${JSON.stringify({ ...LATEST, platforms: { ...LATEST.platforms, 'linux-x86_64': { signature: 'x', url: 'y' } } })}\n`) },
  'HEAD 不是最新 origin/main': w => { w.head = 'c'.repeat(40) },
  '工作樹不乾淨': w => { w.status = ' M README.md' },
  '金鑰檔不在': w => { w.keyOk = false },
}
for (const [name, mod] of Object.entries(bad)) {
  test(`簽章前中止、沒有任何發布動作：${name}`, async () => {
    const x = await run(w => { mod(w) })
    assert.equal(x.r.ok, false)
    assert.ok(x.r.failedStep <= 2, `卡在第 ${x.r.failedStep} 步：${x.r.error}`)
    assert.ok(!kinds(x.w).includes('sign'))
    assert.deepEqual(published(x.w), [])
  })
}

test('找不到 linux run／多個成功 run 就停；給 --run-id 用指定那個；指到別的標籤的 run 也擋', async () => {
  aborts(await run(w => { w.runs = [] }), 1, /找不到這個標籤的成功 run/)
  const two = await run(w => { w.runs = [w.run, { ...w.run, id: 556 }] })
  aborts(two, 1, /用 --run-id/)
  const pick = await run(w => { w.runs = [w.run, { ...w.run, id: 556 }] }, { runId: '555' })
  assert.equal(pick.r.ok, true, pick.r.error)
  aborts(await run(w => { w.run.head_sha = 'c'.repeat(40) }, { runId: '555' }), 1, /不是這個標籤/)
})

// ---- dry-run
test('--dry-run：只到簽章與驗簽（含暫存的網站檔產物），不附加、不部署、不貼群組、不寫工作樹', async () => {
  const x = await run(null, { dryRun: true })
  assert.equal(x.r.ok, true, x.r.error)
  assert.equal(x.r.completed.length, 6)
  assert.deepEqual(published(x.w), [])
  assert.ok(!kinds(x.w).includes('asn-cli send') && !kinds(x.w).includes('tests') && !x.w.uploaded)
  assert.equal(read(x, 'site/public/update/latest.json'), LATEST_TEXT)
  assert.equal(read(x, 'site/public/index.html'), INDEX)
  assert.ok(x.r.dir.startsWith(os.tmpdir()))
  assert.ok(JSON.parse(fs.readFileSync(path.join(x.r.dir, 'site-out', 'latest.json'), 'utf8')).platforms['linux-x86_64'])
})
test('--dry-run 失敗也不貼群組', async () => {
  const x = await run(w => { w.ancestor = false }, { dryRun: true })
  assert.equal(x.r.ok, false)
  assert.ok(!kinds(x.w).includes('asn-cli send'))
})

// ---- 線上與提交
test('線上版本不是這一版（電腦版沒部署）→第 6 步中止，不附加', async () => {
  const x = await run(w => { w.online = { ...LATEST, version: '0.2.37' } })
  aborts(x, 6, /電腦版還沒部署/)
  assert.ok(!x.w.uploaded && !kinds(x.w).includes('attach'))
})
test('線上核對：首頁或 .sig 不對→第 8 步中止，不貼完成、不提交', async () => {
  const y = world()
  const orig = y.deps.fetchFn
  y.deps.fetchFn = async url => (new URL(url).pathname === '/' && y.w.deployed ? { ok: true, status: 200, text: async () => '<html>沒有連結</html>' } : orig(url))
  const r = await localSignPublish(y.opts, y.deps)
  assert.equal(r.failedStep, 8)
  assert.ok(!kinds(y.w).includes('git push'))
  assert.equal(y.w.events.filter(e => e.k === 'asn-cli send').length, 1)
})
test('verifyOnlineLinux：電腦版項被動到、Linux 檔 sha 不對都會被抓到', async () => {
  const L = { signature: 'S', url: `https://asnmessenger.web.app/update/${APP}`, sigText: 'SIG', appImage: { name: APP, sha256: sha256(Buffer.from('a')), size: 1 }, deb: { name: DEB, sha256: sha256(Buffer.from('d')), size: 1 } }
  const site = { version: V, platforms: { 'windows-x86_64': WIN, 'linux-x86_64': { signature: 'S', url: L.url } } }
  const files = {
    '/update/latest.json': JSON.stringify(site), [`/update/${APP}`]: Buffer.from('a'), [`/update/${DEB}`]: Buffer.from('d'), [`/update/${APP}.sig`]: 'SIG',
    '/': `<a href="${L.url}">x</a><a href="https://asnmessenger.web.app/update/${DEB}">d</a><a href="${WIN_URL}">w</a>`,
  }
  const mk = f => async url => { const b = f[new URL(url).pathname]; return b === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, text: async () => String(b), arrayBuffer: async () => { const u = Buffer.from(b); return u.buffer.slice(u.byteOffset, u.byteOffset + u.length) } } }
  const expected = { version: V, windows: WIN, linux: L }
  const base = { expected, fetchFn: mk(files), sleep: async () => {}, attempts: 1 }
  assert.equal((await verifyOnlineLinux(base)).ok, true)
  const touched = { ...files, '/update/latest.json': JSON.stringify({ ...site, platforms: { ...site.platforms, 'windows-x86_64': { ...WIN, signature: 'X' } } }) }
  const r1 = await verifyOnlineLinux({ ...base, fetchFn: mk(touched) })
  assert.ok(!r1.ok && r1.problems.some(p => /電腦版項被動到/.test(p)))
  const r2 = await verifyOnlineLinux({ ...base, fetchFn: mk({ ...files, [`/update/${DEB}`]: Buffer.from('X') }) })
  assert.ok(!r2.ok && r2.problems.some(p => /sha256/.test(p)))
})
test('提交回 main：最新 origin/main 上的網站檔與發版開始時不同→中止、不提交不推送', async () => {
  const x = await run(w => { w.mainSiteBlobAfter = 'changed' })
  aborts(x, 9, /之後有人改過/)
  assert.deepEqual(published(x.w).filter(k => k.startsWith('git')), [])
})
test('提交回 main：推送被拒→重試；用盡就中止；相關測試沒過不提交', async () => {
  const x = await run(w => { w.pushFailTimes = 1 })
  assert.equal(x.r.ok, true); assert.equal(x.w.pushCount, 2)
  aborts(await run(w => { w.pushFailTimes = 9 }), 9, /連續被拒 3 次/)
  const t = await run(w => { w.testsOk = false })
  aborts(t, 9, /相關測試沒過/)
})

test('parseArgs：--platform linux 的標籤與錯誤；電腦版預設不變', () => {
  const o = parseArgs(['--platform', 'linux', '--version', V])
  assert.equal(o.error, null); assert.equal(o.tag, TAG); assert.equal(o.version, V); assert.equal(o.platform, 'linux')
  assert.equal(parseArgs(['--platform', 'linux', '--tag', TAG]).version, V)
  assert.match(parseArgs(['--platform', 'linux', '--tag', `v${V}`]).error, /標籤格式不對/)
  assert.match(parseArgs(['--tag', TAG]).error, /標籤格式不對/)
  assert.match(parseArgs(['--platform', 'mac', '--tag', `v${V}`]).error, /--platform/)
  assert.match(parseArgs(['--platform', 'linux', '--tag', TAG, '--same-version']).error, /Linux 版不用/)
  const w = parseArgs(['--tag', `v${V}`])
  assert.equal(w.platform, 'windows'); assert.equal(w.version, V)
})
test('#1966 貼群組失敗：log 要帶 asn-cli 的錯誤原因（例如找不到程式），不是只有結束碼', async () => {
  const y = world()
  y.deps.asnCli = async args => args[0] === 'send' ? { status: 1, stdout: '', stderr: '找不到 asn-cli（試過：asn-cli（PATH））' } : { status: 0, stdout: '', stderr: '' }
  const r = await localSignPublish(y.opts, y.deps)
  assert.equal(r.ok, true, r.error)
  assert.ok(y.w.logs.some(l => /貼群組失敗（結束碼 1：找不到 asn-cli/.test(l)), y.w.logs.join('\n'))
})
