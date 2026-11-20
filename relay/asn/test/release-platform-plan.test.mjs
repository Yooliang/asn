// #1979：依改動檔判斷要打哪幾個平台的標籤（只判斷，不打標籤）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { planPlatforms, loadRules, PLATFORMS, latestTag, collectFromTags, renderTable } from '../../../tools/release/platform_plan.mjs'

const rules = loadRules()
const plan = changes => planPlatforms({ changes, rules })
const tagged = r => PLATFORMS.filter(p => r.platforms[p].tag)

test('只改 ui：三個都打', () => {
  const r = plan([{ file: 'relay/asn/ui/chat.js' }])
  assert.deepEqual(tagged(r), ['desktop', 'linux', 'android'])
  assert.deepEqual(r.unknown, [])
})

test('只改 Rust 一般檔：電腦和 Linux', () => {
  const r = plan([{ file: 'relay/asn/src-tauri/src/lib.rs', diff: '+let x = 1;' }])
  assert.deepEqual(tagged(r), ['desktop', 'linux'])
})

test('Rust 檔的 diff 含安卓 cfg：三個都打', () => {
  const r = plan([{ file: 'relay/asn/src-tauri/src/auth.rs', diff: '+#[cfg(target_os = "android")]\n+fn f() {}' }])
  assert.deepEqual(tagged(r), ['desktop', 'linux', 'android'])
  const m = plan([{ file: 'relay/asn/src-tauri/src/auth.rs', diff: '+#[cfg(mobile)]' }])
  assert.ok(m.platforms.android.tag)
})

test('只改安卓目錄、安卓模組：只打手機', () => {
  const r = plan([
    { file: 'relay/asn/src-tauri/gen/android/app/src/main/java/tw/yooliang/asn/MainActivity.kt' },
    { file: 'relay/asn/src-tauri/src/android.rs', diff: '+// x' },
  ])
  assert.deepEqual(tagged(r), ['android'])
})

test('只動 tools、.github、docs、test：都不打', () => {
  const r = plan([
    { file: 'tools/release/tag_check.mjs' }, { file: '.github/workflows/asn-release.yml' },
    { file: 'docs/開發紀律.md' }, { file: 'relay/asn/test/a.test.mjs' }, { file: 'tests/x.test.mjs' },
  ])
  assert.deepEqual(tagged(r), [])
  assert.equal(r.skipped.length, 5)
})

test('新目錄：三個都打並列出原因', () => {
  const r = plan([{ file: 'newdir/foo.txt' }])
  assert.deepEqual(tagged(r), ['desktop', 'linux', 'android'])
  assert.deepEqual(r.unknown, ['newdir/foo.txt'])
  assert.match(r.reason, /判斷不出來/)
})

test('混合：ui 加 docs 三個都打；docs 不列入依據', () => {
  const r = plan([{ file: 'relay/asn/ui/m.js' }, { file: 'docs/a.md' }])
  assert.deepEqual(tagged(r), ['desktop', 'linux', 'android'])
  assert.ok(!r.platforms.desktop.files.includes('docs/a.md'))
})

test('沒有任何改動：都不打', () => {
  assert.deepEqual(tagged(plan([])), [])
})

test('資料檔：讀得進來、每條有說明與 glob、平台名稱只能是三個', () => {
  assert.ok(rules.length > 0)
  for (const r of rules) {
    assert.ok(typeof r.glob === 'string' && r.glob, '缺 glob')
    assert.ok(typeof r['說明'] === 'string' && r['說明'].trim(), `${r.glob} 缺說明`)
    assert.ok(Array.isArray(r.platforms), `${r.glob} platforms 不是陣列`)
    for (const p of r.platforms) assert.ok(PLATFORMS.includes(p), `${r.glob} 有不認得的平台 ${p}`)
    if (r.androidIfContent) new RegExp(r.androidIfContent)
  }
})

test('真 repo：每個追蹤中的檔都不拋錯', () => {
  const files = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)
  assert.ok(files.length > 100)
  const r = plan(files.map(file => ({ file })))
  assert.equal(typeof r.reason, 'string')
  const tops = new Set(r.unknown.map(f => (f.split('/').length > 1 ? f.split('/').slice(0, 2).join('/') : f)))
  console.log('判斷不出來的目錄（前兩層）：' + [...tops].sort().join('、'))
})

test('CLI：各平台各自找最新標籤、依版號排序、git 可注入', () => {
  const calls = []
  const git = args => {
    calls.push(args.join(' '))
    if (args[0] === 'tag') {
      if (args[2] === 'v*') return 'v0.2.9\nv0.2.10\nv0.2.2\n'
      if (args[2] === 'linux-v*') return 'linux-v0.2.40\n'
      return ''
    }
    if (args[0] === 'diff' && args[1] === '--name-only') return args[2].startsWith('v0.2.10') ? 'relay/asn/ui/a.js\n' : 'docs/a.md\n'
    return ''
  }
  assert.equal(latestTag(git, 'v*'), 'v0.2.10', '依版號不是字典序')
  const out = renderTable(collectFromTags(git, rules))
  assert.match(out, /電腦｜打｜v0\.2\.10/)
  assert.match(out, /Linux｜不打｜linux-v0\.2\.40/)
  assert.match(out, /手機｜打（找不到舊標籤）/)
  assert.ok(calls.every(c => c.startsWith('tag --list') || c.startsWith('diff')), '只讀，不建立標籤')
})

test('CLI：依據超過 10 個檔寫「等 N 個」', () => {
  const git = args => args[0] === 'tag' ? (args[2] === 'v*' ? 'v1.0.0' : '') : args[1] === '--name-only' ? Array.from({ length: 12 }, (_, i) => `relay/asn/ui/f${i}.js`).join('\n') : ''
  assert.match(renderTable(collectFromTags(git, rules)), /等 12 個/)
})
