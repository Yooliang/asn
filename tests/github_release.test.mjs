// 發一版安裝檔到 GitHub Release（tools/release/github_release.mjs，#1585）。全部用假的 gh 與 fetch，不連網、不動 GitHub。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO, githubUrl, githubUrlForSite, installerFiles, publishRelease, sha256 } from '../tools/release/github_release.mjs'

const V = '0.2.26'
const T = 'b'.repeat(40)
const EXE = Buffer.from('fake installer'), SIG = Buffer.from('fake sig')
const [EXE_NAME, SIG_NAME] = installerFiles(V)

function localFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-ghrel-'))
  fs.writeFileSync(path.join(dir, EXE_NAME), EXE)
  fs.writeFileSync(path.join(dir, SIG_NAME), SIG)
  return [{ name: EXE_NAME, file: path.join(dir, EXE_NAME) }, { name: SIG_NAME, file: path.join(dir, SIG_NAME) }]
}
// 假的 GitHub：rel＝{ draft, assets: { 檔名: Buffer } }；記下 gh 呼叫；公開後才能匿名下載
function fakeGitHub(rel = null, { publicOverride } = {}) {
  const calls = []
  const state = { rel }
  const gh = args => {
    calls.push(args)
    const [, sub, tag] = args
    if (sub === 'view') {
      if (!state.rel) throw new Error('release not found')
      return JSON.stringify({ tagName: tag, isDraft: state.rel.draft, assets: Object.entries(state.rel.assets).map(([name, b]) => ({ name, size: b.length })) })
    }
    if (sub === 'create') { assert.ok(args.includes('--draft')); state.rel = { draft: true, assets: {} }; return '' }
    if (sub === 'upload') { const f = args[3]; state.rel.assets[path.basename(f)] = fs.readFileSync(f); return '' }
    if (sub === 'edit') { if (args.includes('--draft=false')) state.rel.draft = false; if (args.includes('--draft=true')) state.rel.draft = true; return '' }
    throw new Error(`沒想到的指令：${args.join(' ')}`)
  }
  const ghDownload = (version, name, dir) => { calls.push(['download', name]); fs.writeFileSync(path.join(dir, name), state.rel.assets[name]) }
  const fetchFn = async url => {
    const name = decodeURIComponent(url.split('/').pop())
    const buf = publicOverride?.[name] ?? (state.rel && !state.rel.draft ? state.rel.assets[name] : undefined)
    if (!buf) return { ok: false, status: 404 }
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
  }
  return { gh, ghDownload, fetchFn, calls, state }
}
const run = (g, extra = {}) => publishRelease({ version: V, files: localFiles(), notes: '- 新功能', target: T, gh: g.gh, ghDownload: g.ghDownload, fetchFn: g.fetchFn, ...extra })

test('順序：建草稿（指向 commit）→ 上傳兩個檔 → 登入下載比對 → 轉正式並設 Latest → 匿名下載比對', async () => {
  const g = fakeGitHub()
  const r = await run(g)
  assert.deepEqual(r, { created: true, published: true })
  const steps = g.calls.map(c => (c[0] === 'download' ? `download ${c[1]}` : `${c[1]}${c[1] === 'edit' ? ' ' + c.filter(x => x.startsWith('--')).join(' ') : ''}`))
  assert.deepEqual(steps, ['view', 'create', 'upload', 'upload', `download ${EXE_NAME}`, `download ${SIG_NAME}`, 'edit --repo --draft=false --latest'])
  const create = g.calls.find(c => c[1] === 'create')
  assert.deepEqual(create.slice(0, 8), ['release', 'create', 'v0.2.26', '--repo', REPO, '--draft', '--target', T])
  assert.equal(g.state.rel.draft, false)
})

test('公開後匿名下載不對：退回草稿並報錯（latest.json 還沒部署，使用者不受影響）', async () => {
  const g = fakeGitHub(null, { publicOverride: { [EXE_NAME]: Buffer.from('cdn served something else') } })
  await assert.rejects(run(g), /匿名下載 ASN_0\.2\.26_x64-setup\.exe 不對.*已退回草稿/)
  assert.equal(g.state.rel.draft, true)
})

