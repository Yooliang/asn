// 舊安裝檔搬到 GitHub Release（tools/release/github_legacy.mjs，#1585 第 2 張）。全部用假的 gh 與 fetch，不連網、不動 GitHub。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { MANIFEST, REPO, apply, checkManifest, githubUrl, plan, siteUrl, verify } from '../tools/release/github_legacy.mjs'

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
const EXE = Buffer.from('fake exe'), SIG = Buffer.from('fake sig'), APK = Buffer.from('fake apk')
const T = 'a'.repeat(40)
const entry = (version, files) => ({ version, target: T, notes: `- ${version} 的說明`, assets: files.map(([name, buf]) => ({ name, size: buf.length, sha256: sha(buf) })) })
const M = [
  entry('0.2.9', [['ASN_0.2.9_x64-setup.exe', EXE], ['ASN_0.2.9_x64-setup.exe.sig', SIG]]),
  entry('0.1.96', [['ASN_0.1.96_android.apk', APK]]),
]

// 假的 gh：releases＝{ tag: { 檔名: 大小 } }；記下每一次呼叫
function fakeGh(releases = {}) {
  const calls = []
  const gh = args => {
    calls.push(args)
    const [cmd, sub, tag] = args
    if (cmd !== 'release') throw new Error('不認得')
    if (sub === 'view') {
      if (!releases[tag]) throw new Error('release not found')
      return JSON.stringify({ tagName: tag, assets: Object.entries(releases[tag]).map(([name, size]) => ({ name, size })) })
    }
    if (sub === 'create') { releases[tag] = {}; return '' }
    if (sub === 'upload') { const f = args[3]; releases[tag][path.basename(f)] = fs.statSync(f).size; return '' }
    throw new Error(`沒想到的指令：${args.join(' ')}`)
  }
  return { gh, calls, releases }
}
// 假的網路：網址 → 內容
const fakeFetch = (map, seen = []) => async url => {
  seen.push(url)
  const data = map[url]
  if (data === undefined) return { ok: false, status: 404 }
  const buf = Buffer.from(data)
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
}
const siteAll = { [siteUrl('ASN_0.2.9_x64-setup.exe')]: EXE, [siteUrl('ASN_0.2.9_x64-setup.exe.sig')]: SIG, [siteUrl('ASN_0.1.96_android.apk')]: APK }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-legacy-test-'))

test('預覽：只讀現況（gh release view），不建也不傳', () => {
  const { gh, calls } = fakeGh({ 'v0.2.9': { 'ASN_0.2.9_x64-setup.exe': EXE.length } })
  const steps = plan(M, gh)
  assert.deepEqual(steps.map(s => [s.version, s.create, s.upload.map(a => a.name), s.skip]), [
    ['0.2.9', false, ['ASN_0.2.9_x64-setup.exe.sig'], ['ASN_0.2.9_x64-setup.exe']],
    ['0.1.96', true, ['ASN_0.1.96_android.apk'], []],
  ])
  assert.ok(calls.every(c => c[1] === 'view'), JSON.stringify(calls))
})

test('照做：缺的 Release 建起來（指向那個 commit、不設 Latest），缺的檔從官網下載核對後上傳，已有的不再傳', async () => {
  const { gh, calls, releases } = fakeGh({ 'v0.2.9': { 'ASN_0.2.9_x64-setup.exe': EXE.length } })
  const seen = []
  await apply(plan(M, gh), { gh, fetchFn: fakeFetch(siteAll, seen), tmp: tmp() })
  const create = calls.find(c => c[1] === 'create')
  assert.deepEqual(create.slice(0, 7), ['release', 'create', 'v0.1.96', '--repo', REPO, '--target', T])
  assert.ok(create.includes('--latest=false'))
  assert.deepEqual(Object.keys(releases['v0.1.96']), ['ASN_0.1.96_android.apk'])
  assert.deepEqual(Object.keys(releases['v0.2.9']).sort(), ['ASN_0.2.9_x64-setup.exe', 'ASN_0.2.9_x64-setup.exe.sig'])
  assert.ok(!seen.includes(siteUrl('ASN_0.2.9_x64-setup.exe')), '已經在 GitHub 上的不再下載')
  assert.equal(calls.filter(c => c[1] === 'upload').length, 2)
})

