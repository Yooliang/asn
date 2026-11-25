// #2163 PR-3b：「正式安裝包不帶 test-hooks」四道證明的腳本與接線測試。
// 一：原始碼守門（cargo test）　二：build.rs 的 ASN_SHIPPING_BUILD 鎖（cargo test）　三：標記掃描　四：行為探針
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MARKER, checkMarker, hasMarker, main as scanMain, parseArgs as scanArgs } from '../scripts/hooks-marker-scan.mjs'
import { judgeProbe, parseArgs as probeArgs } from '../scripts/hooks-probe.mjs'
import { parseArgs as proofArgs } from '../scripts/hooks-proof.mjs'
import { hooksBuildArgs, hooksBuildEnv } from '../scripts/build-hooks-exe.mjs'
import { shippingEnv, tauriBuildArgs } from '../scripts/release-ci.mjs'
import { e2eMainExe, hooksExe, defaultExe, hooksExeSkip } from '../scripts/shot.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const wf = f => fs.readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), 'utf8')
const fakeExe = withMarker => Buffer.concat([Buffer.from('MZ\0\0 some binary '), withMarker ? Buffer.from(MARKER) : Buffer.alloc(0), Buffer.from(' tail\0')])

// ---- 三：標記掃描 ----
test('標記掃描：正式版不准有、hooks 版一定要有', () => {
  assert.equal(checkMarker('r.exe', 'absent', () => fakeExe(false)).ok, true)
  assert.equal(checkMarker('h.exe', 'present', () => fakeExe(true)).ok, true)
  const bad = checkMarker('r.exe', 'absent', () => fakeExe(true))
  assert.equal(bad.ok, false)
  assert.match(bad.message, /掃到 test-hooks 標記/)
})

test('標記掃描：拿到「沒有標記的 hooks 版」要報錯（對照組失效不能放行）', () => {
  const r = checkMarker('h.exe', 'present', () => fakeExe(false))
  assert.equal(r.ok, false)
  assert.match(r.message, /掃不到標記/)
})

test('標記掃描：讀不到、空檔、不認得的期望值一律失敗（不能把「沒讀到」當成「沒有標記」）', () => {
  assert.equal(checkMarker('x', 'absent', () => { throw new Error('ENOENT') }).ok, false)
  assert.equal(checkMarker('x', 'absent', () => Buffer.alloc(0)).ok, false)
  assert.equal(checkMarker('x', 'whatever', () => fakeExe(false)).ok, false)
})

test('標記掃描：實際的檔案與命令列（兩邊都要給）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-scan-'))
  const rel = path.join(dir, 'asn'), hk = path.join(dir, 'asn-hooks'), bad = path.join(dir, 'asn-nomarker')
  fs.writeFileSync(rel, fakeExe(false)); fs.writeFileSync(hk, fakeExe(true)); fs.writeFileSync(bad, fakeExe(false))
  const quiet = fn => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return fn() } finally { console.log = l; console.error = e } }
  assert.equal(quiet(() => scanMain(['--absent', rel, '--present', hk])), 0)
  assert.equal(quiet(() => scanMain(['--absent', hk, '--present', hk])), 1, '正式版有標記要紅')
  assert.equal(quiet(() => scanMain(['--absent', rel, '--present', bad])), 1, 'hooks 版沒標記要紅')
  assert.equal(quiet(() => scanMain(['--absent', rel])), 2, '只驗一邊會假綠，參數就擋掉')
  assert.ok(scanArgs(['--present', hk]).error)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('標記字串：只出現在標記掃描腳本、測試與 test_var.rs，不在其他會編進 exe 的原始碼', () => {
  assert.ok(hasMarker(Buffer.from(`xx${MARKER}yy`)))
  const rs = read('src-tauri/src/flags/test_var.rs')
  assert.ok(rs.includes(`#[cfg(feature = "test-hooks")]\n#[used]\npub static TEST_HOOKS_MARKER`), '標記只在 test-hooks feature 開時才編進去')
  const hits = []
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.rs') && fs.readFileSync(p, 'utf8').includes(MARKER)) hits.push(path.relative(path.join(import.meta.dirname, '..', 'src-tauri'), p).replace(/\\/g, '/')) } }
  walk(path.join(import.meta.dirname, '..', 'src-tauri', 'src'))
  assert.deepEqual(hits, ['src/flags/test_var.rs'])
})

