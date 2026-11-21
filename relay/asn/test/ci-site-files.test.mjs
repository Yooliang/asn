// #2022 ②-2：CI 產官網檔（tools/release/ci_site_files.mjs）與本機版共用的 site_files.mjs。
// 用真的 release-lib 與固定輸入；網路用假的 fetch，寫檔用記憶體。
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, parseArgs } from '../../../tools/release/ci_site_files.mjs'
import { buildSiteFiles, fetchOnlineLatest, versionNotBackProblem, compareVersions, SiteFilesError } from '../../../tools/release/site_files.mjs'
import { compareVersions as localCompare } from '../../../tools/release/local_sign_publish.mjs'
import { installerUrl } from '../scripts/release-lib.mjs'

const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpGSVhFRC1TSUctVEVTVA==\n'
const CHANGELOG = '# 記錄\n\n## 0.2.50（2026-11-22）\n- 新功能：測試。\n\n## 0.2.49（2026-11-21）\n- 舊的。\n'
const INDEX = '<a href="https://asnmessenger.web.app/update/ASN_0.2.49_x64-setup.exe">下載</a>\r\n<a href="https://asnmessenger.web.app/update/ASN_0.2.49_x64-setup.exe">再下載</a>\r\n'
const NOW = Date.parse('2026-11-22T01:02:03Z')

const online = (obj, status = 200) => async () => ({ ok: status === 200, status, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) })

const harness = (files, fetchFn) => {
  const out = new Map()
  return {
    out,
    deps: {
      fetchFn, now: () => NOW,
      readFile: p => { if (!files[p]) throw new Error(`讀不到 ${p}`); return files[p] },
      writeFile: (p, t) => out.set(p.replaceAll('\\', '/'), t),
      mkdir: () => {},
    },
  }
}
const ARGS = ['--version', '0.2.50', '--sig', 'a.sig', '--changelog', 'c.md', '--index', 'i.html', '--out', 'out', '--notes-out', 'notes.md']
const FILES = { 'a.sig': SIG, 'c.md': CHANGELOG, 'i.html': INDEX }

test('buildSiteFiles：latest.json 只帶 windows-x86_64、signature 是 .sig 原文（去尾端換行）、說明取 CHANGELOG 最新一段、首頁連結換成這版', () => {
  const r = buildSiteFiles({ version: '0.2.50', sigText: SIG, changelog: CHANGELOG, indexHtml: INDEX, pubDate: new Date(NOW), date: '2026-11-22' })
  assert.deepEqual(Object.keys(r.latest.platforms), ['windows-x86_64'])
  assert.equal(r.latest.platforms['windows-x86_64'].signature, SIG.trim())
  assert.equal(r.latest.platforms['windows-x86_64'].url, 'https://asnmessenger.web.app/update/ASN_0.2.50_x64-setup.exe')
  assert.equal(r.latest.version, '0.2.50')
  assert.equal(r.latest.pub_date, '2026-11-22T01:02:03.000Z')
  assert.equal(r.notes, '- 新功能：測試。')
  assert.equal(r.latest.notes, r.notes)
  assert.equal(r.latestText, `${JSON.stringify(r.latest, null, 2)}\n`)
  assert.equal(r.indexText.includes('0.2.49'), false)
  assert.equal(r.indexText.split(installerUrl('0.2.50')).length - 1, 2)
  assert.equal(r.indexText.includes('\r'), false, '換行正規化成 LF')
})

test('buildSiteFiles：空簽章、壞版本、首頁沒有安裝檔連結都丟錯', () => {
  const base = { version: '0.2.50', sigText: SIG, changelog: CHANGELOG, indexHtml: INDEX, pubDate: new Date(NOW), date: 'x' }
  assert.throws(() => buildSiteFiles({ ...base, sigText: '  \n' }), /簽章是空的/)
  assert.throws(() => buildSiteFiles({ ...base, version: '0.2' }), /版本號格式不對/)
  assert.throws(() => buildSiteFiles({ ...base, indexHtml: '<p>沒有連結</p>' }), e => e instanceof SiteFilesError && /找不到安裝檔連結/.test(e.message))
})

