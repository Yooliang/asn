// tools/release/site_record_check.mjs（#1892 規格 2.4）：CHANGELOG 一段 → 官網紀錄草稿，規則對齊 supabase/functions/_shared/site_write.ts。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTROL_RE, COMMIT_RE, DATE_RE, LIMITS, UNSAFE_RES, VERSION_RE,
  changelogSections, checkRecord, checkText, draftFromChangelog, main, sectionItems, validDate,
} from '../../../tools/release/site_record_check.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const real = fs.readFileSync(path.join(here, '..', 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
const siteWrite = fs.readFileSync(path.join(here, '..', '..', '..', 'supabase', 'functions', '_shared', 'site_write.ts'), 'utf8').replace(/\r\n/g, '\n')

const REC = { version: '0.2.37', date: '2026-11-21', commit: 'abcdef12', items: ['新增：甲（#1）'], platforms: ['官網'] }
const problems = patch => checkRecord({ ...REC, ...patch })
const onlyField = (ps, field) => { assert.ok(ps.length > 0, '應該失敗'); assert.ok(ps.every(p => p.field === field), JSON.stringify(ps)) }
const cl = body => `# 標題\n\n## 0.2.37（2026-11-21）\n${body}`

// ---- 與 site_write.ts 的規則對照 ----
test('對照 site_write.ts：正則字面與上限必須相同（漂移就紅）', () => {
  const lit = name => {
    const m = new RegExp(`const ${name} = (/.*/);`).exec(siteWrite)
    assert.ok(m, `site_write.ts 找不到 ${name}`)
    const body = m[1].slice(1, m[1].lastIndexOf('/'))
    return body
  }
  assert.equal(VERSION_RE.source, new RegExp(lit('VERSION')).source)
  assert.equal(DATE_RE.source, new RegExp(lit('DATE')).source)
  assert.equal(COMMIT_RE.source, new RegExp(lit('COMMIT')).source)
  assert.equal(CONTROL_RE.source, new RegExp(lit('CONTROL')).source)
  const block = /const UNSAFE = \[\n([\s\S]*?)\n\];/.exec(siteWrite)[1]
  const ts = [...block.matchAll(/^\s*\/(.*)\/,/gm)].map(m => m[1])
  assert.equal(ts.length, 4)
  assert.deepEqual(UNSAFE_RES.map(r => r.source), ts.map(s => new RegExp(s).source))
  assert.ok(siteWrite.includes(`textArray(b.items, ${LIMITS.itemsMin}, ${LIMITS.itemsMax}, ${LIMITS.itemLen}, "items")`))
  assert.ok(siteWrite.includes(`textArray(b.platforms, 0, ${LIMITS.platformsMax}, ${LIMITS.platformLen}, "platforms")`))
})

test('對照 site_write_test.ts 的 checkText 樣本：結果相同', () => {
  assert.equal(checkText('**粗體** `code` #12 延遲 < 5 秒、a<5', 100), 'ok')
  assert.equal(checkText('第一行\n- 子項目\t', 100), 'ok')
  for (const v of ['', '   ', null, 3, 'x'.repeat(11), '響\u0007']) assert.equal(checkText(v, 10), 'bad', String(v))
  assert.equal(checkText('中'.repeat(10), 10), 'ok')
  for (const v of ['<script>', '</b>', '<!-- x', 'a@b.co', 'C:\\x', '/home/u', '/Users/u', '~/.asn', `eyJ${'a'.repeat(20)}`, `sk-${'a'.repeat(20)}`, `ghp_${'a'.repeat(20)}`, 'service_role']) {
    assert.equal(checkText(v, 100), 'unsafe', v)
  }
  assert.equal(checkText('a\0b', 100), 'bad')
})

test('對照 site_write_test.ts 的 parseRelease 樣本：日期', () => {
  assert.equal(validDate('2026-10-28'), true)
  assert.equal(validDate('2026-02-30'), false)
  assert.equal(validDate('2026/10/28'), false)
  assert.equal(validDate('2026-13-01'), false)
  assert.equal(validDate(undefined), false)
})

// ---- 逐項規則（壞例子）----
test('正常的草稿通過', () => { assert.deepEqual(checkRecord(REC), []) })

test('items 0／1／30／31 條', () => {
  assert.ok(problems({ items: [] }).length)
  assert.deepEqual(problems({ items: ['a'] }), [])
  assert.deepEqual(problems({ items: Array(30).fill('a') }), [])
  onlyField(problems({ items: Array(31).fill('a') }), 'items')
  onlyField(problems({ items: undefined }), 'items')
})

