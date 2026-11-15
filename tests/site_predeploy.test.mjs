// 官網部署前檢查（tools/release/site_predeploy.mjs）：缺檔會補、對不起來會擋、全部都在時不連網。全部用假的 fetch，不連線。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { installerUrlProblem, installerUrlProblems, predeploy, wantedFiles } from '../tools/release/site_predeploy.mjs'

const BASE = 'https://asnmessenger.web.app'
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const EXE = Buffer.from('fake installer bytes')
const APK = Buffer.from('fake apk bytes')
const ZIP = Buffer.from('fake zip bytes')

function makeSite({ exe = false, apk = false, zip = false, manifest = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-predeploy-'))
  const w = (rel, data) => { const f = path.join(dir, 'public', ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data) }
  w('update/latest.json', JSON.stringify({ version: '0.1.98', platforms: { 'windows-x86_64': { signature: 'x', url: `${BASE}/update/ASN_0.1.98_x64-setup.exe` } } }))
  w('update/android.json', JSON.stringify({ version: '0.1.96', url: `${BASE}/update/ASN_0.1.96_android.apk`, sha256: sha(APK), bytes: APK.length }))
  if (manifest) w('download/downloads.json', JSON.stringify({ files: {
    'asn-windows.zip': { url: `${BASE}/download/asn-windows.zip`, sha256: sha(ZIP), size: ZIP.length },
    'SKILL.md': { url: 'https://irori.web.app/relay/SKILL.md', sha256: 'x', size: 1 },   // 不是本站的，不管
  } }))
  if (exe) w('update/ASN_0.1.98_x64-setup.exe', EXE)
  if (apk) w('update/ASN_0.1.96_android.apk', APK)
  if (zip) w('download/asn-windows.zip', ZIP)
  return dir
}

// 假的線上：路徑 → 內容；沒有的回 404
function fakeFetch(online, calls = []) {
  return async url => {
    calls.push(url)
    const rel = decodeURIComponent(new URL(url).pathname.slice(1))
    const data = online[rel]
    if (data === undefined) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    const buf = Buffer.from(data)
    return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(buf.length) : null) }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
  }
}
// 假的線上，可指定表頭與回應長度（模擬 Firebase 對 exe 回 content-encoding: br、content-length 是壓縮後的長度）
function fakeFetchWith({ headers, bodies = {} }, seen = []) {
  return async (url, opts) => {
    seen.push(opts)
    const rel = decodeURIComponent(new URL(url).pathname.slice(1))
    const data = bodies[rel]
    if (data === undefined) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    const buf = Buffer.from(data)
    return { ok: true, status: 200, headers: { get: k => headers(k, buf) }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
  }
}
const onlineAll = { 'update/ASN_0.1.98_x64-setup.exe': EXE, 'update/ASN_0.1.96_android.apk': APK, 'download/asn-windows.zip': ZIP }

test('清單裡只列指到本站的檔案（別站的不管），安裝檔旁邊的 .sig 是選用', () => {
  const rels = wantedFiles(makeSite(), BASE).map(f => f.rel).sort()
  assert.deepEqual(rels, ['download/asn-windows.zip', 'update/ASN_0.1.96_android.apk', 'update/ASN_0.1.98_x64-setup.exe', 'update/ASN_0.1.98_x64-setup.exe.sig'])
})

test('全部都在本機：不連網', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  const calls = []
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll, calls) })
  // 唯一會問線上的是選用的 .sig（本機沒有）；其餘三個檔案都不連網
  assert.deepEqual(calls.filter(u => !u.endsWith('.sig')), [])
  assert.deepEqual(r.fetched, [])
  assert.equal(r.present.length, 3)
})

test('缺檔會從線上補回並核對（sha256 或大小）', async () => {
  const dir = makeSite()
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll) })
  assert.deepEqual(r.fetched.sort(), ['download/asn-windows.zip', 'update/ASN_0.1.96_android.apk', 'update/ASN_0.1.98_x64-setup.exe'])
  assert.ok(fs.readFileSync(path.join(dir, 'public', 'update', 'ASN_0.1.96_android.apk')).equals(APK))
  assert.deepEqual(r.skipped, ['update/ASN_0.1.98_x64-setup.exe.sig'])
})

test('線上補回來的 sha256 不符：擋下並說明是哪個檔，也不留下壞檔', async () => {
  const dir = makeSite({ exe: true, zip: true })
  await assert.rejects(
    predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch({ ...onlineAll, 'update/ASN_0.1.96_android.apk': 'tampered' }) }),
    /ASN_0\.1\.96_android\.apk.*(sha256|大小)/,
  )
  assert.ok(!fs.existsSync(path.join(dir, 'public', 'update', 'ASN_0.1.96_android.apk')))
})