test('匿名下載不對、退回草稿也失敗：兩個錯都報出來，原本的不被蓋掉', async () => {
  const g = fakeGitHub(null, { publicOverride: { [EXE_NAME]: Buffer.from('cdn served something else') } })
  const inner = g.gh
  g.gh = args => { if (args[1] === 'edit' && args.includes('--draft=true')) throw new Error('HTTP 502'); return inner(args) }
  await assert.rejects(run(g), e => /匿名下載 ASN_0\.2\.26_x64-setup\.exe 不對/.test(e.message) && /退回草稿也失敗（HTTP 502）/.test(e.message) && /請人工退回草稿/.test(e.message))
  assert.equal(g.state.rel.draft, false)
})

test('草稿登入下載回來不一樣：不轉正式', async () => {
  const g = fakeGitHub()
  g.ghDownload = (version, name, dir) => fs.writeFileSync(path.join(dir, name), 'corrupted')
  await assert.rejects(run(g), /下載回來的 sha256 跟本機的不一樣：不轉正式/)
  assert.equal(g.state.rel.draft, true)
  assert.ok(!g.calls.some(c => c[1] === 'edit'))
})

test('草稿已經有一部分：缺的才傳；同名但大小不同就停，不覆蓋', async () => {
  const g = fakeGitHub({ draft: true, assets: { [EXE_NAME]: EXE } })
  await run(g)
  assert.equal(g.calls.filter(c => c[1] === 'upload').length, 1)
  const h = fakeGitHub({ draft: true, assets: { [EXE_NAME]: Buffer.from('other size!!!!!!!!!!') } })
  await assert.rejects(run(h), /不覆蓋/)
})

test('已經是正式版、檔案一致：什麼都不做（可以重跑）；缺檔或內容不同：不動正式版、報錯', async () => {
  const g = fakeGitHub({ draft: false, assets: { [EXE_NAME]: EXE, [SIG_NAME]: SIG } })
  assert.deepEqual(await run(g), { created: false, published: false })
  assert.deepEqual(g.calls.map(c => c[1]), ['view'])
  await assert.rejects(run(fakeGitHub({ draft: false, assets: { [EXE_NAME]: EXE } })), /不在上面/)
  const sameSize = Buffer.from('fake installeX')
  await assert.rejects(run(fakeGitHub({ draft: false, assets: { [EXE_NAME]: sameSize, [SIG_NAME]: SIG } })), /內容跟這次的不一樣/)
})

test('版本號與 commit 格式不對：一開始就擋', async () => {
  await assert.rejects(publishRelease({ version: 'v0.2.26', files: [], target: T, gh: () => '' }), /版本號格式/)
  await assert.rejects(publishRelease({ version: V, files: [], target: 'abc', gh: () => '' }), /40 位/)
})

test('官網路徑 → GitHub 網址：三種安裝檔都轉得到，其他（清單、別的資料夾、別站）回 null', () => {
  const site = 'https://asnmessenger.web.app/update/'
  assert.equal(githubUrlForSite(`${site}ASN_0.2.26_x64-setup.exe`), githubUrl('0.2.26', 'ASN_0.2.26_x64-setup.exe'))
  assert.equal(githubUrlForSite(`${site}ASN_0.2.26_x64-setup.exe.sig`), 'https://github.com/Yooliang/asn/releases/download/v0.2.26/ASN_0.2.26_x64-setup.exe.sig')
  assert.equal(githubUrlForSite(`${site}ASN_0.1.104_android.apk`), 'https://github.com/Yooliang/asn/releases/download/v0.1.104/ASN_0.1.104_android.apk')
  for (const u of [`${site}latest.json`, 'https://asnmessenger.web.app/download/asn-windows.zip', 'https://example.com/update/ASN_0.2.26_x64-setup.exe', `${site}ASN_0.2_x64-setup.exe`]) assert.equal(githubUrlForSite(u), null, u)
  assert.equal(sha256(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('發版腳本：安裝檔與 .sig 不再寫進官網目錄，放 target/release-publish；latest.json 照舊寫官網；印出 github_release.mjs 這一步', () => {
  const rel = fs.readFileSync(new URL('../relay/asn/scripts/release.mjs', import.meta.url), 'utf8')
  assert.match(rel, /path\.join\(root, 'src-tauri', 'target', 'release-publish'\)/)
  assert.match(rel, /const latestDir = opts\.dryRun \? out : siteUpdate/)
  assert.match(rel, /fs\.copyFileSync\(exe, path\.join\(out, name\)\)/)
  assert.doesNotMatch(rel, /copyFileSync\([^)]*siteUpdate/)
  assert.match(rel, /tools\/release\/github_release\.mjs --version/)
})
