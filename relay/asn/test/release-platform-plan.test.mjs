// #1979：依改動檔判斷要打哪幾個平台的標籤（只判斷，不打標籤）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planPlatforms, loadRules, PLATFORMS, latestTag, collectFromTags, renderTable, changedFilesSince } from '../../../tools/release/platform_plan.mjs'

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
    if (args[0] === 'log') return args.at(-1).startsWith('v0.2.10') ? '\x1e改畫面\n\nrelay/asn/ui/a.js\n' : '\x1e改文件\n\ndocs/a.md\n'
    return ''
  }
  assert.equal(latestTag(git, 'v*'), 'v0.2.10', '依版號不是字典序')
  const out = renderTable(collectFromTags(git, rules))
  assert.match(out, /電腦｜打｜v0\.2\.10/)
  assert.match(out, /Linux｜不打｜linux-v0\.2\.40/)
  assert.match(out, /手機｜打（找不到舊標籤）/)
  assert.ok(calls.every(c => c.startsWith('tag --list') || c.startsWith('log') || c.startsWith('diff')), '只讀，不建立標籤')
})

test('CLI：依據超過 10 個檔寫「等 N 個」', () => {
  const git = args => args[0] === 'tag' ? (args[2] === 'v*' ? 'v1.0.0' : '') : args[0] === 'log' ? '\x1e改畫面\n\n' + Array.from({ length: 12 }, (_, i) => `relay/asn/ui/f${i}.js`).join('\n') : ''
  assert.match(renderTable(collectFromTags(git, rules)), /等 12 個/)
})
test('#1979 官網檔（site/）和後台（supabase/）不發版：發版後才提交的網站檔不能把下一版拖成三個都打', () => {
  const r = plan([{ file: 'site/public/update/latest.json' }, { file: 'site/public/index.html' }, { file: 'supabase/migrations/20261120200000_compact_notice.sql' }])
  assert.deepEqual(tagged(r), [])
  assert.deepEqual(r.unknown, [])
  assert.deepEqual(tagged(plan([{ file: 'site/public/index.html' }, { file: 'relay/asn/ui/m.html' }])), [...PLATFORMS], '混到共用畫面照樣三個都打')
})
test('#1979 領隊 #4501 的歸類：claude-mod、pi-extension＝電腦＋Linux；package*.json、shared＝三個；machine、cloud-agent、web、cloudflare 維持判斷不出來', () => {
  assert.deepEqual(tagged(plan([{ file: 'relay/claude-mod/hooks/lib.ts' }])), ['desktop', 'linux'])
  assert.deepEqual(tagged(plan([{ file: 'relay/pi-extension/index.ts' }])), ['desktop', 'linux'])
  for (const f of ['relay/asn/package.json', 'relay/asn/package-lock.json', 'relay/shared/x.mjs']) assert.deepEqual(tagged(plan([{ file: f }])), [...PLATFORMS], f)
  for (const f of ['relay/machine/send.mjs', 'relay/cloud-agent/a.mjs', 'web/relay/x.html', 'cloudflare/edge-tts/w.js']) {
    const r = plan([{ file: f }])
    assert.deepEqual(r.unknown, [f], `${f} 還沒人查證，要落到判斷不出來`)
    assert.deepEqual(tagged(r), [...PLATFORMS])
  }
})
test('#1979 版號提交（release: x.y.z）不算改動：手機上一版沒發，不能被電腦版的版號提交拖成要發', () => {
  // 手機停在 android-v0.2.41；之後只有 0.2.42 的版號提交（動 package.json、tauri.conf.json…）和 site 檔
  const log = '\x1erelease: 0.2.42（版號＋CHANGELOG）\n\nrelay/asn/package.json\nrelay/asn/src-tauri/tauri.conf.json\nrelay/asn/src-tauri/Cargo.toml\nrelay/asn/src-tauri/Cargo.lock\nrelay/claude-mod/.claude-plugin/plugin.json\nrelay/asn/CHANGELOG.md\n'
    + '\x1e發版 v0.2.42：網站檔\n\nsite/public/update/latest.json\n'
    + '\x1eMerge pull request #1\n\n'
  assert.deepEqual(changedFilesSince(() => log, 'android-v0.2.41'), ['site/public/update/latest.json'])
  const git = args => args[0] === 'tag' ? ({ 'v*': 'v0.2.42', 'linux-v*': 'linux-v0.2.42', 'android-v*': 'android-v0.2.41' })[args[2]] : args[0] === 'log' ? log : ''
  const r = collectFromTags(git, rules)
  assert.equal(r.perPlatform.android.plan.platforms.android.tag, false, '只剩版號提交和網站檔，手機不發')
  // 同一個檔若在一般提交裡也動到，照樣算
  const log2 = log + '\x1e改依賴\n\nrelay/asn/package.json\n'
  assert.deepEqual(changedFilesSince(() => log2, 'x').sort(), ['relay/asn/package.json', 'site/public/update/latest.json'])
})

test('#1979 二審：標題像版號提交、但夾帶版號六檔以外的檔 → 整筆照算，不能漏發', () => {
  const log = '\x1erelease: 0.2.42 網站檔（夾帶）\n\nrelay/asn/package.json\nrelay/asn/ui/m.html\n'
  assert.deepEqual(changedFilesSince(() => log, 'v0.2.41').sort(), ['relay/asn/package.json', 'relay/asn/ui/m.html'])
  const git = args => args[0] === 'tag' ? ({ 'v*': 'v0.2.41', 'linux-v*': 'linux-v0.2.41', 'android-v*': 'android-v0.2.41' })[args[2]] : args[0] === 'log' ? log : ''
  const r = collectFromTags(git, rules)
  assert.equal(r.perPlatform.android.plan.platforms.android.tag, true, '夾帶 ui 改動，手機要發')
})

test('#1979 二審：搬檔（rename）時舊路徑也要算進去（真的 git，--no-renames）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-rename-'))
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...a], { encoding: 'utf8' })
  try {
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
    fs.mkdirSync(path.join(dir, 'relay/asn/ui'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'relay/asn/ui/old.js'), 'x\n'.repeat(50))
    g('add', '-A'); g('commit', '-qm', 'base'); g('tag', 'v0.0.1')
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
    g('mv', 'relay/asn/ui/old.js', 'tools/old.js'); g('commit', '-qm', '搬到 tools')
    const files = changedFilesSince(args => g(...args), 'v0.0.1')
    assert.ok(files.includes('relay/asn/ui/old.js'), `舊路徑要看得到：${files}`)
    assert.deepEqual(tagged(plan(files.map(file => ({ file })))), [...PLATFORMS])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
