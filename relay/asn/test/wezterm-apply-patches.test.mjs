// #1896：wezterm-apply-patches.sh 要逐份核對「補丁實際改的檔案」等於 manifest 宣告的，補丁和清單要一一對應
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)
const SCRIPT = fileURLToPath(new URL('.github/scripts/wezterm-apply-patches.sh', root))
const REAL_DIR = fileURLToPath(new URL('patches/wezterm', root))

function findBash() {
  const cands = process.platform === 'win32'
    ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe', path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe')]
    : ['/bin/bash', '/usr/bin/bash']
  for (const c of cands) if (fs.existsSync(c)) return c
  const r = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  return r.status === 0 ? 'bash' : null
}
const BASH = findBash()
const SKIP = BASH ? false : '找不到 bash（Windows 需要 Git Bash）'
const toPosix = (p) => p.split(path.sep).join('/')
const git = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' })

const FILES = { linux: 'procinfo/src/linux.rs', macos: 'procinfo/src/macos.rs', windows: 'procinfo/src/windows.rs' }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-src-'))
  git(dir, 'init', '-q', '.')
  for (const f of Object.values(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), `// ${f}\nfn a() {}\n`)
  }
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base')
  return dir
}
// 對 repo 改指定檔，產生補丁文字（再還原工作樹）
function makePatch(repo, touched) {
  for (const f of touched) fs.appendFileSync(path.join(repo, f), `fn extra_${path.basename(f, '.rs')}() {}\n`)
  const r = git(repo, 'diff')
  git(repo, 'checkout', '-q', '--', '.')
  assert.ok(r.stdout.length > 0)
  return r.stdout
}
function run({ touched, declared, listed = true, writePatch = true, extraPatch = false, noPatches = false, extraLines = [] }) {
  const repo = makeRepo()
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-patch-'))
  const name = '0001-test.patch'
  const text = makePatch(repo, touched)
  if (writePatch && !noPatches) fs.writeFileSync(path.join(pdir, name), text)
  if (extraPatch) fs.writeFileSync(path.join(pdir, '0002-unlisted.patch'), text)
  const lines = ['# 註解', '']
  if (listed) lines.push(`${name}\t${declared.join(',')}`)
  lines.push(...extraLines)
  fs.writeFileSync(path.join(pdir, 'manifest.txt'), lines.join('\n') + '\n')
  const r = spawnSync(BASH, [toPosix(SCRIPT), toPosix(repo), toPosix(pdir)], { encoding: 'utf8' })
  return { r, repo }
}

test('正常：只改 windows.rs、宣告 windows.rs → 通過，stdout 印出聯集', { skip: SKIP }, () => {
  const { r, repo } = run({ touched: [FILES.windows], declared: [FILES.windows] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), FILES.windows)
  assert.match(git(repo, 'log', '--format=%s', '-1').stdout, /^asn patch: 0001-test\.patch/)
})

test('補丁多改了 linux.rs、宣告只有 windows.rs → 失敗', { skip: SKIP }, () => {
  const { r } = run({ touched: [FILES.windows, FILES.linux], declared: [FILES.windows] })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /::error::/)
  assert.match(r.stderr, /linux\.rs/)
  assert.match(r.stderr, /實際動到的檔案/) // 套用之前的 numstat 比對就要擋下，不能等到 commit 之後
})

test('補丁沒動 windows.rs（改 linux.rs）、宣告 windows.rs → 失敗', { skip: SKIP }, () => {
  const { r } = run({ touched: [FILES.linux], declared: [FILES.windows] })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /::error::/)
})

test('有補丁沒列在清單 → 失敗', { skip: SKIP }, () => {
  const { r } = run({ touched: [FILES.windows], declared: [FILES.windows], extraPatch: true })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /::error::.*0002-unlisted\.patch.*沒有列在/)
})

test('清單列了但檔案不存在 → 失敗', { skip: SKIP }, () => {
  // 0001 照常存在且有列（其他核對都會過），清單另外多列一份資料夾裡沒有的 0009（#1992：要真的走到「列了但沒有檔」那一支）
  const { r } = run({ touched: [FILES.windows], declared: [FILES.windows], extraLines: [`0009-missing.patch\t${FILES.windows}`] })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /::error::manifest\.txt 列了 0009-missing\.patch，但資料夾裡沒有這個檔/)
})

test('#1992 清單列的補丁檔名不是 .patch 結尾 → 失敗', { skip: SKIP }, () => {
  const { r } = run({ touched: [FILES.windows], declared: [FILES.windows], extraLines: [`README.txt\t${FILES.windows}`] })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /::error::清單列的補丁檔名要以 \.patch 結尾：README\.txt/)
})

test('補丁資料夾沒有任何補丁 → 失敗', { skip: SKIP }, () => {
  const { r } = run({ touched: [FILES.windows], declared: [FILES.windows], noPatches: true })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /::error::.*沒有任何 \.patch/)
})

