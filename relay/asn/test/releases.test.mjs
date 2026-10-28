// 版本紀錄（資料庫來源）的純邏輯：整理與排序、讀不到時的說法、畫面接線。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EMPTY_TEXT, LOADING_TEXT, UNREADABLE_TEXT, initialReleases, loadReleases, releasesNote, sortReleases } from '../ui/lib/releases.mjs'
import { buildLogView } from '../ui/lib/changelog.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('整理：依語意版本新到舊（0.1.100 在 0.1.99 前面）、壞的列略過、條列去空白', () => {
  const r = sortReleases([
    { version: '0.1.99', date: '2026-10-28', lines: [' a ', '', 5] },
    { version: '0.1.100', date: '2026-10-29', lines: ['b'] },
    { version: '0.1.7', lines: [] },
    { version: 'x', lines: ['no'] }, null, '字串', { lines: ['no'] },
  ])
  assert.deepEqual(r.map(e => e.version), ['0.1.100', '0.1.99', '0.1.7'])
  assert.deepEqual(r[1], { version: '0.1.99', date: '2026-10-28', lines: ['a'] })
  assert.equal(r[2].date, '')
  assert.deepEqual(sortReleases(null), [])
})

test('讀取：成功回條目；讀不到一律固定一句，不露出錯誤細節', async () => {
  assert.deepEqual(await loadReleases(async () => [{ version: '0.1.5', date: '', lines: ['a'] }]), { phase: 'ok', entries: [{ version: '0.1.5', date: '', lines: ['a'] }], text: '' })
  for (const bad of [async () => { throw new Error('HTTP 401 secret-detail') }, () => { throw new Error('x') }, null]) {
    const r = await loadReleases(bad)
    assert.deepEqual([r.phase, r.text, r.entries], ['error', UNREADABLE_TEXT, []])
  }
  assert.equal(UNREADABLE_TEXT, '暫時讀不到版本紀錄')
})

test('讀取：只有「重試」才帶 force，其餘不帶任何參數', async () => {
  const seen = []
  await loadReleases(async f => { seen.push(f); return [] })
  await loadReleases(async f => { seen.push(f); return [] }, { force: true })
  assert.deepEqual(seen, [false, true])
})

test('畫面一句話：讀取中、讀不到、沒有資料；有資料時沒有', () => {
  assert.equal(releasesNote({ phase: 'loading' }), LOADING_TEXT)
  assert.equal(releasesNote({ phase: 'error', text: '' }), UNREADABLE_TEXT)
  assert.equal(releasesNote({ phase: 'ok', entries: [] }), EMPTY_TEXT)
  assert.equal(releasesNote({ phase: 'ok', entries: [{ version: '0.1.1' }] }), '')
  assert.equal(releasesNote(initialReleases()), '')
})

test('接進既有的條目排法：目前版本標出來、比目前新又還沒發的不顯示', () => {
  const entries = sortReleases([{ version: '0.1.101', lines: ['未發'] }, { version: '0.1.100', lines: ['a'] }, { version: '0.1.99', lines: ['b'] }])
  const v = buildLogView({ entries, current: '0.1.100', available: null })
  assert.deepEqual(v.map(e => [e.version, e.tag]), [['0.1.100', 'current'], ['0.1.99', '']])
})

test('接線：電腦版與手機版都走 site_releases 指令；介面不 fetch、不讀打包的 changelog', () => {
  const tauri = read('ui/lib/tauri.mjs')
  assert.match(tauri, /siteReleases: force => invoke\('site_releases', \{ force: force === true \}\)/)
  assert.match(read('src-tauri/src/lib.rs'), /site_releases::site_releases,/)
  const list = read('ui/list.js'), m = read('ui/m.js')
  assert.doesNotMatch(list, /vendor\/changelog/)
  assert.match(list, /loadReleases\(/)
  assert.match(m, /loadReleases\(f => invoke\('site_releases', \{ force: f === true \}\)/)
  for (const f of ['ui/list.js', 'ui/m.js', 'ui/lib/releases.mjs']) assert.doesNotMatch(read(f), /fetch\([^)]*supabase/, f)
  assert.doesNotMatch(read('scripts/prep.mjs'), /changelog\.(json|mjs)/)
})