test('單條 1000／1001 字，以 code point 計（emoji 一個字）', () => {
  assert.deepEqual(problems({ items: ['中'.repeat(1000)] }), [])
  assert.deepEqual(problems({ items: ['😀'.repeat(1000)] }), [], '代理對只算一個字')
  const p = problems({ items: ['中'.repeat(1001)] })
  onlyField(p, 'items')
  assert.match(p[0].message, /1001 字.*不會自動截斷/)
  onlyField(problems({ items: ['😀'.repeat(1001)] }), 'items')
})

test('空白、控制字元、含 NUL：壞；tab 與換行可以', () => {
  onlyField(problems({ items: [''] }), 'items')
  onlyField(problems({ items: ['   '] }), 'items')
  onlyField(problems({ items: ['甲\u0007'] }), 'items')
  onlyField(problems({ items: ['甲\u007f'] }), 'items')
  onlyField(problems({ items: ['甲\0'] }), 'items')
  assert.deepEqual(problems({ items: ['甲\t乙'] }), [])
})

test('不安全樣式：HTML、電子郵件、本機路徑、金鑰', () => {
  for (const s of ['<b>x</b>', '看 <!-- 註解', '寄 a@b.co', 'C:\\Users\\x', '/home/me', '/Users/me', '~/.asn', `eyJ${'a'.repeat(20)}`, `sk-${'a'.repeat(20)}`, `ghp_${'a'.repeat(20)}`, 'service_role']) {
    const p = problems({ items: [s] })
    onlyField(p, 'items')
    assert.equal(p[0].error, 'unsafe_content', s)
    assert.ok(!p[0].message.includes(s), '訊息不複述內容')
  }
  assert.deepEqual(problems({ items: ['延遲 < 5 秒、a<5'] }), [], '比較符號可以')
})

test('platforms 0／10／11 個，每個 ≤20 字', () => {
  assert.deepEqual(problems({ platforms: [] }), [])
  assert.deepEqual(problems({ platforms: Array(10).fill('官網') }), [])
  onlyField(problems({ platforms: Array(11).fill('官網') }), 'platforms')
  assert.deepEqual(problems({ platforms: ['中'.repeat(20)] }), [])
  onlyField(problems({ platforms: ['中'.repeat(21)] }), 'platforms')
  onlyField(problems({ platforms: '官網' }), 'platforms')
})

test('commit 6／7／40／41 位與大寫', () => {
  onlyField(problems({ commit: 'abcdef' }), 'commit')
  assert.deepEqual(problems({ commit: 'abcdef1' }), [])
  assert.deepEqual(problems({ commit: 'a'.repeat(40) }), [])
  onlyField(problems({ commit: 'a'.repeat(41) }), 'commit')
  onlyField(problems({ commit: 'ABCDEF12' }), 'commit')
  onlyField(problems({ commit: 'xyz1234' }), 'commit')
  onlyField(problems({ commit: undefined }), 'commit')
})

test('日期與版本：錯誤日期、四段版號、v 開頭', () => {
  for (const d of ['2026-02-30', '2026/11/21', '2026-13-01', '', undefined, '2026-11-21T00:00:00Z']) onlyField(problems({ date: d }), 'date')
  for (const v of ['0.2.37.1', 'v0.2.37', '0.2', '12345.0.0']) onlyField(problems({ version: v }), 'version')
  onlyField(checkRecord(null).map(p => ({ ...p, field: 'x' })), 'x')
})

// ---- items 的組法 ----
test('items：頂層 bullet、縮排續行以空白併入、子 bullet 以「；」併入、標題與段落不算、* 也行', () => {
  const lines = [
    '- 甲條', '  續行一', '  續行二',
    '', '說明段落不是條目', '  這行縮排但前面是段落，不併入',
    '* 乙條', '  - 子一', '  - 子二', '    孫續行', '- 丙條',
  ]
  assert.deepEqual(sectionItems(lines), ['甲條 續行一 續行二', '乙條；子一；子二 孫續行', '丙條'])
})

test('items：CRLF 的 CHANGELOG、行尾空白都處理', () => {
  const r = draftFromChangelog({ changelog: cl('- 甲  \r\n- 乙\r\n').replace(/\n/g, '\r\n'), commit: 'abcdef12' })
  assert.deepEqual(r.draft.items, ['甲', '乙'])
  assert.equal(r.ok, true)
})

test('併入後超過 1000 字：預檢失敗，不截斷', () => {
  const r = draftFromChangelog({ changelog: cl(`- ${'中'.repeat(600)}\n  - ${'中'.repeat(401)}\n`), commit: 'abcdef12' })
  assert.equal(r.ok, false)
  assert.equal(r.draft.items[0].length, 600 + 1 + 401, '草稿保留原樣、不截斷')
  assert.match(r.problems[0].message, /超過 1000 字/)
  assert.equal(draftFromChangelog({ changelog: cl(`- ${'中'.repeat(600)}\n  - ${'中'.repeat(399)}\n`), commit: 'abcdef12' }).ok, true)
})

