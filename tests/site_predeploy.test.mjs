// 官網部署前檢查（tools/release/site_predeploy.mjs）：缺檔會補、對不起來會擋、全部都在時不連網。全部用假的 fetch，不連線。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { predeploy, wantedFiles } from '../tools/release/site_predeploy.mjs'

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
  const fetchFn = async () => ({ ok: true, status: 200, headers: { get: () => '9999' }, arrayBuffer: async () => EXE.buffer.slice(EXE.byteOffset, EXE.byteOffset + EXE.length) })
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