test('版本不退：低於線上擋；等於線上看 allowSame；高於放行', () => {
  assert.match(versionNotBackProblem({ version: '0.2.48', online: '0.2.49', allowSame: true }), /版本會倒退/)
  assert.match(versionNotBackProblem({ version: '0.2.49', online: '0.2.49', allowSame: false }), /--same-version/)
  assert.equal(versionNotBackProblem({ version: '0.2.49', online: '0.2.49', allowSame: true }), null)
  assert.equal(versionNotBackProblem({ version: '0.2.50', online: '0.2.49', allowSame: false }), null)
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1, '逐段比數字，不是字串比')
  assert.equal(localCompare, compareVersions, '本機版與 CI 版共用同一個比較函式')
})

test('fetchOnlineLatest：HTTP 錯誤、不是 JSON、版本格式不對都丟 SiteFilesError（訊息與本機版一致）', async () => {
  await assert.rejects(fetchOnlineLatest({ fetchFn: online({}, 503), now: () => 1 }), /讀不到線上 latest\.json（HTTP 503）/)
  await assert.rejects(fetchOnlineLatest({ fetchFn: online('不是json'), now: () => 1 }), /讀不到線上 latest\.json，無法確認版本不退/)
  await assert.rejects(fetchOnlineLatest({ fetchFn: online({ version: 'x' }), now: () => 1 }), /version 格式不對/)
  const ok = await fetchOnlineLatest({ fetchFn: online({ version: '0.2.49' }), now: () => 1 })
  assert.equal(ok.version, '0.2.49')
})

test('ci_site_files.run：寫出 latest.json、index.html 與更新說明；線上比這版舊時放行', async () => {
  const h = harness(FILES, online({ version: '0.2.49', platforms: { 'linux-x86_64': { signature: 's', url: 'u' } } }))
  const r = await run(parseArgs(ARGS), h.deps)
  assert.deepEqual([...h.out.keys()].sort(), ['notes.md', 'out/index.html', 'out/latest.json'])
  assert.equal(h.out.get('notes.md'), '- 新功能：測試。')
  const latest = JSON.parse(h.out.get('out/latest.json'))
  assert.deepEqual(latest, r.latest)
  assert.deepEqual(Object.keys(latest.platforms), ['windows-x86_64'], '線上有 Linux 項也不帶（#1964：電腦版只帶 windows-x86_64）')
})

test('ci_site_files.run：線上等於這版放行（重跑同一個標籤）；線上較新就擋、不寫任何檔', async () => {
  const same = harness(FILES, online({ version: '0.2.50' }))
  await run(parseArgs(ARGS), same.deps)
  assert.equal(same.out.size, 3)
  const newer = harness(FILES, online({ version: '0.2.51' }))
  await assert.rejects(run(parseArgs(ARGS), newer.deps), /版本會倒退：這次 0\.2\.50，線上已是 0\.2\.51/)
  assert.equal(newer.out.size, 0)
})

test('ci_site_files.run：讀不到線上版本、.sig 是空的都擋、不寫任何檔', async () => {
  const noNet = harness(FILES, online({}, 500))
  await assert.rejects(run(parseArgs(ARGS), noNet.deps), /HTTP 500/)
  assert.equal(noNet.out.size, 0)
  const emptySig = harness({ ...FILES, 'a.sig': '\n' }, online({ version: '0.2.49' }))
  await assert.rejects(run(parseArgs(ARGS), emptySig.deps), /簽章是空的/)
  assert.equal(emptySig.out.size, 0)
})

test('ci_site_files.parseArgs：缺參數、多餘參數、參數沒值都丟錯', () => {
  assert.throws(() => parseArgs(ARGS.slice(2)), /要給 --version/)
  assert.throws(() => parseArgs([...ARGS, '--force', 'x']), /不認得的參數/)
  assert.throws(() => parseArgs(['--version', '--sig']), /後面要有值/)
  assert.deepEqual(parseArgs(ARGS).notesOut, 'notes.md')
})

test('github_release.mjs 的 --target：不是 40 位就在碰 gh 之前停下（CI 上用 github.sha，不靠本機 git 查遠端分支）', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = new URL('../../../tools/release/github_release.mjs', import.meta.url)
  const r = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--version', '0.2.50', '--exe', 'ASN_0.2.50_x64-setup.exe', '--sig', 'ASN_0.2.50_x64-setup.exe.sig', '--target', 'abc123'], { encoding: 'utf8', env: { PATH: '' } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--target 要是完整的 40 位/)
})
