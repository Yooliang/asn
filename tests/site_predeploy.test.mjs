// 官網部署前檢查（tools/release/site_predeploy.mjs）。全部用假的 fetch，不連線。
// #1585 起安裝檔放 GitHub Release、官網路徑由 firebase.json 轉址：官網目錄不准有安裝檔、清單指的版本要在 GitHub 上下載得到；
// 下載區（收發室橋的 zip）照舊：缺檔從線上補、對不起來就擋、全部都在時不連網。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { githubProblems, installerUrlProblem, installerUrlProblems, installersInPublic, predeploy, wantedFiles } from '../tools/release/site_predeploy.mjs'
import { INSTALLER_FILE_RE, githubUrl, githubUrlForSite } from '../tools/release/github_release.mjs'

const BASE = 'https://asnmessenger.web.app'
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const EXE = Buffer.from('fake installer bytes')
const SIG = 'fake-minisign-signature'
const APK = Buffer.from('fake apk bytes')
const ZIP = Buffer.from('fake zip bytes')

function makeSite({ zip = false, manifest = true, put = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-predeploy-'))
  const w = (rel, data) => { const f = path.join(dir, 'public', ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data) }
  w('update/latest.json', JSON.stringify({ version: '0.1.98', platforms: { 'windows-x86_64': { signature: SIG, url: `${BASE}/update/ASN_0.1.98_x64-setup.exe` } } }))
  w('update/android.json', JSON.stringify({ version: '0.1.96', url: `${BASE}/update/ASN_0.1.96_android.apk`, sha256: sha(APK), bytes: APK.length }))
  if (manifest) w('download/downloads.json', JSON.stringify({ files: {
    'asn-windows.zip': { url: `${BASE}/download/asn-windows.zip`, sha256: sha(ZIP), size: ZIP.length },
    'SKILL.md': { url: 'https://irori.web.app/relay/SKILL.md', sha256: 'x', size: 1 },   // 不是本站的，不管
  } }))
  if (zip) w('download/asn-windows.zip', ZIP)
  for (const rel of put) w(rel, 'x')
  return dir
}

// 假的網路：完整網址 → 內容；HEAD 不回內容；沒有的回 404（帶可丟棄的 body）
function fakeFetch(online, calls = [], { cancelled = { n: 0 } } = {}) {
  return async (url, opts = {}) => {
    calls.push([opts.method ?? 'GET', url, opts])
    const data = online[url]
    if (data === undefined) return { ok: false, status: 404, headers: { get: () => null }, body: { cancel: async () => { cancelled.n++ } }, arrayBuffer: async () => new ArrayBuffer(0) }
    const buf = Buffer.from(data)
    return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(buf.length) : null) }, body: { cancel: async () => {} }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
  }
}
const GH = {
  [githubUrl('0.1.98', 'ASN_0.1.98_x64-setup.exe')]: EXE,
  [githubUrl('0.1.98', 'ASN_0.1.98_x64-setup.exe.sig')]: `${SIG}\n`,
  [githubUrl('0.1.96', 'ASN_0.1.96_android.apk')]: APK,
}
const SITE_ZIP = { [`${BASE}/download/asn-windows.zip`]: ZIP }
const ALL = { ...GH, ...SITE_ZIP }

// ---- 1. 官網目錄不准有安裝檔 ----
test('官網目錄 update/ 底下有安裝檔（exe、sig、apk 任一）：擋下，而且在連網之前', async () => {
  for (const rel of ['update/ASN_0.1.98_x64-setup.exe', 'update/ASN_0.1.98_x64-setup.exe.sig', 'update/ASN_0.1.95_android.apk']) {
    const dir = makeSite({ zip: true, put: [rel] })
    assert.deepEqual(installersInPublic(dir), [rel])
    const calls = []
    await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(ALL, calls), history: [] }), e => /官網目錄不該再放安裝檔/.test(e.message) && e.message.includes(rel))
    assert.deepEqual(calls, [], rel)
  }
  assert.deepEqual(installersInPublic(makeSite()), [], 'latest.json、android.json 不算')
})