// ---- 四：行為探針 ----
const shotResult = (reqs, over = {}) => ({ code: 0, files: ['tabs-login.png'], relay: { reqs: reqs.map(action => ({ action })) }, ...over })

test('行為探針：正式版沒收到 node_claim 才算過；收到就紅', () => {
  assert.equal(judgeProbe(shotResult(['list']), 'noclaim').ok, true)
  const bad = judgeProbe(shotResult(['node_claim', 'list']), 'noclaim')
  assert.equal(bad.ok, false)
  assert.match(bad.message, /在正式版生效/)
})

test('行為探針：hooks 版一定要收到 node_claim（探針的對照組），沒收到就紅', () => {
  assert.equal(judgeProbe(shotResult(['node_claim']), 'claim').ok, true)
  const bad = judgeProbe(shotResult(['list']), 'claim')
  assert.equal(bad.ok, false)
  assert.match(bad.message, /沒有對照組/)
})

test('行為探針：程式沒跑起來（非零結束碼、完全沒活動）不能當成「沒收到 node_claim」', () => {
  assert.equal(judgeProbe(shotResult([], { code: 1 }), 'noclaim').ok, false)
  assert.equal(judgeProbe(shotResult([], { code: 'timeout' }), 'noclaim').ok, false)
  assert.equal(judgeProbe({ code: 0, files: [], relay: { reqs: [] } }, 'noclaim').ok, false)
  assert.equal(judgeProbe(shotResult(['list']), 'bogus').ok, false)
})

test('探針與證明入口：兩邊的 exe 都要給', () => {
  assert.ok(probeArgs(['--release', 'a']).error)
  assert.deepEqual(probeArgs(['--release', 'a', '--hooks', 'b']), { release: 'a', hooks: 'b' })
  assert.ok(proofArgs(['--bogus']).error)
  assert.equal(proofArgs([], 'R', 'H').release, 'R')
})

// ---- 二、建置與接線 ----
test('發版建置：tauri build 不帶 --features，環境變數設 ASN_SHIPPING_BUILD=1', () => {
  assert.ok(!tauriBuildArgs('tauri.js').some(a => /feature|test-hooks/.test(a)))
  assert.equal(shippingEnv({ A: '1' }).ASN_SHIPPING_BUILD, '1')
  const ci = read('scripts/release-ci.mjs')
  assert.ok(ci.includes("shippingEnv(env))"), 'tauri build 要用 shippingEnv')
  for (const f of ['scripts/release.mjs', 'scripts/release-android.mjs', 'scripts/release-play.mjs']) assert.match(read(f), /ASN_SHIPPING_BUILD: '1'/, f)
})

test('hooks 版的建置參數：帶 test-hooks、與 tauri build 同一組 release 設定；環境絕不帶 ASN_SHIPPING_BUILD', () => {
  const a = hooksBuildArgs()
  assert.ok(a.includes('--release') && a.includes('--locked') && a.includes('--bin'))
  assert.match(a[a.indexOf('--features') + 1], /^test-hooks,/)
  assert.equal('ASN_SHIPPING_BUILD' in hooksBuildEnv({ ASN_SHIPPING_BUILD: '1', X: '2' }), false)
  assert.equal(hooksBuildEnv({ X: '2' }).X, '2')
})

test('release-ci：hooks 版在正式建置之前建，正式建置之後跑證明；其他發版入口不碰 test-hooks', () => {
  const ci = read('scripts/release-ci.mjs')
  const iHooks = ci.indexOf("'scripts/build-hooks-exe.mjs'"), iTauri = ci.indexOf('tauriBuildArgs(path.join'), iProof = ci.indexOf("'scripts/hooks-proof.mjs'")
  assert.ok(iHooks > 0 && iHooks < iTauri && iTauri < iProof, `順序不對：hooks=${iHooks} tauri=${iTauri} proof=${iProof}`)
  for (const f of ['scripts/release.mjs', 'scripts/release-android.mjs', 'scripts/release-play.mjs', 'scripts/build-linux-bridge.mjs']) assert.ok(!read(f).split('\n').filter(l => !l.trim().startsWith('//')).join('\n').includes('test-hooks'), `${f} 不准帶 test-hooks`)
})

