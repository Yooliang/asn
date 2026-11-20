// tools/release/tag_check.mjs（#1892 規格 2.1 job 0）：標籤格式、四處版本、標籤在 main 上、CHANGELOG 第一段。注入式，不跑 git。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoLockVersion, cargoTomlVersion, checkTag, main } from '../../../tools/release/tag_check.mjs'

const V = '0.2.37'
const lock = v => `[[package]]\nname = "aho-corasick"\nversion = "1.1.3"\n\n[[package]]\nname = "asn"\nversion = "${v}"\ndependencies = [\n "base64",\n]\n`
const toml = v => `[package]\nname = "asn"\nversion = "${v}"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1" }\n`
const changelog = (v = V, body = '- 新功能：甲（#1）\n') => `# ASN 版本更新記錄\n\n說明\n\n## ${v}（2026-11-21）\n${body}\n## 0.2.36（2026-11-20）\n- 舊\n`
const good = () => ({
  packageJson: JSON.stringify({ name: 'asn', version: V }),
  cargoLock: lock(V),
  cargoToml: toml(V),
  tauriConf: JSON.stringify({ productName: 'ASN', version: V }),
  changelog: changelog(),
})
const onMain = { isAncestorOfMain: () => true }
const offMain = { isAncestorOfMain: () => false }
const run = (tag, files = good(), git = onMain) => checkTag({ tag, files, git })
const fails = (r, re) => { assert.equal(r.ok, false); assert.ok(r.problems.some(p => re.test(p)), r.problems.join('\n')) }

test('版本一致、標籤在 main、CHANGELOG 合格：通過', () => {
  const r = run(`v${V}`)
  assert.deepEqual(r, { ok: true, version: V, problems: [] })
})

test('package.json 版本不同：失敗，且指名檔案', () => {
  fails(run(`v${V}`, { ...good(), packageJson: JSON.stringify({ version: '0.2.36' }) }), /package\.json.*0\.2\.36/)
})

test('Cargo.lock 的 asn 版本不同：失敗；別的套件版本相同不能蒙混', () => {
  // 壞例子：舊的寫法若只抓檔內第一個 version，會被別的套件騙過
  const files = { ...good(), cargoLock: `[[package]]\nname = "other"\nversion = "${V}"\n\n[[package]]\nname = "asn"\nversion = "0.2.36"\n` }
  fails(run(`v${V}`, files), /Cargo\.lock.*0\.2\.36/)
})

test('Cargo.lock 沒有 asn 套件、或有兩段：失敗', () => {
  fails(run(`v${V}`, { ...good(), cargoLock: '[[package]]\nname = "x"\nversion = "0.2.37"\n' }), /Cargo\.lock/)
  fails(run(`v${V}`, { ...good(), cargoLock: lock(V) + lock(V) }), /Cargo\.lock/)
})

test('tauri.conf.json 與 Cargo.toml 版本不同：各自失敗', () => {
  fails(run(`v${V}`, { ...good(), tauriConf: JSON.stringify({ version: '0.2.36' }) }), /tauri\.conf\.json/)
  fails(run(`v${V}`, { ...good(), cargoToml: toml('0.2.36') }), /Cargo\.toml/)
})

test('Cargo.toml 的 version 只認 [package] 區塊，依賴的 version 不算', () => {
  assert.equal(cargoTomlVersion('[dependencies]\nserde = { version = "9" }\nversion = "9.9.9"\n[package]\nname = "asn"\nversion = "1.2.3"\n'), '1.2.3')
  assert.equal(cargoTomlVersion('[dependencies]\nversion = "9.9.9"\n'), null)
  assert.equal(cargoLockVersion('x'), null)
})

test('CRLF 的 Cargo.lock／Cargo.toml 也讀得到（本機 autocrlf）', () => {
  const crlf = s => s.replace(/\n/g, '\r\n')
  assert.deepEqual(run(`v${V}`, { ...good(), cargoLock: crlf(lock(V)), cargoToml: crlf(toml(V)), changelog: crlf(changelog()) }).problems, [])
})

test('標籤格式：四段、-rc、缺 v、大寫 V、多餘字元都失敗，不看檔案', () => {
  for (const t of ['v0.2.37.1', 'v0.2.37-rc1', 'v99999.0.0', 'v0.00000.1', '0.2.37', 'V0.2.37', 'v0.2', 'v0.2.37 ', 'refs/tags/v0.2.37', '', undefined, null]) {
    const r = run(t)
    assert.equal(r.ok, false, String(t))
    assert.equal(r.version, null)
    assert.match(r.problems[0], /標籤格式/)
  }
})

