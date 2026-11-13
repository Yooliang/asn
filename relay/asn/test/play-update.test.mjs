// 手機（Play 安裝）新版提示（#1437）：Play 上最新的版本比自己新才亮；只算標了 Play 的版本。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PLAY_WEB_URL, latestPlayVersion, openPlayStore, playUpdateVersion, playUpdateView } from '../ui/lib/play-update.mjs'
import { sortReleases } from '../ui/lib/releases.mjs'
import { tabDot } from '../ui/lib/mobile.mjs'

const rows = [
  { version: '0.2.18', date: '', lines: [], platforms: ['官網'] },
  { version: '0.2.14', date: '', lines: [], platforms: ['官網', 'Play'] },
  { version: '0.2.9', date: '', lines: [], platforms: ['官網', 'Play'] },
  { version: '0.2.10', date: '', lines: [], platforms: ['官網', 'Play'] },
  { version: '0.2.17', date: '', lines: [], platforms: ['家用機'] },
]
const ok = r => ({ phase: 'ok', entries: sortReleases(r) })

test('有新版：Play 上最新的是 0.2.14，自己 0.2.10', () => {
  assert.equal(playUpdateVersion(ok(rows), '0.2.10'), '0.2.14')
  assert.deepEqual(playUpdateView(ok(rows), '0.2.10'), { kind: 'new', version: '0.2.14' })
})
test('已是最新：自己等於或高於 Play 上最新', () => {
  assert.deepEqual(playUpdateView(ok(rows), '0.2.14'), { kind: 'latest' })
  assert.equal(playUpdateVersion(ok(rows), '0.2.15'), '')
})
test('Play 還沒上：最新版只有官網時不算新版（只看標 Play 的）', () => {
  assert.equal(latestPlayVersion(ok(rows).entries), '0.2.14')
  assert.equal(playUpdateVersion(ok(rows), '0.2.14'), '')
})
test('semver 數字比：0.2.10 大於 0.2.9', () => {
  const r = ok([{ version: '0.2.10', platforms: ['Play'] }, { version: '0.2.9', platforms: ['Play'] }])
  assert.equal(latestPlayVersion(r.entries), '0.2.10')
  assert.equal(playUpdateVersion(r, '0.2.9'), '0.2.10')
  assert.equal(playUpdateVersion(r, '0.2.10'), '')
})
test('讀不到、空、platforms 為 null／缺欄／全不含 Play：沒新版、不丟錯', () => {
  for (const rel of [undefined, null, { phase: 'error', entries: [], text: 'x' }, { phase: 'loading' }, ok([]), ok(null),
    ok([{ version: '0.2.18', platforms: null }, { version: '0.2.17' }, { version: '0.2.16', platforms: '官網' }, { version: '0.2.15', platforms: ['官網'] }])]) {
    assert.equal(playUpdateVersion(rel, '0.2.1'), '')
    assert.deepEqual(playUpdateView(rel, '0.2.1'), { kind: 'unknown' })
  }
  assert.equal(playUpdateVersion(ok(rows), '壞版本'), '')
})
test('釋出列帶 platforms、沒這欄不帶（電腦版顯示不受影響）', () => {
  assert.deepEqual(sortReleases([{ version: '0.1.1', lines: [], platforms: ['Play', 3] }])[0].platforms, ['Play'])
  assert.equal('platforms' in sortReleases([{ version: '0.1.1', lines: [] }])[0], false)
})
test('紅點：掛在「設定」分頁，不影響其他分頁', () => {
  assert.equal(tabDot('me', { update: true }), true)
  assert.equal(tabDot('me', {}), false)
  assert.equal(tabDot('list', { update: true }), false)
  assert.equal(tabDot('notice', { update: true }), false)
})
test('開 Play：直接開 https 網址；失敗回 false', async () => {
  const seen = []
  assert.equal(await openPlayStore(async u => { seen.push(u) }), true)
  assert.deepEqual(seen, ['https://play.google.com/store/apps/details?id=tw.yooliang.asn'])
  assert.equal(await openPlayStore(async () => { throw new Error('no') }), false)
})
test('畫面接線：更新頁、設定列、分頁紅點', () => {
  const html = fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8')
  assert.match(html, /到 Play 商店更新|PLAY_BUTTON_LABEL/)
  assert.match(html, /rowHasDot\(r\.key\)/)
})
test('設定列表「更新」列摘要：跟更新頁同一個判斷（有新版／已是最新／讀不到維持原句），自動更新版不變', async () => {
  const { mobileCatSummary } = await import('../ui/lib/mobile-settings.mjs')
  const s = playView => mobileCatSummary('update', { updateEnabled: false, playView })
  assert.equal(s(playUpdateView(ok(rows), '0.2.10')), '有新版本 0.2.14')
  assert.equal(s(playUpdateView(ok(rows), '0.2.14')), '已是最新版本')
  assert.equal(s({ kind: 'unknown' }), '這個版本不提供自動檢查')
  assert.equal(s(undefined), '這個版本不提供自動檢查')
  assert.equal(mobileCatSummary('update', { updateEnabled: true, autoUpdate: true, playView: { kind: 'new', version: '9.9.9' } }), mobileCatSummary('update', { updateEnabled: true, autoUpdate: true }))
})