test('真的 patches/wezterm：清單和 .patch 一一對應，numstat 解析的檔名等於宣告', () => {
  const manifest = fs.readFileSync(path.join(REAL_DIR, 'manifest.txt'), 'utf8')
  const decl = new Map()
  for (const line of manifest.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [name, files] = line.split('\t')
    assert.ok(name && files, `清單格式：${line}`)
    decl.set(name, files.split(',').map((s) => s.trim()).sort())
  }
  const onDisk = fs.readdirSync(REAL_DIR).filter((f) => f.endsWith('.patch')).sort()
  assert.ok(onDisk.length >= 1)
  assert.deepEqual([...decl.keys()].sort(), onDisk)
  assert.ok(decl.has('0001-procinfo-build-proc-iterative.patch'))
  assert.ok(decl.has('0002-procinfo-parent-start-time.patch'), '#1914：0002 要列在清單')
  assert.deepEqual(decl.get('0002-procinfo-parent-start-time.patch'), ['procinfo/src/windows.rs'])
  for (const p of onDisk) {
    const r = git(os.tmpdir(), 'apply', '--numstat', path.join(REAL_DIR, p))
    assert.equal(r.status, 0, r.stderr)
    const got = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[2]).sort()
    assert.deepEqual(got, decl.get(p), p)
  }
})

test('#1992 長鏈紅燈對照用明確的 #7706 commit，不靠 HEAD~1（多一份修補時語意才不會變）', () => {
  const s = fs.readFileSync(new URL('../../../.github/scripts/wezterm-procinfo-cycle-test.sh', import.meta.url), 'utf8')
  assert.ok(!/HEAD~1/.test(s.replace(/^\s*#.*$/gm, '')), '程式行不能再用 HEAD~1')
  assert.match(s, /ONLY_7706="\$\(git rev-list --max-count=1 --invert-grep --grep='\^asn patch: ' HEAD\)"/)
  assert.match(s, /git log -1 --format=%s "\$PATCH_SHA"/, '要核對它就是 #7706 的 cherry-pick')
  assert.match(s, /git checkout "\$ONLY_7706" -- "\$FILE"/)
})

test('#2006 產物的 SOURCE.txt 照實寫出 ASN 修補：Linux 包列出套了哪些修補，用詞統一為「ASN 修補」，不再寫「只多套用 #7706」', () => {
  const rd = p => fs.readFileSync(new URL(`../../../.github/${p}`, import.meta.url), 'utf8')
  const linux = rd('scripts/wezterm-build-linux.sh'), prep = rd('scripts/wezterm-release-prepare.sh'), wf = rd('workflows/wezterm-build.yml')
  for (const [n, s] of [['wezterm-build-linux.sh', linux], ['wezterm-release-prepare.sh', prep], ['wezterm-build.yml', wf]]) {
    assert.ok(!/只多套用上游 #7706）/.test(s), `${n} 還寫「只多套用上游 #7706」`)
    assert.ok(!/ASN 補丁/.test(s), `${n} 用詞要統一成「ASN 修補」`)
  }
  assert.match(linux, /ASN_PATCHES="\$\(git -C "\$SRC" log --format=%s \| sed -n "s\/\^asn patch: \/\/p"/)
  assert.match(linux, /ASN 修補 \$\{ASN_PATCHES\}/)
  assert.match(linux, /\[ -n "\$ASN_PATCHES" \] \|\| \{ echo "::error::/, '找不到修補要失敗，不能寫出空白')
})

test('#2008 Linux SOURCE.txt 的修補清單：兩份以上用「、」接起來是合法 UTF-8（實際跑腳本裡那條管線）', { skip: SKIP }, () => {
  const src = fs.readFileSync(new URL('../../../.github/scripts/wezterm-build-linux.sh', import.meta.url), 'utf8')
  const code = src.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n')
  assert.ok(!/paste -sd/.test(code), '不能用 paste -sd 接多位元組分隔字（coreutils 8.x 會拆開）')
  const line = src.split(/\r?\n/).find(l => l.startsWith('ASN_PATCHES='))
  assert.ok(line, '前提：找得到 ASN_PATCHES 那一行')
  // 把 git log 換成固定的三個 commit 標題（兩份修補＋一個不相干的），其餘管線原樣跑
  const pipeline = line.replace(/^ASN_PATCHES="\$\(git -C "\$SRC" log --format=%s/, 'printf \'%s\n\' "asn patch: 0002-b.patch" "其他提交" "asn patch: 0001-a.patch"').replace(/\)"\s*$/, '')
  assert.ok(pipeline.startsWith('printf'), `前提：替換成功：${pipeline}`)
  const r = spawnSync(BASH, ['-c', pipeline], { encoding: 'buffer' })
  assert.equal(r.status, 0, String(r.stderr))
  const out = new TextDecoder('utf-8', { fatal: true }).decode(r.stdout).trim() // 壞的 UTF-8 會在這裡丟錯
  assert.equal(out, '0001-a.patch、0002-b.patch')
})