// ---- 2. 清單指的版本要在 GitHub 上下載得到 ----
test('GitHub 上都在、.sig 等於 latest.json 的簽章、APK 大小一致：通過；只問 GitHub 這三個網址與下載區', async () => {
  const dir = makeSite({ zip: true })
  const calls = []
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(ALL, calls), history: [] })
  assert.deepEqual(r.fetched, [])
  assert.deepEqual(r.present, ['download/asn-windows.zip'])
  assert.deepEqual(calls.map(c => [c[0], c[1]]), [
    ['GET', githubUrl('0.1.98', 'ASN_0.1.98_x64-setup.exe.sig')],
    ['HEAD', githubUrl('0.1.98', 'ASN_0.1.98_x64-setup.exe')],
    ['HEAD', githubUrl('0.1.96', 'ASN_0.1.96_android.apk')],
  ])
  for (const c of calls) assert.equal(c[2].redirect, 'follow')
})

test('GitHub 上還沒有這一版：擋下，提示先用 github_release.mjs 發', async () => {
  const dir = makeSite({ zip: true })
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(SITE_ZIP), history: [] }), e => /GitHub Release 上找不到或對不上/.test(e.message) && /github_release\.mjs/.test(e.message))
})

test('GitHub 上的 .sig 跟 latest.json 的簽章不一樣：擋下', async () => {
  const dir = makeSite({ zip: true })
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch({ ...ALL, [githubUrl('0.1.98', 'ASN_0.1.98_x64-setup.exe.sig')]: 'other' }), history: [] }), /跟 latest\.json 的簽章不一樣/)
})

test('GitHub 上 .sig 在、安裝檔不在：擋下', async () => {
  const dir = makeSite({ zip: true })
  const { [githubUrl('0.1.98', 'ASN_0.1.98_x64-setup.exe')]: _, ...rest } = ALL
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(rest), history: [] }), /GitHub 上沒有 .*ASN_0\.1\.98_x64-setup\.exe（HTTP 404）/)
})

test('GitHub 上的 APK 大小跟 android.json 不同：擋下', async () => {
  const dir = makeSite({ zip: true })
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch({ ...ALL, [githubUrl('0.1.96', 'ASN_0.1.96_android.apk')]: 'longer apk bytes!!' }), history: [] }), /android\.json 記的是/)
})

test('GitHub 連不上：擋下（不帶著沒檢查過的連結部署）', async () => {
  const dir = makeSite({ zip: true })
  const fetchFn = async url => { if (url.startsWith('https://github.com/')) throw new Error('ECONNRESET'); return fakeFetch(SITE_ZIP)(url) }
  assert.ok((await githubProblems(dir, { fetchFn })).some(e => /連不上/.test(e)))
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn, history: [] }), /連不上/)
})

test('404 的回應內容要丟棄，否則連線一直開著、部署卡住', async () => {
  const dir = makeSite({ zip: true })
  const cancelled = { n: 0 }
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(SITE_ZIP, [], { cancelled }), history: [] }))
  assert.ok(cancelled.n >= 2, `丟棄了 ${cancelled.n} 個`)
})

// ---- 3. 下載區照舊：缺檔從線上補、對不起來就擋 ----
test('要從線上補的只剩下載區（安裝檔不補）；別站的檔不管', () => {
  assert.deepEqual(wantedFiles(makeSite(), BASE).map(f => f.rel), ['download/asn-windows.zip'])
})

test('下載區缺檔：從線上補回並核對', async () => {
  const dir = makeSite()
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(ALL), history: [] })
  assert.deepEqual(r.fetched, ['download/asn-windows.zip'])
  assert.ok(fs.readFileSync(path.join(dir, 'public', 'download', 'asn-windows.zip')).equals(ZIP))
  assert.deepEqual(installersInPublic(dir), [], '不會補回任何安裝檔')
})

