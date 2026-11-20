// #1979 第二項：tools/release/release-tag.mjs 一個指令發版。git 與子程序全用假的，檔案用暫存資料夾裡複製來的真實格式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { releaseTag, parseArgs, FILES, COMMIT_PATHS, nextPatch, readVersions, taipeiDate } from '../../../tools/release/release-tag.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..')
const RULES = [
  { glob: 'relay/asn/ui/**', platforms: ['desktop', 'linux', 'android'] },
  { glob: 'relay/asn/src-tauri/src/**/*.rs', platforms: ['desktop', 'linux'] },
  { glob: 'relay/asn/src-tauri/gen/android/**', platforms: ['android'] },
  { glob: 'tools/**', platforms: [] },
]
const CUR = JSON.parse(fs.readFileSync(path.join(REPO, FILES.packageJson), 'utf8')).version
const NEXT = nextPatch(CUR)

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'))
  for (const rel of COMMIT_PATHS) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    let t = fs.readFileSync(path.join(REPO, rel), 'utf8')
    t = t.replace(/\r\n/g, '\n') // 固定成 LF（工作樹可能因 autocrlf 是 CRLF），來測「LF 維持 LF」
    fs.writeFileSync(path.join(dir, rel), t)
  }
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify(['改善：測試條目。（#1979）']))
  return dir
}

// changed：每個平台標籤到 HEAD 之間改到的檔（三個平台共用同一份）
function setup(over = {}) {
  const dir = mkTmp()
  const calls = []
  const o = { branch: 'main', dirty: '', head: 'a'.repeat(40), originMain: 'a'.repeat(40), existingTags: [], changed: ['relay/asn/ui/x.js'], runFail: null, ...over }
  const lastTags = [`v${CUR}`, `linux-v${CUR}`, `android-v${CUR}`]
  const git = (args, opt = {}) => {
    calls.push({ kind: 'git', args, input: opt.input })
    const k = args.join(' ')
    if (k === 'rev-parse --abbrev-ref HEAD') return o.branch
    if (k === 'status --porcelain') return o.dirty
    if (k === 'rev-parse HEAD') return o.head
    if (k === 'rev-parse origin/main') return o.originMain
    if (k === 'rev-parse --short=8 HEAD') return 'aaaaaaaa'
    if (args[0] === 'tag' && args[1] === '--list') {
      const pat = args[2]
      const all = [...lastTags, ...o.existingTags]
      return all.filter(t => (pat.endsWith('*') ? new RegExp('^' + pat.slice(0, -1).replace(/[.+]/g, '\\$&') + '\\d').test(t) && !(pat === 'v*' && !t.startsWith('v')) : t === pat)).join('\n')
    }
    if (args[0] === 'log') return '\x1e改動\n\n' + o.changed.join('\n')
    if (args[0] === 'diff' && args[1] === '--name-only') return o.changed.join('\n')
    if (args[0] === 'diff') return ''
    return ''
  }
  const run = (cmd, args) => {
    calls.push({ kind: 'run', cmd, args })
    if (o.runFail && args.join(' ').includes(o.runFail)) return { ok: false, output: '假的失敗' }
    return { ok: true, output: '' }
  }
  const logs = []
  const deps = {
    git, run, rules: RULES,
    readFile: p => fs.readFileSync(path.resolve(dir, p), 'utf8'),
    writeFile: (p, t) => { calls.push({ kind: 'write', path: p }); fs.writeFileSync(path.resolve(dir, p), t) },
    now: () => new Date('2026-11-21T17:30:00Z'), // 台北已是 11-22
    log: s => logs.push(s),
  }
  return { dir, calls, deps, logs }
}
const opts = (over = {}) => ({ version: NEXT, itemsFile: 'items.json', allowSkip: false, dryRun: false, ...over })
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8')
const writes = calls => calls.filter(c => c.kind === 'write' || (c.kind === 'git' && ['commit', 'tag', 'push', 'fetch'].includes(c.args[0]) && !(c.args[0] === 'tag' && c.args[1] === '--list')) || (c.kind === 'run'))

test('parseArgs：版號必給、未知參數擋下', () => {
  assert.equal(parseArgs([]).error !== null, true)
  assert.equal(parseArgs(['0.2.9', '--x']).error !== null, true)
  const o = parseArgs(['0.2.9', '--items-file', 'a.json', '--allow-skip', '--dry-run'])
  assert.deepEqual([o.version, o.itemsFile, o.allowSkip, o.dryRun, o.error], ['0.2.9', 'a.json', true, true, null])
})