test('草稿欄位：版本與日期取標題、平台只有官網、commit 原樣', () => {
  const r = draftFromChangelog({ changelog: cl('- 甲\n'), commit: 'abcdef12' })
  assert.deepEqual(r.draft, { version: '0.2.37', date: '2026-11-21', commit: 'abcdef12', items: ['甲'], platforms: ['官網'] })
})

test('標題問題：沒日期、日期不真實、沒內容、版本與預期不同：失敗', () => {
  assert.equal(draftFromChangelog({ changelog: '## 0.2.37\n- 甲\n', commit: 'abcdef12' }).ok, false)
  const bad = draftFromChangelog({ changelog: '## 0.2.37（2026-02-30）\n- 甲\n', commit: 'abcdef12' })
  assert.equal(bad.ok, false)
  onlyField(bad.problems, 'date')
  assert.equal(draftFromChangelog({ changelog: cl('\n'), commit: 'abcdef12' }).ok, false)
  assert.equal(draftFromChangelog({ changelog: '', commit: 'abcdef12' }).ok, false)
  const mism = draftFromChangelog({ changelog: cl('- 甲\n'), commit: 'abcdef12', version: '0.2.38' })
  assert.equal(mism.ok, false)
  assert.match(mism.problems[0].message, /0\.2\.37.*0\.2\.38/)
})

// ---- 真實 CHANGELOG 的全部歷史段落 ----
// 0.1.99～0.1.101 三段的條目內文含 `pi install <ASN 原始碼` 這種寫法，被「HTML 標籤」規則擋下。規則不放寬；
// 這三段已發過版、不再重寫，所以列為已知例外，且例外必須「仍然只因 unsafe_content 失敗」，其餘每一段都要合法。
const KNOWN_BAD = new Set(['0.1.99', '0.1.100', '0.1.101'])

test('CHANGELOG 全部歷史段落：除已知三段外都能產出合法草稿', () => {
  const secs = changelogSections(real)
  assert.ok(secs.length >= 150, `段落數 ${secs.length}`)
  const unexpected = []
  secs.forEach((s, i) => {
    const r = draftFromChangelog({ changelog: real, commit: 'abcdef12', index: i })
    if (!r.ok && !KNOWN_BAD.has(s.version)) unexpected.push(`${s.heading}：${r.problems.map(p => p.message).join('；')}`)
  })
  assert.deepEqual(unexpected, [])
})

test('已知三段例外：仍只因為 unsafe_content 失敗（例外不能掩蓋別的問題；日後修了就把它從清單拿掉）', () => {
  const secs = changelogSections(real)
  for (const v of KNOWN_BAD) {
    const i = secs.findIndex(s => s.version === v)
    assert.ok(i >= 0, v)
    const r = draftFromChangelog({ changelog: real, commit: 'abcdef12', index: i })
    assert.equal(r.ok, false, `${v} 已能通過了，請從 KNOWN_BAD 拿掉`)
    assert.ok(r.problems.every(p => p.error === 'unsafe_content'), JSON.stringify(r.problems))
  }
})

test('最新一段（發版時實際檢查的那段）一定合法', () => {
  const r = draftFromChangelog({ changelog: real, commit: 'abcdef12' })
  assert.deepEqual(r.problems, [])
})

// ---- CLI ----
test('CLI：產出草稿寫檔；預檢失敗回 1 不寫檔；標籤格式錯回 2；讀不到標籤回 1', () => {
  const mk = (changelog, git) => {
    const out = { logs: [], files: {} }
    const io = { readFile: () => changelog, writeFile: (p, t) => { out.files[p] = t }, git, log: s => out.logs.push(s) }
    return { out, io }
  }
  const a = mk(cl('- 甲\n'), args => { assert.deepEqual(args, ['rev-parse', '--short=8', 'v0.2.37^{commit}']); return 'abcdef12' })
  assert.equal(main(['--changelog', 'c.md', '--tag', 'v0.2.37', '--out', 'd.json'], a.io), 0)
  assert.deepEqual(JSON.parse(a.out.files['d.json']), { version: '0.2.37', date: '2026-11-21', commit: 'abcdef12', items: ['甲'], platforms: ['官網'] })
  const b = mk(cl('- <b>x</b>\n'), () => 'abcdef12')
  assert.equal(main(['--changelog', 'c.md', '--tag', 'v0.2.37', '--out', 'd.json'], b.io), 1)
  assert.deepEqual(b.out.files, {})
  assert.equal(main(['--changelog', 'c.md', '--tag', '0.2.37'], b.io), 2)
  assert.equal(main(['--changelog', 'c.md', '--tag', 'v0.2.37'], mk(cl('- 甲\n'), () => { throw new Error('x') }).io), 1)
})