test('Linux 發版與 PR CI：先建 hooks 版、正式建置設 ASN_SHIPPING_BUILD、e2e 要求 hooks 版、最後跑證明', () => {
  for (const f of ['asn-release-linux.yml', 'asn-linux-build.yml']) {
    const y = wf(f)
    const iHooks = y.indexOf('node scripts/build-hooks-exe.mjs'), iBuild = y.indexOf('-- npm run build'), iE2e = y.indexOf('login-e2e-bind.test.mjs'), iProof = y.indexOf('node scripts/hooks-proof.mjs')
    assert.ok(iHooks > 0 && iHooks < iBuild && iBuild < iE2e && iE2e < iProof, `${f} 順序不對：${iHooks} ${iBuild} ${iE2e} ${iProof}`)
    assert.match(y.slice(iHooks, iBuild), /ASN_SHIPPING_BUILD: '1'/, `${f} 正式建置要設 ASN_SHIPPING_BUILD`)
    assert.match(y.slice(iBuild, iE2e), /ASN_E2E_REQUIRE_HOOKS: '1'/, `${f} e2e 要求 hooks 版`)
    assert.ok(!/--features[ =]test-hooks/.test(y), `${f} 不准在 workflow 直接帶 test-hooks（只能經 build-hooks-exe.mjs）`)
  }
})

test('Windows 發版與演練：LENIENT 與 hooks 版要求在同一步；演練走 release-ci.mjs（含證明）', () => {
  const y = wf('asn-release.yml')
  const i = y.indexOf("ASN_SHOT_TOAST_LENIENT: '1'")
  assert.ok(i > 0 && y.slice(i, i + 400).includes("ASN_E2E_REQUIRE_HOOKS: '1'"))
  assert.ok(!/--features[ =]test-hooks/.test(y))
  assert.match(wf('asn-release-rehearsal.yml'), /node scripts\/release-ci\.mjs/)
})

test('e2e 選哪份 exe：LENIENT 時主情境用 hooks 版，平常用正式版；CI 要求時不准略過', () => {
  assert.equal(e2eMainExe({}), defaultExe)
  assert.equal(e2eMainExe({ ASN_SHOT_TOAST_LENIENT: '1' }), hooksExe)
  assert.equal(hooksExeSkip({}, () => false) !== false, true, '本機沒有 hooks 版：略過')
  assert.equal(hooksExeSkip({ ASN_E2E_REQUIRE_HOOKS: '1' }, () => false), false, 'CI 要求時不略過（找不到會讓測試失敗）')
  assert.equal(hooksExeSkip({}, () => true), false)
})

test('需要 ASN_SHOT_LOGIN 的 e2e 都用 hooks 版 exe', () => {
  const t = read('test/login-e2e-bind.test.mjs')
  for (const tag of ['auto-bind', 'bind-fail', 'new-pc']) assert.match(t, new RegExp(`tmpOut\\('${tag}'\\), hooksExe`), tag)
  assert.match(t, /tmpOut\('key-skipped'\), defaultExe/, '不需要登入的情境繼續測正式版')
})

test('Rust 端：兩個 SHOT 變數走 test_var，例外清單是空的', () => {
  assert.match(read('src-tauri/src/lib.rs'), /flags::test_var\("ASN_SHOT_LOGIN"\)/)
  assert.match(read('src-tauri/src/wins.rs'), /flags::test_var\("ASN_SHOT_TOAST_LENIENT"\)/)
  assert.match(read('src-tauri/src/flags/test_var_guard.rs'), /pub const EXEMPT: &\[\(&str, &str\)\] = &\[\];/)
})