test('版號格式錯 → 停，什麼都沒寫', async () => {
  const s = setup()
  const r = await releaseTag(opts({ version: '0.2' }), s.deps)
  assert.equal(r.ok, false)
  assert.match(s.logs.join('\n'), /版號格式不對/)
  assert.equal(writes(s.calls).length, 0)
})

test('不是加一 → 停；加 --allow-skip 可以', async () => {
  const skip = nextPatch(NEXT)
  const s = setup()
  const r = await releaseTag(opts({ version: skip }), s.deps)
  assert.equal(r.ok, false)
  assert.match(s.logs.join('\n'), /加一/)
  const s2 = setup()
  const r2 = await releaseTag(opts({ version: skip, allowSkip: true }), s2.deps)
  assert.equal(r2.ok, true)
  assert.equal(readVersions({ packageJson: read(s2.dir, FILES.packageJson), tauriConf: read(s2.dir, FILES.tauriConf), cargoToml: read(s2.dir, FILES.cargoToml), pluginJson: read(s2.dir, FILES.pluginJson), cargoLock: read(s2.dir, FILES.cargoLock) }).cargoLock, skip)
})

test('不在 main → 停', async () => {
  const s = setup({ branch: 'feat/x' })
  const r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, false)
  assert.match(s.logs.join('\n'), /不在 main/)
  assert.equal(writes(s.calls).filter(c => c.kind !== 'git' || c.args[0] !== 'fetch').length, 0)
})

test('工作樹髒 → 停', async () => {
  const s = setup({ dirty: ' M foo.txt' })
  assert.equal((await releaseTag(opts(), s.deps)).ok, false)
  assert.match(s.logs.join('\n'), /工作樹不乾淨/)
})

test('HEAD 不是最新 → 停', async () => {
  const s = setup({ originMain: 'b'.repeat(40) })
  assert.equal((await releaseTag(opts(), s.deps)).ok, false)
  assert.match(s.logs.join('\n'), /不是最新的 origin\/main/)
})

test('標籤已存在（任一種）→ 停', async () => {
  for (const t of [`v${NEXT}`, `linux-v${NEXT}`, `android-v${NEXT}`]) {
    const s = setup({ existingTags: [t] })
    assert.equal((await releaseTag(opts(), s.deps)).ok, false, t)
    assert.match(s.logs.join('\n'), new RegExp(`標籤 ${t} 已經存在`))
  }
})

test('沒給 items-file → 停', async () => {
  const s = setup()
  const r = await releaseTag(opts({ itemsFile: null }), s.deps)
  assert.equal(r.ok, false)
  assert.match(s.logs.join('\n'), /沒給 --items-file/)
})

test('平台標註跟判斷對不上 → 停，指出哪一條與該怎麼標', async () => {
  // 只動手機專用檔 → 只打手機，條目沒標
  let s = setup({ changed: ['relay/asn/src-tauri/gen/android/a.kt'] })
  let r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, false)
  assert.match(s.logs.join('\n'), /第 1 條要標「只有手機版」/)
  // 只動 Rust → 電腦與 Linux，條目標成手機版
  fs.writeFileSync(path.join(s.dir, 'items.json'), JSON.stringify(['改善（只有手機版）：甲。', '修正：乙。']))
  s = setup({ changed: ['relay/asn/src-tauri/src/lib.rs'] })
  fs.writeFileSync(path.join(s.dir, 'items.json'), JSON.stringify(['修正（電腦版與 Linux）：甲。', '修正（只有手機版）：乙。']))
  r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, false)
  assert.match(s.logs.join('\n'), /第 2 條要標「電腦版與 Linux」/)
  assert.doesNotMatch(s.logs.join('\n'), /第 1 條要標/)
  // 開頭不是修正／改善／新功能
  s = setup()
  fs.writeFileSync(path.join(s.dir, 'items.json'), JSON.stringify(['調整：亂寫。']))
  assert.equal((await releaseTag(opts(), s.deps)).ok, false)
  assert.match(s.logs.join('\n'), /第 1 條開頭要是/)
})

test('三個都不打 → 停', async () => {
  const s = setup({ changed: ['tools/x.mjs'] })
  const r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, false)
  assert.match(s.logs.join('\n'), /三個平台都不打/)
  assert.equal(writes(s.calls).filter(c => c.kind === 'write').length, 0)
})

