// #1944 手機版發版 workflow（asn-release-android.yml）的守門：只吃 android-v 標籤、Play 的 3 個 job 依 3.2 表帶 environment: release 與指定 secrets、其餘 job 沒有。
// 風格比照 release-workflow-guard（字串與正則，不引入 yaml 套件）。通則：
//   1. 先正規化換行、再剝註解才比對；
//   2. flow-style 的 on／permissions／needs 一律判失敗；
//   3. 每條規則附「至少命中 N 次」計數；
//   4. 每條規則附「壞例子」，證明規則會紅（還原驗證）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { statusFromNeeds } from '../../../tools/release/notify_run.mjs'
import { JOBS, GUARD_STEPS } from '../../../tools/release/notify_status.mjs'

const root = new URL('../../../', import.meta.url)
const FILE = '.github/workflows/asn-release-android.yml'
const DESKTOP = '.github/workflows/asn-release.yml'
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8').replace(/\r\n/g, '\n')
const stripComments = src => src.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n')
const topBlock = (src, key) => {
  const lines = src.split('\n')
  const i = lines.findIndex(l => l.startsWith(`${key}:`))
  if (i < 0) return null
  const body = []
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue
    if (!/^\s/.test(lines[j])) break
    body.push(lines[j])
  }
  return body
}
const jobsOf = src => {
  const lines = src.split('\n')
  const i = lines.findIndex(l => l.startsWith('jobs:'))
  if (i < 0) return {}
  const out = {}
  let name = null
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() !== '' && !/^\s/.test(l)) break
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l)
    if (m) { name = m[1]; out[name] = []; continue }
    if (name) out[name].push(l)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]))
}
const needsOf = text => {
  const m = /^ {4}needs:[ \t]*(\S.*)?$/m.exec(text)
  if (!m) return []
  if (m[1]) return [m[1].trim()]
  const after = text.slice(m.index + m[0].length).split('\n').slice(1)
  const out = []
  for (const l of after) { const x = /^ {6}- (\S+)\s*$/.exec(l); if (x) out.push(x[1]); else if (l.trim() !== '') break }
  return out
}
const permsOf = text => {
  const m = /^ {4}permissions:\s*\n((?: {6}\S.*\n?)+)/m.exec(text)
  if (!m) return null
  return Object.fromEntries(m[1].split('\n').filter(Boolean).map(l => l.trim().split(/:\s*/)))
}
const envOf = text => /^ {4}environment:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null
const secretsOf = text => [...new Set([...text.matchAll(/secrets\.(?!GITHUB_TOKEN\b)([A-Za-z0-9_]+)/g)].map(m => m[1]))].sort()
const sorted = o => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}: ${v}`).join(', ')

// ---- 規格 3.2 的白名單表（Play 的 3 個 job）----
const ALL_JOBS = ['guard', 'preflight-play', 'android-build', 'android-upload', 'notify']
const TABLE = {
  guard: { env: null, secrets: [], perms: { contents: 'read', actions: 'read' } },
  'preflight-play': { env: 'release', secrets: ['ASN_PLAY_SA_JSON_B64'], perms: { contents: 'read' } },
  'android-build': { env: 'release', secrets: ['ASN_GOOGLE_SERVICES_JSON', 'ASN_PLAY_UPLOAD_JKS', 'ASN_PLAY_UPLOAD_PASSWORD'], perms: { contents: 'read' } },
  'android-upload': { env: 'release', secrets: ['ASN_PLAY_SA_JSON_B64'], perms: { contents: 'read' } },
  notify: { env: null, secrets: [], perms: { contents: 'read', issues: 'write' } },
}
const SECRET_JOBS = ALL_JOBS.filter(j => TABLE[j].secrets.length)
const TIMEOUT = { 'android-build': 60 }
const AUTO_IF = "if: needs.guard.outputs.auto == 'true'"
const AUTO_GATED = ['preflight-play', 'android-build', 'android-upload']
const FORBIDDEN_TRIGGERS = ['branches', 'pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule', 'workflow_run', 'workflow_call', 'repository_dispatch', 'release']

/** 檢查一份手機版發版 workflow；回違規訊息陣列，空陣列＝通過 */
export const checkAndroidRelease = raw => {
  const src = stripComments(raw)
  const bad = []
  for (const m of src.matchAll(/^\s*(on|permissions|needs):[ \t]*([\[{].*)$/gm)) bad.push(`flow-style 的 ${m[1]}:（解析器不支援，請改成區塊寫法）`)
  // 1. 只吃 android-v 標籤
  const on = topBlock(src, 'on')
  if (!on) bad.push('找不到區塊寫法的 on:')
  else {
    const keys = on.filter(l => /^ {2}\S/.test(l)).map(l => /^ {2}([A-Za-z_]+):/.exec(l)?.[1] ?? l.trim())
    if (keys.join() !== 'push') bad.push(`on: 只能有 push，現在是 [${keys.join(', ')}]`)
    const sub = on.filter(l => /^ {4}\S/.test(l)).map(l => l.trim())
    if (sub.join() !== 'tags:') bad.push(`on.push 底下只能有 tags:，現在是 [${sub.join(', ')}]`)
    const tags = on.filter(l => /^ {6}- /.test(l)).map(l => l.trim().slice(2))
    if (tags.join() !== "'android-v*.*.*'") bad.push(`標籤規則只能是 'android-v*.*.*'，現在是 [${tags.join(', ')}]`)
    for (const k of FORBIDDEN_TRIGGERS) if (new RegExp(`(^|\\W)${k}\\s*:`).test(on.join('\n'))) bad.push(`on: 不准有 ${k}`)
  }
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG', 'pull_request_target', 'workflow_dispatch']) if (src.includes(s)) bad.push(`不准出現 ${s}`)
  if (/\bset\s+-[A-Za-z]*x/.test(src) || /\bbash\s+-[A-Za-z]*x/.test(src)) bad.push('不准 set -x')
  if (/secrets\s*:\s*inherit/.test(src)) bad.push('不准 secrets: inherit')
  if (/write-all/.test(src)) bad.push('不准 write-all')
  for (const m of src.matchAll(/^\s*contents:\s*write\b/gm)) bad.push(`不准 ${m[0].trim()}`)
  const perms = topBlock(src, 'permissions')
  if (!perms) bad.push('頂層缺 permissions: 區塊')
  else if (perms.map(l => l.trim()).join('|') !== 'contents: read') bad.push(`頂層 permissions 只能是 contents: read，現在是 ${perms.map(l => l.trim()).join(' / ')}`)
  const conc = (topBlock(src, 'concurrency') ?? []).map(l => l.trim()).join('|')
  if (conc !== 'group: asn-release-android-${{ github.ref_name }}|cancel-in-progress: false') bad.push(`concurrency 不對：${conc}`)

  const jobs = jobsOf(src)
  if (Object.keys(jobs).sort().join() !== [...ALL_JOBS].sort().join()) bad.push(`job 清單不對：[${Object.keys(jobs).join(', ')}]`)
  // secrets 只能經 env: 傳入（形如 KEY: ${{ secrets.X }}）
  for (const l of src.split('\n')) {
    if (/secrets\.(?!GITHUB_TOKEN\b)/.test(l) && !/^\s+[A-Z][A-Z0-9_]*:\s*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}\s*$/.test(l)) bad.push(`secrets 只能放在 env: 的 KEY: \${{ secrets.X }}：${l.trim()}`)
  }
  for (const name of ALL_JOBS) {
    const t = jobs[name]
    if (t === undefined) continue
    const want = TABLE[name]
    const p = permsOf(t)
    if (!p) bad.push(`job ${name} 缺 permissions:（job 層要明寫）`)
    else if (sorted(p) !== sorted(want.perms)) bad.push(`job ${name} 的 permissions 要是 {${sorted(want.perms)}}，現在是 {${sorted(p)}}`)
    const secrets = secretsOf(t)
    if (secrets.join() !== [...want.secrets].sort().join()) bad.push(`job ${name} 的 secrets 要是 [${want.secrets.join(', ')}]，現在是 [${secrets.join(', ')}]`)
    const env = envOf(t)
    if (env !== want.env) bad.push(`job ${name} 的 environment 要是 ${want.env ?? '（無）'}，現在是 ${env ?? '（無）'}`)
    const tm = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(t)
    if (!tm) bad.push(`job ${name} 缺 timeout-minutes`)
    else if (Number(tm[1]) !== (TIMEOUT[name] ?? 20)) bad.push(`job ${name} 的 timeout-minutes 是 ${tm[1]}，不是規格的值`)
  }
  for (const [k, only] of [['id-token', null], ['attestations', null], ['issues', 'notify'], ['actions', 'guard']]) {
    for (const [name, t] of Object.entries(jobs)) if (name !== only && new RegExp(`^\\s+${k}:`, 'm').test(t)) bad.push(`${k} 只能在 ${only ?? '（沒有 job）'}，但 ${name} 有`)
  }
  // action 釘 SHA
  for (const m of src.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    const ref = m[1]
    if (ref.startsWith('./')) { if (!ref.startsWith('./.github/actions/')) bad.push(`本地 action 只能放 .github/actions/：${ref}`); continue }
    if (!/^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/.test(ref)) bad.push(`action 沒鎖到 40 位 commit：${ref}`)
  }
  // notify 與順序
  const nt = jobs.notify
  if (nt !== undefined) {
    if (!/^ {4}if:\s*always\(\)\s*$/m.test(nt)) bad.push('notify 要有 if: always()')
    const got = needsOf(nt)
    for (const j of ALL_JOBS.filter(x => x !== 'notify')) if (!got.includes(j)) bad.push(`notify 的 needs 缺 ${j}`)
  }
  if (jobs['android-build'] !== undefined) {
    const n = needsOf(jobs['android-build'])
    for (const j of ['guard', 'preflight-play']) if (!n.includes(j)) bad.push(`android-build 的 needs 缺 ${j}`)
    if (/--upload|play-upload|ASN_PLAY_SA_FILE/.test(jobs['android-build'])) bad.push('android-build 不准 --upload／play-upload／服務帳戶')
  }
  if (jobs['android-upload'] !== undefined && !needsOf(jobs['android-upload']).includes('android-build')) bad.push('android-upload 要在 android-build 之後')
  for (const [name, t] of Object.entries(jobs)) if (!['preflight-play', 'android-upload'].includes(name) && /play-upload/.test(t)) bad.push(`play-upload 只能在 preflight-play 與 android-upload，但 ${name} 有`)
  if (jobs['preflight-play'] !== undefined && !/play-upload\.mjs --check-only /.test(jobs['preflight-play'])) bad.push('preflight-play 要只跑 play-upload 的 --check-only')
  // 碰 secrets 的 job：第一步 RUNNER_DEBUG 檢查、if: always() 的 rm -f 清理
  for (const j of SECRET_JOBS) {
    const t = jobs[j]
    if (t === undefined) continue
    const iDebug = t.indexOf('RUNNER_DEBUG')
    const iUses = t.indexOf('uses:')
    if (iDebug < 0 || (iUses >= 0 && iDebug > iUses)) bad.push(`job ${j} 的第一步要檢查 RUNNER_DEBUG`)
    if (!/if:\s*always\(\)\s*\n\s*run:\s*(\|\s*\n\s*)?rm -f /.test(t)) bad.push(`job ${j} 要有 if: always() 的 rm -f 清理步驟`)
  }
  // 開關接線
  const g = jobs.guard ?? ''
  if (!/ASN_RELEASE_AUTO:\s*\$\{\{\s*vars\.ASN_RELEASE_AUTO\s*\}\}/.test(g)) bad.push('guard 要從 vars.ASN_RELEASE_AUTO 讀開關')
  if (!g.includes('[ "${ASN_RELEASE_AUTO:-}" = "true" ]')) bad.push('開關判斷要是「恰為 true」（未設定用 :- 當空字串）')
  if (!/^ {6}auto:\s*\$\{\{\s*steps\.auto\.outputs\.auto\s*\}\}\s*$/m.test(g)) bad.push('guard 要輸出 auto')
  if (!/^ {6}version_code:\s*\$\{\{\s*steps\.code\.outputs\.version_code\s*\}\}\s*$/m.test(g)) bad.push('guard 要輸出 version_code')
  for (const j of AUTO_GATED) if (jobs[j] !== undefined && !new RegExp(`^ {4}${AUTO_IF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(jobs[j])) bad.push(`job ${j} 要有 ${AUTO_IF}`)
  // 每個多行 run: 區塊第一行是 set -euo pipefail
  for (const m of src.matchAll(/^\s*run:\s*\|\s*\n\s*(.*)$/gm)) if (m[1].trim() !== 'set -euo pipefail') bad.push(`多行 run: 要以 set -euo pipefail 開頭：${m[1].trim().slice(0, 40)}`)
  for (const l of src.split('\n')) { if (/\t/.test(l)) bad.push('有 tab'); else if (l.trim() && (l.length - l.trimStart().length) % 2) bad.push(`縮排不是 2 的倍數：${l.trim().slice(0, 40)}`) }
  return bad
}