test('下載區：線上補回來的內容不符就擋、不留下壞檔；線上也沒有就擋', async () => {
  const dir = makeSite()
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch({ ...GH, [`${BASE}/download/asn-windows.zip`]: 'tampered' }), history: [] }), /asn-windows\.zip.*(sha256|大小)/)
  assert.ok(!fs.existsSync(path.join(dir, 'public', 'download', 'asn-windows.zip')))
  await assert.rejects(predeploy({ siteDir: makeSite(), base: BASE, fetchFn: fakeFetch(GH), history: [] }), /asn-windows\.zip.*404/)
})

test('下載區：本機有檔但不符就擋、不覆蓋', async () => {
  const dir = makeSite()
  fs.mkdirSync(path.join(dir, 'public', 'download'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'public', 'download', 'asn-windows.zip'), 'old different bytes')
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(ALL), history: [] }), /本機的 download\/asn-windows\.zip/)
  assert.equal(fs.readFileSync(path.join(dir, 'public', 'download', 'asn-windows.zip'), 'utf8'), 'old different bytes')
})

test('下載區清單還沒產生（downloads.json 不存在）：不當成錯誤', async () => {
  const r = await predeploy({ siteDir: makeSite({ manifest: false }), base: BASE, fetchFn: fakeFetch(ALL), history: [] })
  assert.deepEqual(r.fetched, [])
})