test('線上也沒有：擋下並說明是哪個檔', async () => {
  const dir = makeSite({ apk: true, zip: true })
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch({}) }), /ASN_0\.1\.98_x64-setup\.exe.*404/)
})

test('伺服器說的大小與實際下載的不同（下載被截斷）：擋下', async () => {
  const dir = makeSite({ apk: true, zip: true })
  const fetchFn = async () => ({ ok: true, status: 200, headers: { get: k => (k === 'content-length' ? '9999' : null) }, arrayBuffer: async () => EXE.buffer.slice(EXE.byteOffset, EXE.byteOffset + EXE.length) })
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn }), /ASN_0\.1\.98_x64-setup\.exe.*9999/)
})

test('本機有檔但 sha256 不符：擋下，不覆蓋', async () => {
  const dir = makeSite({ exe: true, zip: true })
  fs.writeFileSync(path.join(dir, 'public', 'update', 'ASN_0.1.96_android.apk'), 'old different bytes')
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll) }), /本機的 update\/ASN_0\.1\.96_android\.apk/)
  assert.equal(fs.readFileSync(path.join(dir, 'public', 'update', 'ASN_0.1.96_android.apk'), 'utf8'), 'old different bytes')
})

test('下載區清單還沒產生（downloads.json 不存在）：不當成錯誤', async () => {
  const dir = makeSite({ exe: true, apk: true, manifest: false })
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll) })
  assert.deepEqual(r.fetched, [])
})

test('firebase.json 有掛部署前檢查', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../site/firebase.json', import.meta.url), 'utf8'))
  assert.ok([].concat(cfg.hosting.predeploy ?? []).some(c => /tools[\\/]release[\\/]site_predeploy\.mjs/.test(c)))
  assert.ok(fs.existsSync(new URL('../tools/release/site_predeploy.mjs', import.meta.url)))
})

test('下載時要求不壓縮（accept-encoding: identity）', async () => {
  const dir = makeSite({ apk: true, zip: true })
  const seen = []
  await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetchWith({ headers: (k, b) => (k === 'content-length' ? String(b.length) : null), bodies: onlineAll }, seen) })
  assert.ok(seen.length >= 1)
  for (const o of seen) assert.equal(o?.headers?.['accept-encoding'], 'identity')
})

test('伺服器還是回壓縮（content-encoding: br，content-length 是壓縮後的長度）：略過長度比對、能通過', async () => {
  const dir = makeSite({ apk: true, zip: true })
  const headers = (k, b) => ({ 'content-encoding': 'br', 'content-length': String(b.length - 5) })[k] ?? null   // 壓縮後比較短
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetchWith({ headers, bodies: onlineAll }) })
  assert.ok(r.fetched.includes('update/ASN_0.1.98_x64-setup.exe'))
  assert.ok(fs.readFileSync(path.join(dir, 'public', 'update', 'ASN_0.1.98_x64-setup.exe')).equals(EXE))
})

test('回壓縮時，有 sha256 的檔案照樣比：內容被改過會被擋', async () => {
  const dir = makeSite({ exe: true, zip: true })
  const headers = (k, b) => ({ 'content-encoding': 'br', 'content-length': String(b.length - 1) })[k] ?? null
  await assert.rejects(
    predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetchWith({ headers, bodies: { ...onlineAll, 'update/ASN_0.1.96_android.apk': 'tampered!!' } }) }),
    /ASN_0\.1\.96_android\.apk/,
  )
})

test('明說 identity 但被截斷（content-length 比實際長）：擋下', async () => {
  const dir = makeSite({ apk: true, zip: true })
  const headers = (k, b) => ({ 'content-encoding': 'identity', 'content-length': String(b.length + 100) })[k] ?? null
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetchWith({ headers, bodies: onlineAll }) }), /ASN_0\.1\.98_x64-setup\.exe.*伺服器說/)
})

// ---- 歷史 APK：以前的 android.json 指過、現在清單已不指到的檔案，也要保住 ----
const OLD = Buffer.from('fake old apk bytes')
const oldEntry = { url: `${BASE}/update/ASN_0.1.95_android.apk`, sha256: sha(OLD), bytes: OLD.length }

test('歷史 APK：本機沒有、線上有 → 補回並核對，不會被這次部署蓋掉', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  const r = await predeploy({ siteDir: dir, fetchFn: fakeFetch({ 'update/ASN_0.1.95_android.apk': OLD }), history: [oldEntry] })
  assert.ok(r.fetched.includes('update/ASN_0.1.95_android.apk'))
  assert.deepEqual(fs.readFileSync(path.join(dir, 'public', 'update', 'ASN_0.1.95_android.apk')), OLD)
})