test('GitHub 上已經有同名的檔、但大小不一樣：停下來報錯，不覆蓋', () => {
  const { gh } = fakeGh({ 'v0.2.9': { 'ASN_0.2.9_x64-setup.exe': 999 } })
  assert.throws(() => plan(M, gh), /大小 999 跟清單的 \d+ 不一樣：不覆蓋/)
})

test('官網下載回來的內容跟清單不符：那個檔不上傳', async () => {
  const { gh, calls } = fakeGh()
  const bad = { ...siteAll, [siteUrl('ASN_0.1.96_android.apk')]: Buffer.from('fake apX') }
  await assert.rejects(apply(plan(M, gh), { gh, fetchFn: fakeFetch(bad), tmp: tmp() }), /官網 的 ASN_0\.1\.96_android\.apk：sha256 對不起來/)
  assert.ok(!calls.some(c => c[1] === 'upload' && c[2] === 'v0.1.96'))
})

test('官網下載失敗：停下來，不上傳', async () => {
  const { gh, calls } = fakeGh()
  await assert.rejects(apply(plan(M, gh), { gh, fetchFn: fakeFetch({}), tmp: tmp() }), /下載失敗（HTTP 404）/)
  assert.equal(calls.filter(c => c[1] === 'upload').length, 0)
})

test('驗證：匿名從 GitHub 下載比對，全部一致才算完成；不一致或下載不到都列出來', async () => {
  const gh = Object.fromEntries(M.flatMap(r => r.assets.map(a => [githubUrl(r.version, a.name), { 'ASN_0.2.9_x64-setup.exe': EXE, 'ASN_0.2.9_x64-setup.exe.sig': SIG, 'ASN_0.1.96_android.apk': APK }[a.name]])))
  const all = await verify(M, { fetchFn: fakeFetch(gh) })
  assert.deepEqual([all.ok.length, all.bad], [3, []])
  const broken = await verify(M, { fetchFn: fakeFetch({ ...gh, [githubUrl('0.1.96', 'ASN_0.1.96_android.apk')]: Buffer.from('x') }) })
  assert.equal(broken.ok.length, 2)
  assert.match(broken.bad[0], /GitHub 的 ASN_0\.1\.96_android\.apk/)
  assert.equal(githubUrl('0.2.9', 'ASN_0.2.9_x64-setup.exe'), `https://github.com/${REPO}/releases/download/v0.2.9/ASN_0.2.9_x64-setup.exe`)
})

test('只上傳、不刪：程式裡沒有 delete、--clobber', () => {
  const src = fs.readFileSync(new URL('../tools/release/github_legacy.mjs', import.meta.url), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /'delete'|--clobber|rmdir|unlink/)
})

test('清單格式：版本、完整 commit、只認那一版的三種檔名、大小與 sha256', () => {
  assert.doesNotThrow(() => checkManifest(M))
  assert.throws(() => checkManifest([]), /空的/)
  assert.throws(() => checkManifest([{ ...M[0], target: 'abc' }]), /40 位/)
  assert.throws(() => checkManifest([{ ...M[0], assets: [{ name: 'ASN_0.2.10_x64-setup.exe', size: 1, sha256: 'a'.repeat(64) }] }]), /不認得的檔名/)
  assert.throws(() => checkManifest([M[0], M[0]]), /重複/)
})

test('repo 裡的清單：41 個檔（17 版 exe＋sig、7 個 APK），每一版的 commit 都真的把那一版寫進 latest.json／android.json', () => {
  const m = checkManifest(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')))
  const names = m.flatMap(r => r.assets.map(a => a.name))
  assert.equal(names.length, 41)
  assert.equal(names.filter(n => n.endsWith('.exe')).length, 17)
  assert.equal(names.filter(n => n.endsWith('.exe.sig')).length, 17)
  assert.equal(names.filter(n => n.endsWith('.apk')).length, 7)
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  for (const r of m) {
    const rel = r.version.startsWith('0.1.') ? 'site/public/update/android.json' : 'site/public/update/latest.json'
    const j = JSON.parse(execFileSync('git', ['-C', root, 'show', `${r.target}:${rel}`], { encoding: 'utf8' }))
    assert.equal(j.version, r.version, `${r.target.slice(0, 8)} 的 ${rel}`)
    if (rel.endsWith('android.json')) {
      const apk = r.assets.find(a => a.name.endsWith('.apk'))
      assert.deepEqual([apk.sha256, apk.size], [j.sha256, j.bytes], `${r.version} 的 APK 跟當時 android.json 記的一樣`)
    }
  }
})