test('下載區：要求不壓縮；伺服器還是回壓縮就略過長度比對（有 sha256 照樣比）；明說 identity 卻被截斷就擋', async () => {
  const withHeaders = headers => async (url, opts = {}) => {
    const data = ALL[url]
    if (data === undefined) return { ok: false, status: 404, headers: { get: () => null } }
    const buf = Buffer.from(data)
    if (url.includes('asn-windows.zip')) assert.equal(opts.headers?.['accept-encoding'], 'identity')
    return { ok: true, status: 200, headers: { get: k => (url.includes('asn-windows.zip') ? headers(k, buf) : (k === 'content-length' ? String(buf.length) : null)) }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
  }
  const br = (k, b) => ({ 'content-encoding': 'br', 'content-length': String(b.length - 5) })[k] ?? null
  const r = await predeploy({ siteDir: makeSite(), base: BASE, fetchFn: withHeaders(br), history: [] })
  assert.deepEqual(r.fetched, ['download/asn-windows.zip'])
  const cut = (k, b) => ({ 'content-encoding': 'identity', 'content-length': String(b.length + 100) })[k] ?? null
  await assert.rejects(predeploy({ siteDir: makeSite(), base: BASE, fetchFn: withHeaders(cut), history: [] }), /伺服器說/)
})

// ---- 4. firebase.json：掛著部署前檢查、轉址規則跟程式同一套 ----
const firebase = () => JSON.parse(fs.readFileSync(new URL('../site/firebase.json', import.meta.url), 'utf8'))

test('firebase.json 有掛部署前檢查', () => {
  assert.ok([].concat(firebase().hosting.predeploy ?? []).some(c => /tools[\\/]release[\\/]site_predeploy\.mjs/.test(c)))
})

test('firebase.json 的轉址：update/ 底下的三種安裝檔 302 到 GitHub Release v<版本>，結果跟 githubUrlForSite 一樣；其他不轉', () => {
  const rules = firebase().hosting.redirects
  assert.equal(rules.length, 1)
  const [r] = rules
  assert.equal(r.type, 302)
  // Firebase 用 RE2（具名群組寫成 (?P<名字>…)）；換成 JS 的寫法來測
  const re = new RegExp(r.regex.replace(/\(\?P</g, '(?<'))
  const apply = p => { const m = re.exec(p); return m ? r.destination.replace(/:(file|ver)\b/g, (_, k) => m.groups[k]) : null }
  for (const name of ['ASN_0.2.26_x64-setup.exe', 'ASN_0.2.26_x64-setup.exe.sig', 'ASN_0.1.104_android.apk']) {
    const want = githubUrlForSite(`${BASE}/update/${name}`)
    assert.ok(want, name)
    assert.equal(apply(`/update/${name}`), want, name)
    assert.ok(INSTALLER_FILE_RE.test(name))
  }
  for (const p of ['/update/latest.json', '/update/android.json', '/update/ASN_0.2.26_x64-setup.exe.bak', '/update/ASN_0.2_x64-setup.exe', '/download/asn-windows.zip', '/update/sub/ASN_0.2.26_x64-setup.exe', '/xupdate/ASN_0.2.26_x64-setup.exe']) {
    assert.equal(apply(p), null, p)
  }
  assert.equal(apply('/update/ASN_0.2.26_x64-setup.exe'), 'https://github.com/Yooliang/asn/releases/download/v0.2.26/ASN_0.2.26_x64-setup.exe')
})

// ---- 5. 安裝檔清單的網址（#1585 甲案）：一律寫官網 update/ 底下；以前別站的網址會被靜默略過 ----
const writeJson = (dir, rel, obj) => fs.writeFileSync(path.join(dir, 'public', ...rel.split('/')), JSON.stringify(obj))

test('安裝檔網址的規則：官網 update/ 底下；android 還要過舊版 App 的白名單', () => {
  const ok = [`${BASE}/update/ASN_0.2.27_x64-setup.exe`, `${BASE}/update/ASN_0.2.27_android.apk`]
  for (const u of ok) { assert.equal(installerUrlProblem(u, BASE), '', u); assert.equal(installerUrlProblem(u, BASE, { android: true }), '', u) }
  const bad = [
    undefined, '', 'https://github.com/Yooliang/asn/releases/download/v0.2.27/ASN_0.2.27_x64-setup.exe',
    'http://asnmessenger.web.app/update/ASN_0.2.27_x64-setup.exe', 'https://asnmessenger.web.app.evil.example/update/x.exe',
    `${BASE}/download/asn-windows.zip`, `${BASE}/updatex.exe`, `${BASE}/update/`, `${BASE}/update/../index.html`, `${BASE}/update/a..b.exe`,
  ]
  for (const u of bad) assert.notEqual(installerUrlProblem(u, BASE), '', String(u))
  // 舊版 App 白名單另外不收的：只擋 android（電腦版的更新外掛沒有這層白名單）
  for (const u of [`${BASE}/update/x.apk?v=1`, `${BASE}/update/x.apk#a`, `${BASE}/update/u@x.apk`, `${BASE}/update/a b.apk`, `${BASE}/update/${'a'.repeat(300)}.apk`,
    `${BASE}/update/a"b.apk`, `${BASE}/update/a'b.apk`, `${BASE}/update/a<b.apk`, `${BASE}/update/a\\b.apk`, `${BASE}/update/a\u0001b.apk`, `${BASE}/update/a\u007fb.apk`]) {
    assert.notEqual(installerUrlProblem(u, BASE, { android: true }), '', u)
  }
})

test('跟 Rust 一樣算：長度是 UTF-8 位元組、U+0080～U+009F 也是控制字元', () => {
  // 100 個「測」：字數 100、UTF-8 是 300 位元組，加上前綴一定超過 300 位元組（Rust 的 url.len() 會擋）；字數算法會放行
  const zh = `${BASE}/update/${'測'.repeat(100)}.apk`
  assert.ok(zh.length <= 300 && Buffer.byteLength(zh, 'utf8') > 300, '這個例子要剛好卡在字數與位元組之間')
  assert.notEqual(installerUrlProblem(zh, BASE, { android: true }), '')
  // 少一點、位元組數在 300 以內的中文檔名照樣收
  assert.equal(installerUrlProblem(`${BASE}/update/${'測'.repeat(10)}.apk`, BASE, { android: true }), '')
  // U+0085（NEL）、U+009F：Rust 的 char::is_control 算控制字元
  for (const c of ['\u0080', '\u0085', '\u009f']) assert.notEqual(installerUrlProblem(`${BASE}/update/a${c}b.apk`, BASE, { android: true }), '', `U+${c.charCodeAt(0).toString(16)}`)
  // U+00A0 不是控制字元（Rust 也放行），這裡也不擋
  assert.equal(installerUrlProblem(`${BASE}/update/a\u00a0b.apk`, BASE, { android: true }), '')
})

test('白名單跟舊版 App（android_update.rs 的 url_allowed）同一套：前綴與禁止的字元', () => {
  const rs = fs.readFileSync(new URL('../relay/asn/src-tauri/src/android_update.rs', import.meta.url), 'utf8')
  assert.match(rs, new RegExp(`pub const UPDATE_PREFIX: &str = "${BASE.replace(/\./g, '\\.')}/update/";`))
  assert.match(rs, /url\.len\(\) > 300/)
  for (const c of ['contains("..")', "contains('@')", "contains('?')", "contains('#')"]) assert.ok(rs.includes(`rest.${c}`), `Rust 白名單有 rest.${c}`)
})

test('清單的檔名要是轉址認得的（ASN_<版本>_x64-setup.exe／ASN_<版本>_android.apk），不然轉不到 GitHub', () => {
  const dir = makeSite()
  writeJson(dir, 'update/latest.json', { version: '0.2.27', platforms: { 'windows-x86_64': { signature: 'x', url: `${BASE}/update/ASN-setup-latest.exe` } } })
  assert.match(installerUrlProblems(dir, BASE, []).errors.join(), /firebase\.json 的轉址只認這兩種/)
})

test('電腦版清單指到 GitHub（不是官網路徑）：擋下部署、說明是哪一份，也不連網、不寫檔', async () => {
  const dir = makeSite({ zip: true })
  writeJson(dir, 'update/latest.json', { version: '0.2.27', platforms: { 'windows-x86_64': { signature: 'x', url: 'https://github.com/Yooliang/asn/releases/download/v0.2.27/ASN_0.2.27_x64-setup.exe' } } })
  const calls = []
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(ALL, calls), history: [] }), e => /安裝檔清單的網址不對/.test(e.message) && /update\/latest\.json 的 windows-x86_64/.test(e.message) && /github\.com/.test(e.message))
  assert.deepEqual(calls, [])
})