test('歷史 APK：本機和線上都沒有（早就掉了）→ 不擋部署，記在略過', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  const r = await predeploy({ siteDir: dir, fetchFn: fakeFetch({}), history: [oldEntry] })
  assert.ok(r.skipped.includes('update/ASN_0.1.95_android.apk'))
})

test('線上回 404：回應內容要丟棄，否則連線一直開著、部署卡住', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  let cancelled = 0
  const fetchFn = async () => ({ ok: false, status: 404, headers: { get: () => null }, body: { cancel: async () => { cancelled++ } } })
  const r = await predeploy({ siteDir: dir, fetchFn, history: [oldEntry] })
  assert.ok(r.skipped.includes('update/ASN_0.1.95_android.apk'))
  assert.equal(cancelled, r.skipped.length) // 每一個略過的 404 都要丟棄（含線上沒有的 .sig）
})

test('歷史 APK：線上的內容和當時記的 sha256 對不起來 → 擋下', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  await assert.rejects(predeploy({ siteDir: dir, fetchFn: fakeFetch({ 'update/ASN_0.1.95_android.apk': 'tampered' }), history: [oldEntry] }), /sha256|大小/)
})

// ---- 安裝檔清單的網址（#1585 甲案）：一律寫官網 update/ 底下，轉到 GitHub Release 交給 firebase.json；以前別站的網址會被靜默略過 ----
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
    `${BASE}/update/a"b.apk`, `${BASE}/update/a'b.apk`, `${BASE}/update/a<b.apk`, `${BASE}/update/a\b.apk`, `${BASE}/update/a\u0001b.apk`, `${BASE}/update/a\u007fb.apk`]) {
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
  assert.match(rs, new RegExp(`pub const UPDATE_PREFIX: &str = "${BASE.replace(/\./g, '\.')}/update/";`))
  assert.match(rs, /url\.len\(\) > 300/)
  for (const c of ['contains("..")', "contains('@')", "contains('?')", "contains('#')"]) assert.ok(rs.includes(`rest.${c}`), `Rust 白名單有 rest.${c}`)
})

test('電腦版清單指到 GitHub（不是官網路徑）：擋下部署、說明是哪一份，也不連網、不寫檔', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  writeJson(dir, 'update/latest.json', { version: '0.2.27', platforms: { 'windows-x86_64': { signature: 'x', url: 'https://github.com/Yooliang/asn/releases/download/v0.2.27/ASN_0.2.27_x64-setup.exe' } } })
  const calls = []
  await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll, calls), history: [] }), e => /安裝檔清單的網址不對/.test(e.message) && /update\/latest\.json 的 windows-x86_64/.test(e.message) && /github\.com/.test(e.message))
  assert.deepEqual(calls, [])
})

test('手機清單不合格（別站、或舊版 App 白名單不收）：擋下部署', async () => {
  for (const url of ['https://github.com/Yooliang/asn/releases/download/v0.1.96/ASN_0.1.96_android.apk', `${BASE}/update/ASN_0.1.96_android.apk?x=1`]) {
    const dir = makeSite({ exe: true, apk: true, zip: true })
    writeJson(dir, 'update/android.json', { version: '0.1.96', url, sha256: sha(APK), bytes: APK.length })
    await assert.rejects(predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll), history: [] }), e => /update\/android\.json：/.test(e.message), url)
  }
})

test('android.json 歷史上有不合格的網址：改不了，只記警告、不擋部署', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  const bad = { url: 'https://example.com/old.apk', sha256: 'x', bytes: 1 }
  assert.deepEqual(installerUrlProblems(dir, BASE, [bad]).errors, [])
  const logs = []
  const r = await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll), history: [bad], log: m => logs.push(m) })
  assert.ok(r.skipped.some(s => s.includes('update/android.json 的歷史') && s.includes('example.com')), JSON.stringify(r.skipped))
  assert.ok(logs.some(m => m.startsWith('注意：')))
})

test('下載區清單本來就有別站的檔（SKILL.md）：不在安裝檔網址的檢查範圍', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  assert.deepEqual(installerUrlProblems(dir, BASE, []), { errors: [], warnings: [] })
  await predeploy({ siteDir: dir, base: BASE, fetchFn: fakeFetch(onlineAll), history: [] })
})

test('目前 repo 裡的兩份安裝檔清單與 android.json 歷史都合格', () => {
  const site = new URL('../site/', import.meta.url)
  const { errors, warnings } = installerUrlProblems(path.resolve(site.pathname.replace(/^\/([A-Za-z]:)/, '$1')), BASE)
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
})

test('歷史 APK：不是 git 倉庫（或沒有歷史）時不出事', async () => {
  const dir = makeSite({ exe: true, apk: true, zip: true })
  const r = await predeploy({ siteDir: dir, fetchFn: fakeFetch({}) })
  assert.ok(!r.skipped.some(f => f.includes('0.1.95')))
})