test('標籤 commit 不在 main：失敗；git 函式拋錯也當不在', () => {
  fails(run(`v${V}`, good(), offMain), /origin\/main/)
  fails(run(`v${V}`, good(), { isAncestorOfMain: () => { throw new Error('x') } }), /origin\/main/)
  // 只接受嚴格的 true
  fails(run(`v${V}`, good(), { isAncestorOfMain: () => 'yes' }), /origin\/main/)
})

test('git 函式收到的是標籤', () => {
  const seen = []
  run(`v${V}`, good(), { isAncestorOfMain: t => (seen.push(t), true) })
  assert.deepEqual(seen, [`v${V}`])
})

test('CHANGELOG：第一段版本不同、標題格式錯、沒有內容、沒有段落：失敗', () => {
  fails(run(`v${V}`, { ...good(), changelog: changelog('0.2.36') }), /CHANGELOG.*0\.2\.36/)
  fails(run(`v${V}`, { ...good(), changelog: `## ${V}\n- 沒日期\n` }), /標題/)
  fails(run(`v${V}`, { ...good(), changelog: changelog(V, '\n說明文字不是條列\n') }), /沒有條列內容/)
  fails(run(`v${V}`, { ...good(), changelog: '# 只有標題\n' }), /沒有任何/)
})

test('問題訊息不複述檔案內容', () => {
  const r = run(`v${V}`, { ...good(), packageJson: JSON.stringify({ version: '0.2.36', secret: 'SEKRET-XYZ' }) }, offMain)
  assert.ok(!r.problems.join('\n').includes('SEKRET'))
})

// ---- CLI ----
const cliEnv = (files, { ancestor = true, out = [] } = {}) => {
  const logs = []
  const written = []
  const env = { GITHUB_OUTPUT: 'out.txt' }
  const io = {
    readFile: p => {
      const n = p.replace(/\\/g, '/')
      if (n.endsWith('package.json')) return files.packageJson
      if (n.endsWith('Cargo.lock')) return files.cargoLock
      if (n.endsWith('Cargo.toml')) return files.cargoToml
      if (n.endsWith('tauri.conf.json')) return files.tauriConf
      if (n.endsWith('CHANGELOG.md')) return files.changelog
      throw new Error('ENOENT')
    },
    appendFile: (p, t) => written.push([p, t]),
    run: a => { out.push(a); if (!ancestor) throw new Error('not ancestor') },
    log: s => logs.push(s),
  }
  return { env, io, logs, written, out }
}

test('CLI：通過寫 GITHUB_OUTPUT 的 version，呼叫 git merge-base --is-ancestor <標籤>^{commit} origin/main', () => {
  const c = cliEnv(good())
  assert.equal(main([`v${V}`], c.env, c.io), 0)
  assert.deepEqual(c.written, [['out.txt', `version=${V}\n`]])
  assert.deepEqual(c.out, [['merge-base', '--is-ancestor', `v${V}^{commit}`, 'origin/main']])
})

test('CLI：不在 main 或版本不符回 1 且不寫輸出；檔案讀不到也失敗', () => {
  const a = cliEnv(good(), { ancestor: false })
  assert.equal(main([`v${V}`], a.env, a.io), 1)
  assert.deepEqual(a.written, [])
  const b = cliEnv({ ...good(), cargoLock: lock('0.2.36') })
  assert.equal(main([`v${V}`], b.env, b.io), 1)
  const c = cliEnv({})
  assert.equal(main([`v${V}`], c.env, c.io), 1)
})

test('真實檔案：目前 repo 的版本檔彼此一致，用自己的版本當標籤能通過版本與 CHANGELOG 檢查', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const rd = rel => fs.readFileSync(path.join(root, rel), 'utf8')
  const files = { packageJson: rd('package.json'), cargoLock: rd('src-tauri/Cargo.lock'), cargoToml: rd('src-tauri/Cargo.toml'), tauriConf: rd('src-tauri/tauri.conf.json'), changelog: rd('CHANGELOG.md') }
  const v = JSON.parse(files.packageJson).version
  const r = checkTag({ tag: `v${v}`, files, git: onMain })
  assert.deepEqual(r.problems, [])
})