test('手機清單不合格（別站、或舊版 App 白名單不收）：擋下部署', async () => {
  for (const url of ['https://github.com/Yooliang/asn/releases/download/v0.1.96/ASN_0.1.96_android.apk', `${BASE}/update/ASN_0.1.96_android.apk?x=1`]) {
    const dir = makeSite({ zip: true })
    writeJson(dir, 'update/android.json', { version: '0.1.96', url, sha256: sha(APK), bytes: APK.length })
    await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(ALL), history: [] }), e => /update\/android\.json：/.test(e.message), url)
  }
})

test('android.json 歷史上有不合格的網址：改不了，只記警告、不擋部署', async () => {
  const dir = makeSite({ zip: true })
  const bad = { url: 'https://example.com/old.apk', sha256: 'x', bytes: 1 }
  assert.deepEqual(installerUrlProblems(dir, BASE, [bad]).errors, [])
  const logs = []
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(ALL), history: [bad], log: m => logs.push(m) })
  assert.ok(r.skipped.some(s => s.includes('update/android.json 的歷史') && s.includes('example.com')), JSON.stringify(r.skipped))
  assert.ok(logs.some(m => m.startsWith('注意：')))
})

test('目前 repo 裡的兩份安裝檔清單與 android.json 歷史都合格', () => {
  const site = new URL('../site/', import.meta.url)
  const { errors, warnings } = installerUrlProblems(path.resolve(site.pathname.replace(/^\/([A-Za-z]:)/, '$1')), BASE)
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
})

test('不是 git 倉庫（或沒有歷史）時不出事', async () => {
  const r = await predeploy({ siteDir: makeSite({ zip: true }), fetchFn: fakeFetch(ALL) })
  assert.deepEqual(r.skipped, [])
})