const CALL_ORDER = ['write', 'commit', 'tag', 'site', 'version', 'push-main', 'tagcheck', 'push-tags']
const label = c => {
  if (c.kind === 'write') return 'write'
  if (c.kind === 'run') return c.args[0].includes('site_record_check') ? 'site' : c.args[0] === '--test' ? 'version' : c.args[0].includes('tag_check') ? 'tagcheck' : 'run?'
  if (c.args[0] === 'commit') return 'commit'
  if (c.args[0] === 'tag' && c.args[1] !== '--list') return 'tag'
  if (c.args[0] === 'push') return c.args[2] === 'HEAD:main' ? 'push-main' : 'push-tags'
  return null
}
const dedupe = a => a.filter((x, i) => x && x !== a[i - 1])

test('正常流程（三個都打）：六個檔改對、Cargo.lock 只動 asn、標題與插入位置、LF、只提交六個檔、順序', async () => {
  const s = setup({ changed: ['relay/asn/ui/x.js'] })
  const before = {}
  for (const rel of COMMIT_PATHS) before[rel] = read(s.dir, rel)
  const r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, true, s.logs.join('\n'))
  assert.deepEqual(r.tags, [`v${NEXT}`, `linux-v${NEXT}`, `android-v${NEXT}`])
  const after = {}
  for (const rel of COMMIT_PATHS) after[rel] = read(s.dir, rel)
  assert.equal(JSON.parse(after[FILES.packageJson]).version, NEXT)
  assert.equal(JSON.parse(after[FILES.tauriConf]).version, NEXT)
  assert.equal(JSON.parse(after[FILES.pluginJson]).version, NEXT)
  assert.match(after[FILES.cargoToml], new RegExp(`^version = "${NEXT.replace(/\./g, '\\.')}"`, 'm'))
  // Cargo.lock：asn 那段改了，其餘逐字不變
  const lockB = before[FILES.cargoLock], lockA = after[FILES.cargoLock]
  assert.match(lockA, new RegExp(`name = "asn"\\nversion = "${NEXT.replace(/\./g, '\\.')}"`))
  assert.equal(lockA, lockB.replace(`name = "asn"\nversion = "${CUR}"`, `name = "asn"\nversion = "${NEXT}"`))
  const diffLines = lockA.split('\n').filter((l, i) => l !== lockB.split('\n')[i])
  assert.equal(diffLines.length, 1)
  // CHANGELOG：標題全形括號、台北日期（UTC 11-21 17:30 → 11-22）、插在舊的最上段正上方、空一行、LF
  const cl = after[FILES.changelog]
  assert.doesNotMatch(cl, /\r/)
  const oldFirst = before[FILES.changelog].match(/^## .*$/m)[0]
  const sec = `## ${NEXT}（2026-11-22）\n- 改善：測試條目。（#1979）\n\n`
  assert.equal(cl, before[FILES.changelog].replace(oldFirst, sec + oldFirst))
  // 提交
  const commit = s.calls.find(c => c.kind === 'git' && c.args[0] === 'commit')
  assert.deepEqual(commit.args, ['commit', '-F', '-', '--', ...COMMIT_PATHS])
  assert.equal(commit.args.slice(4).length, 6)
  assert.equal(commit.input, `release: ${NEXT}\n`)
  // 順序
  assert.deepEqual(dedupe(s.calls.map(label)), CALL_ORDER)
  // 標籤與 tag_check 參數
  const tagCalls = s.calls.filter(c => c.kind === 'git' && c.args[0] === 'tag' && c.args[1] !== '--list').map(c => c.args[1])
  assert.deepEqual(tagCalls, [`v${NEXT}`, `linux-v${NEXT}`, `android-v${NEXT}`])
  const tc = s.calls.filter(c => c.kind === 'run' && c.args[0].includes('tag_check')).map(c => c.args.slice(1))
  assert.deepEqual(tc, [[`v${NEXT}`], [`linux-v${NEXT}`, '--prefix', 'linux-v'], [`android-v${NEXT}`, '--prefix', 'android-v']])
  assert.deepEqual(s.calls.at(-1).args, ['push', 'origin', `v${NEXT}`, `linux-v${NEXT}`, `android-v${NEXT}`])
})