const wf = read(FILE)
const flagged = (src, re) => checkAndroidRelease(src).some(m => re.test(m))
const mutate = (from, to) => {
  assert.ok(wf.includes(from), `壞例子的替換目標不存在：${from}`)
  return wf.replace(from, to)
}

test('手機版 workflow 存在、掃得到全部 job，且通過全部守門', () => {
  assert.ok(wf.length > 3000, 'workflow 不見了或是空的')
  assert.deepEqual(Object.keys(jobsOf(stripComments(wf))), ALL_JOBS)
  assert.deepEqual(checkAndroidRelease(wf), [])
})

test('1 只吃 android-v 標籤：on 只有 push＋tags 一條規則；標籤規則不是 v*.*.*（不會連電腦版標籤一起吃）；沒有 workflow_dispatch／pull_request', () => {
  const on = topBlock(stripComments(wf), 'on')
  assert.ok(on && on.length >= 3, 'on: 區塊讀不到，規則可能失效')
  assert.equal([...on.join('\n').matchAll(/^ {6}- '/gm)].length, 1)
  assert.ok(on.some(l => l.trim() === "- 'android-v*.*.*'"))
  assert.ok(!on.some(l => /'v\*/.test(l)))
  for (const k of FORBIDDEN_TRIGGERS) assert.doesNotMatch(on.join('\n'), new RegExp(`(^|\\W)${k}\\s*:`), k)
  // 電腦版那份不吃 android- 標籤：它的規則是 'v*.*.*'，GitHub 的標籤樣式從頭比對，android-v0.2.38 不符
  const d = topBlock(stripComments(read(DESKTOP)), 'on').join('\n')
  assert.match(d, /- 'v\*\.\*\.\*'/); assert.doesNotMatch(d, /android/)
})

test('2 secrets：只在 3.2 表指定的 3 個 job、都有 environment: release、其餘 job 沒有、只經 env:（至少命中 5 次）', () => {
  const src = stripComments(wf)
  const hits = [...src.matchAll(/secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/g)]
  assert.ok(hits.length >= 5, `secrets 只找到 ${hits.length} 處，規則可能失效`)
  assert.equal([...src.matchAll(/^ {4}environment:\s*release\s*$/gm)].length, 3)
  assert.doesNotMatch(src, /secrets\s*:\s*inherit/)
  const jobs = jobsOf(src)
  assert.deepEqual(SECRET_JOBS, ['preflight-play', 'android-build', 'android-upload'])
  for (const j of ALL_JOBS) {
    assert.deepEqual(secretsOf(jobs[j]), [...TABLE[j].secrets].sort(), j)
    assert.equal(envOf(jobs[j]), TABLE[j].env, j)
  }
})

test('2 secrets：電腦版 workflow、演練檔與 .github/actions/ 沒有任何 secrets.（GITHUB_TOKEN 例外）也沒有 environment:', () => {
  const dir = new URL('.github/workflows/', root)
  const others = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`).filter(f => f !== FILE)
  assert.ok(others.length >= 3, `其他 workflow 只找到 ${others.length} 個，規則可能失效`)
  assert.ok(others.includes(DESKTOP))
  for (const f of others) {
    const s = stripComments(read(f))
    // 只准下面兩個檔用 secret（細節各由專屬守門守）：site-deploy.yml（#1947 ④）只准官網部署金鑰；電腦版（#2022 ②-1）只准 desktop-sign 用更新簽章的兩個 secret、掛 environment: release
    const allowed = f === '.github/workflows/site-deploy.yml' ? ['secrets.FIREBASE_SERVICE_ACCOUNT_ASNMESSENGER'] : f === DESKTOP ? ['secrets.TAURI_SIGNING_PRIVATE_KEY', 'secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] : []
    assert.deepEqual([...s.matchAll(/secrets\.(?!GITHUB_TOKEN\b)\w+/g)].map(m => m[0]), allowed, f)
    if (f === DESKTOP) assert.deepEqual([...s.matchAll(/^\s*environment\s*:\s*(\S+)/gm)].map(m => m[1]), ['release'], f)
    if (f.includes('rehearsal')) assert.doesNotMatch(s, /^\s*environment\s*:/m, f)
  }
  const actions = fs.readdirSync(new URL('.github/actions/', root), { recursive: true }).map(String).filter(f => /\.ya?ml$/.test(f))
  assert.ok(actions.length >= 1)
  for (const f of actions) assert.doesNotMatch(stripComments(read(`.github/actions/${f.replaceAll('\\', '/')}`)), /secrets\.(?!GITHUB_TOKEN\b)|environment:/, f)
})

test('3 權限：逐 job 比對 3.2 表；頂層只有 contents: read；全檔無 contents: write；id-token／attestations 沒有；issues 只在 notify；actions 只在 guard', () => {
  const src = stripComments(wf)
  assert.equal([...src.matchAll(/^ {4}permissions:\s*$/gm)].length, 5)
  const jobs = jobsOf(src)
  for (const j of ALL_JOBS) assert.equal(sorted(permsOf(jobs[j])), sorted(TABLE[j].perms), j)
  assert.equal(topBlock(src, 'permissions').map(l => l.trim()).join('|'), 'contents: read')
  assert.doesNotMatch(src, /contents:\s*write|write-all|id-token|attestations/)
  for (const [k, only] of [['issues', 'notify'], ['actions', 'guard']]) {
    const have = Object.entries(jobs).filter(([, t]) => new RegExp(`^ {6}${k}:`, 'm').test(t)).map(([n]) => n)
    assert.deepEqual(have, [only], k)
  }
})

test('3 timeout：android-build 60 分鐘，其餘 4 個 job 各 20 分鐘', () => {
  const jobs = jobsOf(stripComments(wf))
  for (const j of ALL_JOBS) assert.equal(Number(/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(jobs[j])?.[1]), TIMEOUT[j] ?? 20, j)
})

test('4 action 釘 SHA：uses: 至少 10 個、全是 40 位 commit 或 ./.github/actions/', () => {
  const uses = [...stripComments(wf).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(m => m[1])
  assert.ok(uses.length >= 10, `uses: 只找到 ${uses.length} 個，規則可能失效`)
  for (const u of uses) assert.ok(u.startsWith('./.github/actions/') || /@[0-9a-f]{40}$/.test(u), u)
})

test('5 順序與 notify：always()、needs 含其他全部 job；android-build 在 guard 與 preflight-play 之後；android-upload 在 android-build 之後；沒有電腦版／官網的 job', () => {
  const jobs = jobsOf(stripComments(wf))
  assert.deepEqual(needsOf(jobs.notify), ALL_JOBS.filter(j => j !== 'notify'))
  assert.match(jobs.notify, /^ {4}if:\s*always\(\)\s*$/m)
  assert.equal(envOf(jobs.notify), null)
  assert.deepEqual(needsOf(jobs['android-build']), ['guard', 'preflight-play'])
  assert.ok(needsOf(jobs['android-upload']).includes('android-build'))
  assert.ok(needsOf(jobs['preflight-play']).includes('guard'))
  for (const j of ['desktop', 'attest', 'site-draft']) assert.equal(jobs[j], undefined, `${j} 是電腦版的 job`)
  assert.deepEqual(ALL_JOBS.filter(j => j !== 'guard' && j !== 'notify').filter(j => !JOBS.includes(j)), [], 'notify_status 的 job 清單與 workflow 不一致')
})

test('6 碰 secrets 的 3 個 job：第一步 RUNNER_DEBUG 檢查、if: always() 的 rm -f 清理；不准略過冒煙；多行 run 以 set -euo pipefail 開頭（至少 15 次）', () => {
  const src = stripComments(wf)
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG']) assert.ok(!src.includes(s), s)
  const jobs = jobsOf(src)
  assert.equal(SECRET_JOBS.length, 3)
  for (const j of SECRET_JOBS) {
    assert.ok(jobs[j].indexOf('RUNNER_DEBUG') > 0 && jobs[j].indexOf('RUNNER_DEBUG') < jobs[j].indexOf('uses:'), j)
    assert.match(jobs[j], /if:\s*always\(\)\s*\n\s*run:\s*(\|\s*\n\s*)?rm -f /, j)
  }
  assert.ok([...src.matchAll(/set -euo pipefail/g)].length >= 15, 'set -euo pipefail 命中數太少')
})

test('各 job 的接線：android-build 不帶 --upload、開硬擋、NDK 固定版與 ring 編譯器環境；android-upload 不 npm ci；preflight-play 只做 --check-only', () => {
  const jobs = jobsOf(stripComments(wf))
  const b = jobs['android-build']
  assert.match(b, /ASN_REQUIRE_UPLOAD_KEY:\s*'1'/)
  assert.match(b, /node scripts\/release-play\.mjs\s*$/m)
  assert.doesNotMatch(b, /--upload|play-upload|ASN_PLAY_SA_FILE|--skip-smoke/)
  assert.match(b, /ASN_NDK_VERSION:\s*\d+\.\d+\.\d+/)
  for (const k of ['NDK_HOME=', 'CC_aarch64_linux_android=', 'AR_aarch64_linux_android=', 'CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=', 'test -x']) assert.ok(b.includes(k), `缺 ${k}`)
  assert.ok(b.includes('GITHUB_SHA'), '要確認 HEAD 等於標籤 commit')
  assert.ok(b.indexOf('缺上傳金鑰就失敗') > 0 && b.indexOf('缺 google-services.json 就失敗') > 0, '兩個缺檔要各一步')
  assert.match(b, /name:\s*asn-aab/)
  const u = jobs['android-upload']
  assert.doesNotMatch(u, /npm ci|gradle|asn-node-setup|ASN_PLAY_UPLOAD|ASN_GOOGLE/)
  assert.match(u, /play-upload\.mjs "--aab=/)
  assert.match(jobs['preflight-play'], /play-upload\.mjs --check-only /)
  assert.doesNotMatch(jobs['preflight-play'], /npm ci|asn-node-setup|--aab/)
})

test('guard：標籤檢查帶 --prefix android-v；算 version_code；查的是 android workflow 的 run；沒有 CHANGELOG 官網預檢與 Release 狀態檢查（那是電腦版的事）', () => {
  const g = jobsOf(stripComments(wf)).guard
  assert.match(g, /node tools\/release\/tag_check\.mjs "\$TAG" --prefix android-v/)
  assert.match(g, /playVersionCode/); assert.ok(g.includes('scripts/play-version.mjs'))
  assert.ok(g.includes('workflows/asn-release-android.yml/runs'))
  assert.doesNotMatch(g, /workflows\/asn-release\.yml|site_record_check|releaseState|github_release/)
})

test('guard 的「記錄卡在哪一步」輸出的每個名字都在通知的固定白名單裡（不然 notify 會悄悄丟掉步驟名）', () => {
  const names = [...wf.matchAll(/name="([^"]+)"/g)].map(m => m[1])
  assert.ok(names.length >= 4, `只找到 ${names.length} 個步驟名`)
  for (const n of names) assert.ok(GUARD_STEPS.includes(n), `workflow 輸出「${n}」，但 GUARD_STEPS 沒有它`)
  assert.ok(![...wf.replace('name="Play 版號計算"', 'name="版號"').matchAll(/name="([^"]+)"/g)].every(m => GUARD_STEPS.includes(m[1])))
})

test('notify_run：只有 Play 系列 job 的 needs → 文字只講 Play（成功講 Play 內部測試已就緒、不提安裝檔；失敗點名 Play 步驟）', () => {
  const PLAY = ['preflight-play', 'android-build', 'android-upload']
  const RUN = 'https://github.com/Yooliang/asn/actions/runs/9'
  const needs = over => ({ guard: { result: 'success', outputs: { auto: 'true', version: '0.2.38' } }, ...Object.fromEntries(PLAY.map(j => [j, { result: 'success' }])), ...over })
  const done = statusFromNeeds(needs(), { runUrl: RUN })
  assert.match(done.text, /【CI 完成】v0\.2\.38/); assert.match(done.text, /Play 內部測試已就緒/); assert.doesNotMatch(done.text, /安裝檔|要簽|異常/)
  const up = statusFromNeeds(needs({ 'android-upload': { result: 'failure' } }), { runUrl: RUN })
  assert.match(up.text, /Play 上傳失敗/); assert.doesNotMatch(up.text, /電腦版|異常/)
  const pre = statusFromNeeds(needs({ 'preflight-play': { result: 'failure' }, 'android-build': { result: 'skipped' }, 'android-upload': { result: 'skipped' } }))
  assert.match(pre.text, /版號預檢/); assert.doesNotMatch(pre.text, /異常|不明/)
  const gf = statusFromNeeds({ guard: { result: 'failure', outputs: { auto: 'false', version: '' } } }, { runUrl: RUN, guardStep: 'Play 版號計算' })
  assert.match(gf.text, /卡在：Play 版號計算/)
  assert.match(statusFromNeeds({ guard: { result: 'success', outputs: { auto: 'false', version: '0.2.38' } } }).text, /【發版略過】/)
})

test('auto 開關接線：實跑那一行（未設定、空字串、false、TRUE 皆 false）；下游 3 個 job 都看 auto', () => {
  const jobs = jobsOf(stripComments(wf))
  assert.equal(AUTO_GATED.filter(j => jobs[j].includes(AUTO_IF)).length, 3)
})

// ---- 壞例子：每條規則都要真的會紅 ----
test('壞例子 1：加 workflow_dispatch／pull_request／branches、標籤改成 v*.*.*、多一條標籤規則會紅', () => {
  assert.ok(flagged(mutate('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:'), /workflow_dispatch/))
  assert.ok(flagged(mutate('on:\n  push:', 'on:\n  pull_request:\n  push:'), /on: 只能有 push|不准有 pull_request/))
  assert.ok(flagged(mutate("    tags:\n      - 'android-v*.*.*'", "    branches:\n      - main\n    tags:\n      - 'android-v*.*.*'"), /on\.push 底下只能有 tags|branches/))
  assert.ok(flagged(mutate("      - 'android-v*.*.*'", "      - 'v*.*.*'"), /標籤規則只能是/))
  assert.ok(flagged(mutate("      - 'android-v*.*.*'", "      - 'android-v*.*.*'\n      - 'v*.*.*'"), /標籤規則只能是/))
})

test('壞例子：flow-style 的 on／permissions／needs 一律紅', () => {
  assert.ok(flagged('on: [push]\npermissions:\n  contents: read\n', /flow-style 的 on/))
  assert.ok(flagged(mutate('permissions:\n  contents: read\n\n# 每個標籤', 'permissions: {contents: read}\n\n# 每個標籤'), /flow-style 的 permissions/))
  assert.ok(flagged(mutate('  preflight-play:\n    needs: guard', '  preflight-play:\n    needs: [guard]'), /flow-style 的 needs/))
})

test('壞例子 2：guard 加 secrets、白名單 job 拿到別的 secret／少一個、secrets 放進 run、secrets: inherit、environment 搬走或亂加都會紅；註解與 GITHUB_TOKEN 不算', () => {
  const tagStep = '          TAG: ${{ github.ref_name }}\n        run: |\n          set -euo pipefail\n          node tools/release/tag_check.mjs'
  assert.ok(flagged(mutate(tagStep, tagStep.replace('        run: |', '          X: ${{ secrets.ASN_X }}\n        run: |')), /job guard 的 secrets/))
  assert.ok(flagged(mutate('SA_B64: ${{ secrets.ASN_PLAY_SA_JSON_B64 }}', 'SA_B64: ${{ secrets.ASN_PLAY_UPLOAD_PASSWORD }}'), /secrets 要是/))
  assert.ok(flagged(mutate('          UPLOAD_PASSWORD: ${{ secrets.ASN_PLAY_UPLOAD_PASSWORD }}\n', ''), /job android-build 的 secrets/))
  assert.ok(flagged(mutate('          set -euo pipefail\n          node scripts/release-play.mjs', '          set -euo pipefail\n          echo ${{ secrets.ASN_PLAY_UPLOAD_PASSWORD }}\n          node scripts/release-play.mjs'), /secrets 只能放在 env/))
  assert.ok(flagged(mutate('  notify:\n    needs:', '  notify:\n    environment: release\n    needs:'), /job notify 的 environment/))
  assert.ok(flagged(mutate('    environment: release\n    timeout-minutes: 60\n', '    timeout-minutes: 60\n'), /job android-build 的 environment 要是 release/))
  assert.ok(flagged(`${wf}\n    secrets: inherit\n`, /secrets: inherit/))
  assert.ok(!flagged(`${wf}\n# secrets.ASN_X environment: release 只是註解\n`, /secrets|environment/), '註解裡的不算')
  assert.ok(!checkAndroidRelease(mutate('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')).some(m => /secrets/.test(m)), 'GITHUB_TOKEN 例外')
})

test('壞例子 3：加 contents: write、id-token、issues 放到別處、少寫權限、timeout 拿掉或改錯都會紅', () => {
  assert.ok(flagged(mutate('permissions:\n  contents: read\n\n# 每個標籤', 'permissions:\n  contents: write\n\n# 每個標籤'), /contents: write|頂層 permissions/))
  assert.ok(flagged(mutate('    timeout-minutes: 60\n    permissions:\n      contents: read', '    timeout-minutes: 60\n    permissions:\n      contents: write'), /contents: write|job android-build 的 permissions/))
  assert.ok(flagged(mutate('    timeout-minutes: 60\n    permissions:\n      contents: read', '    timeout-minutes: 60\n    permissions:\n      contents: read\n      id-token: write'), /id-token/))
  assert.ok(flagged(mutate('      contents: read\n      issues: write', '      issues: write'), /job notify 的 permissions/))
  assert.ok(flagged(mutate('    timeout-minutes: 60\n', ''), /android-build 缺 timeout-minutes/))
  assert.ok(flagged(mutate('    timeout-minutes: 60\n', '    timeout-minutes: 20\n'), /android-build 的 timeout-minutes/))
  assert.ok(flagged(mutate('    environment: release\n    timeout-minutes: 20\n    permissions:\n      contents: read\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - name: 不准開除錯記錄', '    environment: release\n    timeout-minutes: 90\n    permissions:\n      contents: read\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - name: 不准開除錯記錄'), /timeout-minutes/))
})

test('壞例子 4：action 改 @v4、換成短 SHA、本地路徑不在 .github/actions/ 都會紅', () => {
  assert.ok(flagged(mutate('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2', 'actions/upload-artifact@v4'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('actions/setup-java@c5195efecf7bdfc987ee8bae7a71cb8b11521c00', 'actions/setup-java@c5195ef'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('uses: ./.github/actions/asn-node-setup', 'uses: ./scripts/evil'), /本地 action 只能放/))
})

test('壞例子 5：notify 拿掉 if: always()／少 needs；android-build 缺 preflight-play；android-upload 不在 android-build 之後；play-upload 出現在別的 job 會紅', () => {
  assert.ok(flagged(mutate('    if: always()\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: read\n      issues: write', '    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: read\n      issues: write'), /notify 要有 if: always/))
  assert.ok(flagged(mutate('      - android-build\n      - android-upload\n    if: always()', '      - android-build\n    if: always()'), /notify 的 needs 缺 android-upload/))
  assert.ok(flagged(mutate('    needs:\n      - guard\n      - preflight-play\n    if:', '    needs:\n      - guard\n    if:'), /android-build 的 needs 缺 preflight-play/))
  assert.ok(flagged(mutate('      - guard\n      - android-build\n    if:', '      - guard\n    if:'), /android-upload 要在 android-build 之後/))
  assert.ok(flagged(mutate('node scripts/release-play.mjs\n', 'node scripts/release-play.mjs --upload\n'), /android-build 不准/))
  assert.ok(flagged(mutate('node scripts/play-upload.mjs --check-only', 'node scripts/play-upload.mjs'), /preflight-play 要只跑/))
  assert.ok(flagged(mutate('          node tools/release/notify_run.mjs', '          node scripts/play-upload.mjs\n          node tools/release/notify_run.mjs'), /play-upload 只能在/))
})

test('壞例子 6：--skip-smoke／ACTIONS_STEP_DEBUG／set -x 會紅；拿掉 RUNNER_DEBUG 檢查或 if: always() 的 rm -f 會紅；多行 run 沒有 set -euo pipefail 會紅；註解裡提到不算', () => {
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG']) {
    assert.ok(flagged(mutate('          node scripts/release-play.mjs', `          node scripts/release-play.mjs ${s}`), new RegExp(s)), s)
    assert.ok(!flagged(`${wf}\n# ${s}\n`, new RegExp(s)), `${s} 在註解裡不該算`)
  }
  assert.ok(flagged(mutate('          node scripts/release-play.mjs', '          set -x\n          node scripts/release-play.mjs'), /set -x/))
  assert.ok(flagged(mutate('        run: rm -f "$RUNNER_TEMP/play-sa.json"\n\n  # ---- 2.', '        run: echo done\n\n  # ---- 2.'), /job preflight-play 要有 if: always/))
  assert.ok(flagged(mutate('        run: rm -f "$RUNNER_TEMP/play-key/upload.jks"', '        run: echo "$RUNNER_TEMP/play-key/upload.jks"'), /job android-build 要有 if: always/))
  assert.ok(flagged(wf.replaceAll('RUNNER_DEBUG', 'XRUNNER'), /RUNNER_DEBUG/))
  assert.ok(flagged(mutate('          set -euo pipefail\n          node scripts/release-play.mjs', '          node scripts/release-play.mjs'), /set -euo pipefail 開頭/))
})

test('壞例子：auto 開關接線拿掉、改成 != false、下游 job 沒看 auto、version_code 輸出拿掉、縮排有 tab 或奇數空白會紅', () => {
  assert.ok(flagged(mutate('[ "${ASN_RELEASE_AUTO:-}" = "true" ]', '[ "${ASN_RELEASE_AUTO:-}" != "false" ]'), /恰為 true/))
  assert.ok(flagged(mutate('ASN_RELEASE_AUTO: ${{ vars.ASN_RELEASE_AUTO }}', 'ASN_RELEASE_AUTO: ${{ inputs.auto }}'), /vars\.ASN_RELEASE_AUTO/))
  assert.ok(flagged(mutate("    needs: guard\n    if: needs.guard.outputs.auto == 'true'\n    runs-on: ubuntu-24.04\n    environment: release", '    needs: guard\n    runs-on: ubuntu-24.04\n    environment: release'), /job preflight-play 要有 if/))
  assert.ok(flagged(mutate('      version_code: ${{ steps.code.outputs.version_code }}\n', ''), /guard 要輸出 version_code/))
  assert.ok(flagged(mutate('    timeout-minutes: 60\n', '\ttimeout-minutes: 60\n'), /有 tab/))
  assert.ok(flagged(mutate('    timeout-minutes: 60\n', '   timeout-minutes: 60\n'), /縮排不是 2 的倍數/))
})

// ---- #1946 一審：Play 上傳收不回來，上傳前一定要核對 AAB 的 sha256 等於建置 job 的輸出 ----
const uploadHashProblems = src => {
  const jobs = jobsOf(stripComments(src))
  const problems = []
  const b = jobs['android-build'] ?? ''
  const u = jobs['android-upload'] ?? ''
  if (!/outputs:\s*\n\s*aab_sha256:\s*\$\{\{\s*steps\.aab\.outputs\.sha256\s*\}\}/.test(b)) problems.push('android-build 沒有輸出 aab_sha256')
  const check = u.indexOf('核對 AAB 的 SHA256')
  const upload = u.indexOf('play-upload.mjs "--aab=')
  if (check < 0) problems.push('android-upload 沒有「核對 AAB 的 SHA256」那一步')
  if (!/WANT:\s*\$\{\{\s*needs\.android-build\.outputs\.aab_sha256\s*\}\}/.test(u)) problems.push('期望的雜湊不是來自 android-build 的輸出')
  if (!/test -n "\$WANT" && test "\$got" = "\$WANT"/.test(u)) problems.push('沒有比對「實際雜湊 = 建置輸出」（或沒擋空值）')
  if (!/sha256sum -c SHA256SUMS\.txt/.test(u)) problems.push('沒有核對 SHA256SUMS.txt')
  if (check >= 0 && upload >= 0 && check > upload) problems.push('核對雜湊排在上傳之後')
  return problems
}

test('#1946 android-upload：上傳前核對 AAB 的 sha256 等於建置 job 的輸出（空值也擋）；核對排在上傳之前（至少 6 條規則命中）', () => {
  assert.deepEqual(uploadHashProblems(wf), [])
})

test('#1946 壞例子：拿掉比對那行、期望值改成別處、不擋空值、核對排到上傳之後、建置沒輸出雜湊、拿掉整個核對步驟都會紅', () => {
  const bad = (from, to, re) => assert.ok(uploadHashProblems(mutate(from, to)).some(m => re.test(m)), `${from.slice(0, 40)} → ${re}`)
  bad('          test -n "$WANT" && test "$got" = "$WANT" || { echo "AAB 的 SHA256 與建置 job 的輸出不一致" >&2; exit 1; }\n', '', /沒有比對/)
  bad('WANT: ${{ needs.android-build.outputs.aab_sha256 }}', 'WANT: ${{ needs.guard.outputs.version }}', /不是來自 android-build/)
  bad('test -n "$WANT" && test "$got" = "$WANT"', 'test "$got" = "$WANT"', /沒有比對/)
  bad('      aab_sha256: ${{ steps.aab.outputs.sha256 }}\n', '', /沒有輸出 aab_sha256/)
  bad('          sha256sum -c SHA256SUMS.txt\n', '          true\n', /SHA256SUMS/)
  bad('      - name: 核對 AAB 的 SHA256', '      - name: 略過的步驟', /沒有「核對 AAB 的 SHA256」/)
})

// ---- 正式 run 44753597348：android-build 少了「檢查中文字型」，冒煙 3 個情境每個都等滿 6 秒才判失敗 ----
const fontProblems = src => {
  const b = jobsOf(stripComments(src))['android-build'] ?? ''
  const problems = []
  const font = b.indexOf('name: 檢查中文字型')
  const java = b.indexOf('actions/setup-java@')
  const smoke = b.indexOf('node scripts/release-play.mjs')
  if (font < 0) problems.push('android-build 沒有「檢查中文字型」那一步')
  if (!/\$\(fc-list :lang=zh\)/.test(b)) problems.push('沒有用 fc-list :lang=zh 檢查中文字型')
  if (!/apt-install\.sh"? --no-install-recommends fonts-noto-cjk/.test(b)) problems.push('沒有用共用的 apt-install.sh 補裝 fonts-noto-cjk')
  if (!/裝完仍然沒有中文字型[\s\S]{0,40}exit 1/.test(b)) problems.push('裝完仍沒有中文字型時沒有直接失敗')
  if (font >= 0 && smoke >= 0 && font > smoke) problems.push('檢查中文字型排在建置（冒煙）之後')
  if (font >= 0 && java >= 0 && font < java) problems.push('檢查中文字型排在 setup-java 之前')
  return problems
}

test('android-build 一定有中文字型檢查：在 setup-java 之後、建置（含冒煙）之前；補裝 fonts-noto-cjk、裝不起來就失敗（至少 6 條規則）', () => {
  assert.deepEqual(fontProblems(wf), [])
})

test('壞例子：拿掉字型檢查整步、不用 fc-list、不補裝、裝不起來不失敗、排到建置之後、排在 setup-java 之前都會紅', () => {
  const step = wf.slice(wf.indexOf('      # 冒煙測試的長名字省略號'), wf.indexOf('      - uses: ./.github/actions/asn-node-setup'))
  assert.ok(step.includes('name: 檢查中文字型'), '找不到字型檢查那一段')
  const flag = (src, re) => assert.ok(fontProblems(src).some(m => re.test(m)), String(re))
  flag(wf.replace(step, ''), /沒有「檢查中文字型」/)
  flag(wf.replaceAll('$(fc-list :lang=zh)', '$(fc-list)'), /fc-list :lang=zh/)
  flag(wf.replaceAll('/apt-install.sh" --no-install-recommends fonts-noto-cjk', '/true"'), /apt-install/)
  flag(wf.replace('裝完仍然沒有中文字型" >&2; exit 1;', '裝完仍然沒有中文字型" >&2;'), /沒有直接失敗/)
  flag(wf.replace(step, '').replace('      - name: 算 AAB 的 SHA256', `${step}      - name: 算 AAB 的 SHA256`), /建置（冒煙）之後/)
  flag(wf.replace(step, '').replace('      - uses: actions/setup-java@', `${step}      - uses: actions/setup-java@`), /setup-java 之前/)
})


// #1892 守門缺口：run: 區塊不得內插 ${{ }}（外部字串一律經 env:）；不准 || true、set +e、continue-on-error。
// 唯一例外（整行精確相等才放行，附理由與至少命中次數）：
const RUN_ALLOW = [
  { line: `ids=$(printf '%s\\n' "$all" | grep -vx "$RUN_ID" | grep -v '^$' || true)`, min: 1, why: '取「其他發版 run 編號」：grep 沒找到（＝沒有別的 run）回 1 是正常，不該讓 guard 紅' },
]
const runBodies = raw => {
  // 不剝註解：Actions 連 shell 註解裡的 ${{ }} 也會展開，「空白＋#」之後的東西正是要守的地方（整行 YAML 註解不會落在 run 區塊的縮排內，不受影響）
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(- )?run:[ \t]*(.*)$/.exec(lines[i])
    if (!m) continue
    // 區塊純量標頭：| 或 >，可帶縮排指示符（1～9）與保留記號，後面可接 YAML 註解（|2、|-、>+ 都算）
    if (!/^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/.test(m[3].trim())) { out.push([m[3]]); continue }
    const keyCol = m[1].length + (m[2] ? 2 : 0)
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') { body.push(''); continue }
      if (lines[j].search(/\S/) <= keyCol) break
      body.push(lines[j])
    }
    out.push(body)
  }
  return out
}
/** 回違規訊息陣列，空陣列＝通過 */
const runProblems = raw => {
  const bad = []
  const bodies = runBodies(raw)
  if (bodies.length < 20) bad.push(`run 區塊命中數太少：${bodies.length}`)
  const hits = new Map(RUN_ALLOW.map(a => [a.line, 0]))
  for (const body of bodies) {
    const kept = []
    for (const l of body) {
      const t = l.trim()
      if (hits.has(t)) { hits.set(t, hits.get(t) + 1); continue }
      kept.push(l)
    }
    const text = kept.join('\n')
    const at = text.indexOf('${{')
    if (at >= 0) bad.push(`run 內不准 \${{ }}（改經 env:）：${text.slice(Math.max(0, at - 20), at + 40).replace(/\n/g, ' ')}`)
    if (/\|\|\s*true\b/.test(text)) bad.push('不准 || true（含 || 後換行再接 true）')
    if (/\bset\s+(?:-\w+\s+)*\+[a-z]*e[a-z]*\b/.test(text) || /\bset\s+\+o\s+errexit\b/.test(text)) bad.push('不准 set +e／set +eu／set +o errexit')
  }
  for (const a of RUN_ALLOW) if (hits.get(a.line) < a.min) bad.push(`白名單「${a.line.slice(0, 40)}」命中 ${hits.get(a.line)} 次，少於 ${a.min}（${a.why}）`)
  if (/continue-on-error/.test(stripComments(raw))) bad.push('不准 continue-on-error')
  return bad
}

test('#1892 run: 區塊不內插 ${{ }}、不用 || true／set +e／continue-on-error（白名單：guard 取其他 run 編號那行，至少命中 1 次；run 區塊至少 20 個）', () => {
  const W = wf
  assert.deepEqual(runProblems(W), [])
  assert.ok(runBodies(W).length >= 20, 'run 區塊命中數太少')
  assert.ok([...stripComments(W).matchAll(/^\s+\w+:\s*\$\{\{/gm)].length >= 15, 'env／with 的 ${{ }} 至少 15 處（確認外部值確實走 env:）')
})

test('#1892 壞例子：run 內加 ${{ }}、|| true、set +e、continue-on-error 會紅；白名單那行被改掉或拿掉會紅；env: 與註解裡的不算', () => {
  const W = wf
  const has = (src, re) => runProblems(src).some(m => re.test(m))
  const sub = (from, to) => { assert.ok(W.includes(from), `壞例子替換目標不存在：${from}`); return W.replace(from, () => to) }
  const anchor = '          set -euo pipefail\n'
  assert.ok(has(sub(anchor, `${anchor}          echo "\${{ github.ref_name }}"\n`), /\$\{\{/))
  assert.ok(has(sub(anchor, `${anchor}          npm test || true\n`), /\|\| true/))
  assert.ok(has(sub(anchor, `${anchor}          npm test ||true\n`), /\|\| true/))
  assert.ok(has(sub(anchor, `${anchor}          set +e\n`), /set \+e/))
  assert.ok(has(sub('    timeout-minutes:', '    continue-on-error: true\n    timeout-minutes:'), /continue-on-error/))
  // 白名單是整行相等：多接一段、換成別的 || true、拿掉 || true 都不放行
  assert.ok(has(sub("grep -v '^$' || true)", "grep -v '^$' || true); npm test || true"), /\|\| true/))
  assert.ok(has(sub("grep -v '^$' || true)", "grep -v '^x$' || true)"), /\|\| true/))
  assert.ok(has(sub("grep -v '^$' || true)", "grep -v '^$')"), /白名單/))
  // 二審補：run 內文「空白＋#」之後藏的東西、|| 換行接 true、set +eu／set +o errexit、|2 縮排指示符都要抓到
  assert.ok(has(sub(anchor, `${anchor}          echo "x #"; echo \${{ github.ref_name }}\n`), /\$\{\{/))
  assert.ok(has(sub(anchor, `${anchor}          echo "b #1"; npm test || true\n`), /\|\| true/))
  assert.ok(has(sub(anchor, `${anchor}          npm test ||\n            true\n`), /\|\| true/))
  assert.ok(has(sub(anchor, `${anchor}          set +eu\n`), /set \+e/))
  assert.ok(has(sub(anchor, `${anchor}          set +o errexit\n`), /set \+e/))
  assert.equal(runBodies(`jobs:\n  a:\n    steps:\n      - run: |2\n            echo hi\n`).length, 1, '|2 縮排指示符的 run 區塊要抓得到')
  // 不誤傷：註解裡提到不算
  assert.deepEqual(runProblems(`${W}\n# echo "\${{ github.ref_name }}" || true; set +e; continue-on-error\n`), [])
})

test('#2246 接線：android-upload 的上傳步驟有 id: upload，job outputs 帶出 alpha_status／alpha_kind 給 notify', () => {
  const u = jobsOf(stripComments(wf))['android-upload']
  assert.match(u, /alpha_status: \$\{\{ steps\.upload\.outputs\.alpha_status \}\}/)
  assert.match(u, /alpha_kind: \$\{\{ steps\.upload\.outputs\.alpha_kind \}\}/)
  assert.match(u, /id: upload\s+working-directory: relay\/asn/)
})