test('只打判斷出來的標籤（電腦＋Linux，不含手機）；CRLF 檔維持 CRLF', async () => {
  const s = setup({ changed: ['relay/asn/src-tauri/src/lib.rs'] })
  fs.writeFileSync(path.join(s.dir, 'items.json'), JSON.stringify(['修正（電腦版與 Linux）：甲。']))
  const crlf = read(s.dir, FILES.changelog).replace(/\n/g, '\r\n')
  fs.writeFileSync(path.join(s.dir, FILES.changelog), crlf)
  const r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, true, s.logs.join('\n'))
  assert.deepEqual(r.tags, [`v${NEXT}`, `linux-v${NEXT}`])
  assert.equal(s.calls.some(c => c.kind === 'git' && c.args[0] === 'tag' && String(c.args[1]).startsWith('android')), false)
  assert.equal(s.calls.some(c => c.kind === 'run' && c.args.includes('android-v' + NEXT)), false)
  const cl = read(s.dir, FILES.changelog)
  assert.equal(cl.replace(/\r\n/g, '').includes('\n'), false)
  assert.match(cl, new RegExp(`^# ASN[^\\n]*\\r\\n`))
  assert.match(cl, new RegExp(`## ${NEXT.replace(/\./g, '\\.')}（2026-11-22）\\r\\n- 修正（電腦版與 Linux）：甲。\\r\\n\\r\\n## `))
})

test('只打手機：條目標「只有手機版」就過，site 預檢改走程式內檢查，不跑 v 標籤', async () => {
  const s = setup({ changed: ['relay/asn/src-tauri/gen/android/a.kt'] })
  fs.writeFileSync(path.join(s.dir, 'items.json'), JSON.stringify(['修正（只有手機版）：甲。']))
  const r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, true, s.logs.join('\n'))
  assert.deepEqual(r.tags, [`android-v${NEXT}`])
  assert.equal(s.calls.some(c => c.kind === 'run' && c.args[0].includes('site_record_check')), false)
})

test('中途失敗（site_record_check）→ 之後的 push 一個都沒呼叫，並印出還原指令', async () => {
  const s = setup({ runFail: 'site_record_check' })
  const r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, false)
  assert.equal(r.failedStep, '官網紀錄預檢')
  assert.equal(s.calls.some(c => c.kind === 'git' && c.args[0] === 'push'), false)
  assert.equal(s.calls.some(c => c.kind === 'run' && c.args[0].includes('tag_check')), false)
  const out = s.logs.join('\n')
  assert.match(out, /已完成的步驟：前置檢查 → 改檔 → 提交 → 本機打標籤/)
  assert.match(out, /git reset --hard HEAD~1/)
  for (const t of [`v${NEXT}`, `linux-v${NEXT}`, `android-v${NEXT}`]) assert.match(out, new RegExp(`git tag -d ${t}`))
})

test('推 main 之後 tag_check 失敗 → 不推標籤', async () => {
  const s = setup({ runFail: 'linux-v' })
  const r = await releaseTag(opts(), s.deps)
  assert.equal(r.ok, false)
  assert.equal(r.failedStep, '標籤檢查')
  const pushes = s.calls.filter(c => c.kind === 'git' && c.args[0] === 'push')
  assert.equal(pushes.length, 1)
  assert.deepEqual(pushes[0].args, ['push', 'origin', 'HEAD:main'])
  assert.match(s.logs.join('\n'), /main 已經推上去了/)
})

test('--dry-run：不寫檔、不跑子程序、無任何 git 寫入；印出完整計畫', async () => {
  const s = setup({ branch: 'feat/x' }) // dry-run 在非 main 也能印計畫，只提醒
  const before = COMMIT_PATHS.map(p => read(s.dir, p))
  const r = await releaseTag(opts({ dryRun: true }), s.deps)
  assert.equal(r.ok, true)
  assert.equal(writes(s.calls).length, 0)
  assert.deepEqual(COMMIT_PATHS.map(p => read(s.dir, p)), before)
  const out = s.logs.join('\n')
  assert.match(out, /平台｜打或不打/)
  assert.match(out, new RegExp(`${CUR.replace(/\./g, '\\.')} → ${NEXT.replace(/\./g, '\\.')}`))
  assert.match(out, new RegExp(`## ${NEXT.replace(/\./g, '\\.')}（2026-11-22）`))
  for (const f of COMMIT_PATHS) assert.ok(out.includes(f), f)
  assert.match(out, /會打的標籤：.*android-v/)
  assert.match(out, /步驟：/)
  assert.match(out, /實際執行時會停下/)
})

test('taipeiDate：UTC 16:00 之後就是台北隔天', () => {
  assert.equal(taipeiDate(new Date('2026-11-21T15:59:00Z')), '2026-11-21')
  assert.equal(taipeiDate(new Date('2026-11-21T16:00:00Z')), '2026-11-22')
})
