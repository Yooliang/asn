// #1892 正式發版 workflow（asn-release.yml）的守門，規格第 6 節。這一版只接電腦版與官網（Play 拆到後續）：沒有 secrets、沒有 environment。風格比照 ci-workflow-guard／release-rehearsal-guard（字串與正則，不引入 yaml 套件）。通則：
//   1. 先正規化換行（本機 autocrlf）、再剝註解才比對；
//   2. flow-style 的 on／permissions／needs（[a, b]、{…}）一律判失敗——解析器不支援，不猜；
//   3. 每條規則附「至少命中 N 次」計數，避免規則靜默失效（一律用 >=）；
//   4. 每條規則附「壞例子」，證明規則會紅（還原驗證）。
// 純函式（tag_check、site_record_check、notify_status）的單元測試在各自的測試檔；這裡只管 workflow 的接線與備援。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { statusFromNeeds } from '../../../tools/release/notify_run.mjs'
import { JOBS } from '../../../tools/release/notify_status.mjs'

const root = new URL('../../../', import.meta.url)
const RELEASE = '.github/workflows/asn-release.yml'
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8').replace(/\r\n/g, '\n')
const listFiles = dir => {
  const base = new URL(dir, root)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base, { recursive: true }).map(f => String(f).replaceAll('\\', '/')).filter(f => /\.ya?ml$/.test(f)).map(f => `${dir}${f}`)
}

/** 剝掉 # 註解：整行註解與「空白＋#」之後的尾註解 */
export const stripComments = src => src.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n')

/** 頂層區塊（例如 on:、permissions:）底下縮排的行；沒有回 null */
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

/** jobs 底下每個 job 的整段文字：{ 名稱: 文字 } */
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

/** job 的 needs（區塊清單或單一字串）；沒有回 [] */
const needsOf = text => {
  const m = /^ {4}needs:[ \t]*(\S.*)?$/m.exec(text)
  if (!m) return []
  if (m[1]) return [m[1].trim()]
  const after = text.slice(m.index + m[0].length).split('\n').slice(1)
  const out = []
  for (const l of after) { const x = /^ {6}- (\S+)\s*$/.exec(l); if (x) out.push(x[1]); else if (l.trim() !== '') break }
  return out
}

/** job 層 permissions：{ 權限: 值 }；沒有回 null */
const permsOf = text => {
  const m = /^ {4}permissions:\s*\n((?: {6}\S.*\n?)+)/m.exec(text)
  if (!m) return null
  return Object.fromEntries(m[1].split('\n').filter(Boolean).map(l => l.trim().split(/:\s*/)))
}
const envOf = text => /^ {4}environment:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null
const secretsOf = text => [...new Set([...text.matchAll(/secrets\.(?!GITHUB_TOKEN\b)([A-Za-z0-9_]+)/g)].map(m => m[1]))].sort()
const sorted = o => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}: ${v}`).join(', ')

// ---- 規格 3.2 的白名單表 ----
const ALL_JOBS = ['guard', 'desktop', 'attest', 'site-draft', 'notify']
const TABLE = {
  guard: { perms: { contents: 'read', actions: 'read' } },
  desktop: { perms: { contents: 'read' } },
  attest: { perms: { contents: 'read', 'id-token': 'write', attestations: 'write' } },
  'site-draft': { perms: { contents: 'read' } },
  notify: { perms: { contents: 'read', issues: 'write' } },
}
const AUTO_IF = "if: needs.guard.outputs.auto == 'true'"
const AUTO_GATED = ['desktop', 'site-draft'] // attest 靠 needs: desktop 連帶略過；notify 是 always()
const FORBIDDEN_TRIGGERS = ['branches', 'pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule', 'workflow_run', 'workflow_call', 'repository_dispatch', 'release']

/** 檢查一份發版 workflow；回違規訊息陣列，空陣列＝通過 */
export const checkRelease = raw => {
  const src = stripComments(raw)
  const bad = []
  // flow-style 直接失敗
  for (const m of src.matchAll(/^\s*(on|permissions|needs):[ \t]*([\[{].*)$/gm)) bad.push(`flow-style 的 ${m[1]}:（解析器不支援，請改成區塊寫法）`)
  // 1. 只吃標籤
  const on = topBlock(src, 'on')
  if (!on) bad.push('找不到區塊寫法的 on:')
  else {
    const keys = on.filter(l => /^ {2}\S/.test(l)).map(l => /^ {2}([A-Za-z_]+):/.exec(l)?.[1] ?? l.trim())
    if (keys.join() !== 'push') bad.push(`on: 只能有 push，現在是 [${keys.join(', ')}]`)
    const sub = on.filter(l => /^ {4}\S/.test(l)).map(l => l.trim())
    if (sub.join() !== 'tags:') bad.push(`on.push 底下只能有 tags:，現在是 [${sub.join(', ')}]`)
    const tags = on.filter(l => /^ {6}- /.test(l)).map(l => l.trim().slice(2))
    if (tags.join() !== "'v*.*.*'") bad.push(`標籤規則只能是 'v*.*.*'，現在是 [${tags.join(', ')}]`)
    for (const k of FORBIDDEN_TRIGGERS) if (new RegExp(`(^|\\W)${k}\\s*:`).test(on.join('\n'))) bad.push(`on: 不准有 ${k}`)
  }
  // 禁字
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG', 'pull_request_target', 'workflow_dispatch']) if (src.includes(s)) bad.push(`不准出現 ${s}`)
  if (/\bset\s+-[A-Za-z]*x/.test(src) || /\bbash\s+-[A-Za-z]*x/.test(src)) bad.push('不准 set -x')
  if (/secrets\s*:\s*inherit/.test(src)) bad.push('不准 secrets: inherit')
  if (/write-all/.test(src)) bad.push('不准 write-all')
  for (const m of src.matchAll(/^\s*contents:\s*write\b/gm)) bad.push(`不准 ${m[0].trim()}`)
  // 頂層權限、concurrency
  const perms = topBlock(src, 'permissions')
  if (!perms) bad.push('頂層缺 permissions: 區塊')
  else if (perms.map(l => l.trim()).join('|') !== 'contents: read') bad.push(`頂層 permissions 只能是 contents: read，現在是 ${perms.map(l => l.trim()).join(' / ')}`)
  const conc = (topBlock(src, 'concurrency') ?? []).map(l => l.trim()).join('|')
  if (conc !== 'group: asn-release-${{ github.ref_name }}|cancel-in-progress: false') bad.push(`concurrency 不對：${conc}`)

  const jobs = jobsOf(src)
  if (Object.keys(jobs).sort().join() !== [...ALL_JOBS].sort().join()) bad.push(`job 清單不對：[${Object.keys(jobs).join(', ')}]`)
  // 2、3. 全檔不得有 secrets.（GITHUB_TOKEN 例外）與 environment:；逐 job 比對權限與 timeout
  for (const m of src.matchAll(/secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/g)) bad.push(`不准出現 ${m[0]}（這一版沒有 secrets）`)
  if (/^\s*environment\s*:/m.test(src)) bad.push('不准出現 environment:（這一版沒有 environment）')
  for (const name of ALL_JOBS) {
    const t = jobs[name]
    if (t === undefined) continue
    const want = TABLE[name]
    const p = permsOf(t)
    if (!p) bad.push(`job ${name} 缺 permissions:（job 層要明寫 contents: read）`)
    else if (sorted(p) !== sorted(want.perms)) bad.push(`job ${name} 的 permissions 要是 {${sorted(want.perms)}}，現在是 {${sorted(p)}}`)
    const tm = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(t)
    if (!tm) bad.push(`job ${name} 缺 timeout-minutes`)
    else if (Number(tm[1]) !== (name === 'desktop' ? 90 : 20)) bad.push(`job ${name} 的 timeout-minutes 是 ${tm[1]}，不是規格的值`)
  }
  // id-token／attestations 只在 attest、issues: write 只在 notify、actions: read 只在 guard
  for (const [k, only] of [['id-token', 'attest'], ['attestations', 'attest'], ['issues', 'notify'], ['actions', 'guard']]) {
    for (const [name, t] of Object.entries(jobs)) if (name !== only && new RegExp(`^\\s+${k}:`, 'm').test(t)) bad.push(`${k} 只能在 ${only}，但 ${name} 有`)
  }
  // 4. action 釘 SHA
  for (const m of src.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    const ref = m[1]
    if (ref.startsWith('./')) { if (!ref.startsWith('./.github/actions/')) bad.push(`本地 action 只能放 .github/actions/：${ref}`); continue }
    if (!/^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/.test(ref)) bad.push(`action 沒鎖到 40 位 commit：${ref}`)
  }
  // 5. notify 與順序
  const nt = jobs.notify
  if (nt !== undefined) {
    if (!/^ {4}if:\s*always\(\)\s*$/m.test(nt)) bad.push('notify 要有 if: always()')
    const want = ALL_JOBS.filter(j => j !== 'notify')
    const got = needsOf(nt)
    for (const j of want) if (!got.includes(j)) bad.push(`notify 的 needs 缺 ${j}`)
  }
  if (jobs['site-draft'] !== undefined && needsOf(jobs['site-draft']).join() !== 'guard') bad.push('site-draft 只能依賴 guard（不依賴電腦版）')
  if (jobs.desktop !== undefined && needsOf(jobs.desktop).join() !== 'guard') bad.push('desktop 只能依賴 guard')
  if (jobs.attest !== undefined && !needsOf(jobs.attest).includes('desktop')) bad.push('attest 要在 desktop 之後')
  // 開關接線：未設定視為 false；下游要看 guard 的 auto
  const g = jobs.guard ?? ''
  if (!/ASN_RELEASE_AUTO:\s*\$\{\{\s*vars\.ASN_RELEASE_AUTO\s*\}\}/.test(g)) bad.push('guard 要從 vars.ASN_RELEASE_AUTO 讀開關')
  if (!g.includes('[ "${ASN_RELEASE_AUTO:-}" = "true" ]')) bad.push('開關判斷要是「恰為 true」（未設定用 :- 當空字串）')
  if (!/^ {6}auto:\s*\$\{\{\s*steps\.auto\.outputs\.auto\s*\}\}\s*$/m.test(g)) bad.push('guard 要輸出 auto')
  for (const j of AUTO_GATED) if (jobs[j] !== undefined && !new RegExp(`^ {4}${AUTO_IF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(jobs[j])) bad.push(`job ${j} 要有 ${AUTO_IF}`)
  // 每個多行 run: 區塊第一行是 set -euo pipefail
  for (const m of src.matchAll(/^\s*run:\s*\|\s*\n\s*(.*)$/gm)) if (m[1].trim() !== 'set -euo pipefail') bad.push(`多行 run: 要以 set -euo pipefail 開頭：${m[1].trim().slice(0, 40)}`)
  // 縮排：全用 2 的倍數、沒有 tab
  for (const l of src.split('\n')) { if (/\t/.test(l)) bad.push('有 tab'); else if (l.trim() && (l.length - l.trimStart().length) % 2) bad.push(`縮排不是 2 的倍數：${l.trim().slice(0, 40)}`) }
  return bad
}

const release = read(RELEASE)
const flagged = (src, re) => checkRelease(src).some(m => re.test(m))
const mutate = (from, to) => {
  assert.ok(release.includes(from), `壞例子的替換目標不存在：${from}`)
  return release.replace(from, to)
}

test('發版 workflow 存在、掃得到全部 job，且通過全部守門', () => {
  assert.ok(release.length > 3000, 'workflow 不見了或是空的')
  assert.deepEqual(Object.keys(jobsOf(stripComments(release))), ALL_JOBS)
  assert.deepEqual(checkRelease(release), [])
})

test('1 只吃標籤：on 只有 push＋tags 一條規則（至少命中 1 條規則），沒有 workflow_dispatch 等其他來源', () => {
  const on = topBlock(stripComments(release), 'on')
  assert.ok(on && on.length >= 3, 'on: 區塊讀不到，規則可能失效')
  assert.equal([...on.join('\n').matchAll(/^ {6}- '/gm)].length, 1)
  for (const k of FORBIDDEN_TRIGGERS) assert.doesNotMatch(on.join('\n'), new RegExp(`(^|\\W)${k}\\s*:`), k)
})

test('2 沒有 secrets、沒有 environment：全檔 secrets.（GITHUB_TOKEN 例外）＝0、environment:＝0；github.token 至少命中 3 次', () => {
  const src = stripComments(release)
  assert.deepEqual([...src.matchAll(/secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/g)].map(m => m[0]), [])
  assert.doesNotMatch(src, /^\s*environment\s*:/m)
  assert.doesNotMatch(src, /secrets\s*:\s*inherit/)
  const tokens = [...src.matchAll(/\$\{\{\s*github\.token\s*\}\}/g)]
  assert.ok(tokens.length >= 3, `github.token 只找到 ${tokens.length} 處，規則可能失效`)
  const jobs = jobsOf(src)
  for (const j of ALL_JOBS) { assert.deepEqual(secretsOf(jobs[j]), [], j); assert.equal(envOf(jobs[j]), null, j) }
})

test('2 secrets：其他 workflow 與 .github/actions/ 沒有任何 secrets.（GITHUB_TOKEN 例外）；演練檔與 actions 沒有 environment: release、contents: write', () => {
  const others = [...listFiles('.github/workflows/'), ...listFiles('.github/actions/')].filter(f => f !== RELEASE)
  assert.ok(others.length >= 3, `其他檔只找到 ${others.length} 個，規則可能失效`)
  for (const f of others) assert.deepEqual([...stripComments(read(f)).matchAll(/secrets\.(?!GITHUB_TOKEN\b)\w+/g)].map(m => m[0]), [], f)
  const strict = ['.github/workflows/asn-release-rehearsal.yml', ...listFiles('.github/actions/')]
  assert.ok(strict.length >= 2)
  for (const f of strict) {
    const s = stripComments(read(f))
    assert.doesNotMatch(s, /environment:\s*release/, f)
    assert.doesNotMatch(s, /contents:\s*write/, f)
  }
})

test('3 權限白名單：逐 job 比對 3.2 表；頂層只有 contents: read；全檔無 contents: write（5 個 job 各一份 permissions）', () => {
  const src = stripComments(release)
  assert.equal([...src.matchAll(/^ {4}permissions:\s*$/gm)].length, 5)
  const jobs = jobsOf(src)
  for (const j of ALL_JOBS) assert.equal(sorted(permsOf(jobs[j])), sorted(TABLE[j].perms), j)
  assert.equal(topBlock(src, 'permissions').map(l => l.trim()).join('|'), 'contents: read')
  assert.doesNotMatch(src, /contents:\s*write|write-all/)
  // id-token／attestations 只在 attest；issues 只在 notify；actions 只在 guard（各至少命中 1 次）
  for (const [k, only] of [['id-token', 'attest'], ['attestations', 'attest'], ['issues', 'notify'], ['actions', 'guard']]) {
    const have = Object.entries(jobs).filter(([, t]) => new RegExp(`^ {6}${k}:`, 'm').test(t)).map(([n]) => n)
    assert.deepEqual(have, [only], k)
  }
})

test('3 timeout：desktop 90 分鐘，其餘 4 個 job 各 20 分鐘', () => {
  const jobs = jobsOf(stripComments(release))
  for (const j of ALL_JOBS) assert.equal(Number(/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(jobs[j])?.[1]), j === 'desktop' ? 90 : 20, j)
})

test('4 action 釘 SHA：asn-release.yml 的 uses: 至少 10 個、全是 40 位 commit 或 ./.github/actions/', () => {
  const uses = [...stripComments(release).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(m => m[1])
  assert.ok(uses.length >= 10, `uses: 只找到 ${uses.length} 個，規則可能失效`)
  assert.ok(uses.some(u => u.startsWith('actions/attest-build-provenance@')) && uses.some(u => u.startsWith('actions/download-artifact@')))
  for (const u of uses) assert.ok(u.startsWith('./.github/actions/') || /@[0-9a-f]{40}$/.test(u), u)
})

test('5 notify：always()、needs 含其他全部 job、無 environment；順序（attest 在 desktop 之後；site-draft 不依賴 desktop）', () => {
  const jobs = jobsOf(stripComments(release))
  assert.deepEqual(needsOf(jobs.notify), ALL_JOBS.filter(j => j !== 'notify'))
  assert.match(jobs.notify, /^ {4}if:\s*always\(\)\s*$/m)
  assert.equal(envOf(jobs.notify), null)
  assert.ok(needsOf(jobs.attest).includes('desktop'))
  assert.deepEqual(needsOf(jobs['site-draft']), ['guard'])
  assert.deepEqual(needsOf(jobs.desktop), ['guard'])
  // notify_run 只傳實際在 needs 的 job：workflow 的 job（扣掉 guard、notify）都要是 notify_status 認得的
  const real = ALL_JOBS.filter(j => j !== 'guard' && j !== 'notify')
  assert.deepEqual(real.filter(j => !JOBS.includes(j)), [], 'notify_status 的 job 清單與 workflow 不一致')
})

test('6 不准略過：無 --skip-smoke／ASN_SKIP_WEZTERM／ACTIONS_STEP_DEBUG／set -x；多行 run 都以 set -euo pipefail 開頭（至少命中 10 次）', () => {
  const src = stripComments(release)
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG']) assert.ok(!src.includes(s), s)
  assert.ok([...src.matchAll(/set -euo pipefail/g)].length >= 10, 'set -euo pipefail 命中數太少')
})

test('各 job 的接線：desktop 建置後才 npm test 且不略過；attest 只拿安裝檔；其他 job 不碰 attest-build-provenance', () => {
  const jobs = jobsOf(stripComments(release))
  const d = jobs.desktop
  assert.match(d, /runs-on:\s*windows-latest/)
  assert.ok(d.indexOf('git config --global core.autocrlf false') < d.indexOf('actions/checkout@'))
  assert.ok(d.indexOf('node scripts/release-ci.mjs') > 0 && d.indexOf('node scripts/release-ci.mjs') < d.indexOf('npm test'), 'npm test 要排在建置之後')
  assert.match(d, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/)
  assert.ok([...d.matchAll(/overwrite:\s*true/g)].length >= 2)
  assert.match(d, /name:\s*asn-installer-unsigned/); assert.match(d, /name:\s*asn-debug/)
  const a = jobs.attest
  assert.equal([...a.matchAll(/actions\/download-artifact@/g)].length, 1)
  assert.match(a, /name:\s*asn-installer-unsigned/)
  assert.ok(!/asn-debug|asn-site-draft/.test(a))
  for (const j of ['guard', 'desktop', 'site-draft', 'notify']) assert.doesNotMatch(jobs[j], /attest-build-provenance/, j)
  assert.match(jobs['site-draft'], /name:\s*asn-site-draft/)
  assert.doesNotMatch(release, /android|ndk|play-upload|release-play/i, '這一版不含 Play 的建置與上傳')
})

test('auto 開關接線：guard 從 vars 讀、只有恰為 true 才輸出 true（實跑那一行：未設定、空字串、false、TRUE 皆 false）；下游 2 個 job 都看 auto', () => {
  const g = jobsOf(stripComments(release)).guard
  const line = /^\s*(if \[ "\$\{ASN_RELEASE_AUTO:-\}" = "true" \]; then auto=true; else auto=false; fi)$/m.exec(g)
  assert.ok(line, '找不到判斷那一行')
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' })
  if (probe.status !== 0) return // 沒有 bash 的環境只靠上面的字串守門
  const run = env => spawnSync('bash', ['-c', `${line[1]}; echo "$auto"`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).stdout.trim()
  assert.equal(run({}), 'false')
  for (const v of ['', 'false', 'TRUE', 'True', '1', ' true']) assert.equal(run({ ASN_RELEASE_AUTO: v }), 'false', JSON.stringify(v))
  assert.equal(run({ ASN_RELEASE_AUTO: 'true' }), 'true')
  const jobs = jobsOf(stripComments(release))
  assert.equal(AUTO_GATED.filter(j => jobs[j].includes(AUTO_IF)).length, 2)
})

test('guard 的檢查步驟都在：標籤檢查、CHANGELOG 預檢、GitHub Release 狀態、沒有別的發版 run（各至少 1 次）；不再算 Play versionCode', () => {
  const g = jobsOf(stripComments(release)).guard
  for (const k of ['tools/release/tag_check.mjs', 'tools/release/site_record_check.mjs', 'releaseState(', 'workflows/asn-release.yml/runs']) assert.ok(g.includes(k), k)
  assert.doesNotMatch(g, /play-version|version_code|versionCode/)
})

test('notify_run：needs 轉成通知文字（全成功不提 Play、guard 失敗帶卡住的步驟、auto=false 略過）；缺的 job 不算不明的略過', () => {
  const ok = Object.fromEntries(['desktop', 'attest', 'site-draft'].map(j => [j, { result: 'success' }]))
  const needs = over => ({ guard: { result: 'success', outputs: { auto: 'true', version: '0.2.37' } }, ...ok, ...over })
  const RUN = 'https://github.com/Yooliang/asn/actions/runs/9'
  const done = statusFromNeeds(needs(), { runUrl: RUN })
  assert.match(done.text, /【CI 完成】v0\.2\.37/); assert.doesNotMatch(done.text, /Play|異常/)
  const gf = statusFromNeeds({ guard: { result: 'failure', outputs: { auto: 'false', version: '' } } }, { runUrl: RUN, guardStep: '標籤與版本檔' })
  assert.match(gf.text, /【發版未開始】/); assert.match(gf.text, /卡在：標籤與版本檔/)
  const off = statusFromNeeds({ guard: { result: 'success', outputs: { auto: 'false', version: '0.2.37' } } })
  assert.match(off.text, /【發版略過】/)
  const df = statusFromNeeds(needs({ desktop: { result: 'failure' }, attest: { result: 'skipped' } }))
  assert.match(df.text, /電腦版/); assert.doesNotMatch(df.text, /Play/)
  assert.match(statusFromNeeds(needs({ 'site-draft': { result: 'failure' } })).text, /官網紀錄草稿沒產出/)
})

test('7 備援還在：package.json 的 release／release:play／publish:play 指向原腳本；.gitattributes 固定兩個網站檔 eol=lf；原腳本檔都在', () => {
  const scripts = JSON.parse(read('relay/asn/package.json')).scripts
  assert.equal(scripts.release, 'node scripts/release.mjs')
  assert.equal(scripts['release:play'], 'node scripts/release-play.mjs')
  assert.equal(scripts['publish:play'], 'node scripts/play-upload.mjs')
  const attrs = read('.gitattributes')
  for (const f of ['site/public/update/latest.json', 'site/public/index.html']) {
    assert.ok(fs.existsSync(new URL(f, root)), `${f} 不存在`)
    assert.ok(attrs.split('\n').some(l => l.trim() === `${f} text eol=lf`), `.gitattributes 缺 ${f} text eol=lf`)
  }
  for (const f of ['relay/asn/scripts/release.mjs', 'relay/asn/scripts/release-lib.mjs', 'relay/asn/scripts/release-play.mjs', 'relay/asn/scripts/play-upload.mjs', 'relay/asn/scripts/play-version.mjs', 'relay/asn/scripts/bump.mjs', 'tools/release/github_release.mjs', 'tools/release/site_predeploy.mjs']) assert.ok(fs.existsSync(new URL(f, root)), `${f} 不見了`)
})

// ---- 壞例子：每條規則都要真的會紅 ----
test('壞例子 1：加 pull_request／workflow_dispatch／branches／多一條標籤規則會紅', () => {
  assert.ok(flagged(mutate('on:\n  push:', 'on:\n  pull_request:\n  push:'), /on: 只能有 push|不准有 pull_request/))
  assert.ok(flagged(mutate('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:'), /workflow_dispatch/))
  assert.ok(flagged(mutate("    tags:\n      - 'v*.*.*'", "    branches:\n      - main\n    tags:\n      - 'v*.*.*'"), /on\.push 底下只能有 tags|branches/))
  assert.ok(flagged(mutate("      - 'v*.*.*'", "      - 'v*.*.*'\n      - '*'"), /標籤規則只能是/))
})

test('壞例子：flow-style 的 on／permissions／needs 一律紅', () => {
  assert.ok(flagged('on: [push]\npermissions:\n  contents: read\n', /flow-style 的 on/))
  assert.ok(flagged('on:\n  push:\npermissions: {contents: read}\n', /flow-style 的 permissions/))
  assert.ok(flagged(mutate("    needs: guard\n    if: needs.guard.outputs.auto == 'true'\n    runs-on: ubuntu-24.04", "    needs: [guard]\n    if: needs.guard.outputs.auto == 'true'\n    runs-on: ubuntu-24.04"), /flow-style 的 needs/))
})

test('壞例子 2：任何 job 加 secrets.ASN_X、加 environment: release、secrets: inherit 都會紅；註解裡提到不算；GITHUB_TOKEN 例外', () => {
  const tagStep = '          TAG: ${{ github.ref_name }}\n        run: |\n          set -euo pipefail\n          node tools/release/tag_check.mjs'
  assert.ok(flagged(mutate(tagStep, tagStep.replace('        run: |', '          X: ${{ secrets.ASN_X }}\n        run: |')), /不准出現 secrets\.ASN_X/))
  assert.ok(flagged(mutate('          set -euo pipefail\n          node scripts/release-ci.mjs', '          set -euo pipefail\n          echo ${{ secrets.ASN_X }}\n          node scripts/release-ci.mjs'), /不准出現 secrets\.ASN_X/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', '    environment: release\n    timeout-minutes: 90\n'), /不准出現 environment:/))
  assert.ok(flagged(mutate('  notify:\n    needs:', '  notify:\n    environment: release\n    needs:'), /不准出現 environment:/))
  assert.ok(flagged(`${release}\n    secrets: inherit\n`, /secrets: inherit/))
  assert.ok(!flagged(`${release}\n# secrets.ASN_X environment: release 只是註解\n`, /secrets|environment/), '註解裡的不算')
  assert.ok(!flagged(`${release}\n# x: \${{ secrets.GITHUB_TOKEN }}\n`, /不准出現 secrets/), 'GITHUB_TOKEN 例外')
  assert.ok(!checkRelease(mutate('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')).some(m => /不准出現 secrets/.test(m)), 'secrets.GITHUB_TOKEN 例外')
})

test('壞例子 2：演練檔與 actions 加 secrets／environment: release／contents: write 會紅（用同一組正則）', () => {
  const act = stripComments(read(listFiles('.github/actions/')[0]))
  const strictBad = s => /secrets\.(?!GITHUB_TOKEN\b)\w+/.test(s) || /environment:\s*release/.test(s) || /contents:\s*write/.test(s)
  assert.ok(!strictBad(act))
  for (const extra of ['K: ${{ secrets.ASN_X }}', 'environment: release', 'contents: write']) assert.ok(strictBad(`${act}\n${extra}\n`), extra)
})

test('壞例子 3：加 contents: write、id-token 放到別的 job、issues: write 放到別處、少寫 contents: read 都會紅', () => {
  assert.ok(flagged(mutate('permissions:\n  contents: read\n\n# 每個標籤', 'permissions:\n  contents: write\n\n# 每個標籤'), /contents: write|頂層 permissions/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n    permissions:\n      contents: read', '    timeout-minutes: 90\n    permissions:\n      contents: write'), /contents: write|job desktop 的 permissions/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n    permissions:\n      contents: read', '    timeout-minutes: 90\n    permissions:\n      contents: read\n      id-token: write'), /id-token 只能在 attest|job desktop 的 permissions/))
  assert.ok(flagged(mutate('      attestations: write\n', '      attestations: write\n      actions: read\n'), /job attest 的 permissions/))
  assert.ok(flagged(mutate('      contents: read\n      issues: write', '      issues: write'), /job notify 的 permissions/))
  assert.ok(flagged(mutate('      contents: read\n      actions: read', '      contents: read'), /job guard 的 permissions/))
})

test('壞例子 3：timeout 拿掉或改錯會紅', () => {
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', ''), /desktop 缺 timeout-minutes/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', '    timeout-minutes: 20\n'), /desktop 的 timeout-minutes/))
  assert.ok(flagged(mutate('    needs: desktop\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n', '    needs: desktop\n    runs-on: ubuntu-24.04\n    timeout-minutes: 90\n'), /attest 的 timeout-minutes/))
})

test('壞例子 4：action 改 @v4、換成短 SHA、本地路徑不在 .github/actions/ 都會紅', () => {
  assert.ok(flagged(mutate('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0\n        with:\n          name: asn-installer-unsigned', 'actions/download-artifact@v4\n        with:\n          name: asn-installer-unsigned'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be', 'actions/attest-build-provenance@e8998f9'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('uses: ./.github/actions/asn-node-setup', 'uses: ./scripts/evil'), /本地 action 只能放/))
})

test('壞例子 5：notify 拿掉 if: always()／少 needs；順序錯會紅', () => {
  assert.ok(flagged(mutate('    if: always()\n    runs-on: ubuntu-24.04', '    runs-on: ubuntu-24.04'), /notify 要有 if: always/))
  assert.ok(flagged(mutate('      - attest\n      - site-draft\n    if: always()', '      - attest\n    if: always()'), /notify 的 needs 缺 site-draft/))
  assert.ok(flagged(mutate('      - guard\n      - desktop\n      - attest', '      - guard\n      - attest'), /notify 的 needs 缺 desktop/))
  assert.ok(flagged(mutate('    needs: desktop\n    runs-on', '    needs: guard\n    runs-on'), /attest 要在 desktop 之後/))
  assert.ok(flagged(mutate("    needs: guard\n    if: needs.guard.outputs.auto == 'true'\n    runs-on: ubuntu-24.04", "    needs:\n      - guard\n      - desktop\n    if: needs.guard.outputs.auto == 'true'\n    runs-on: ubuntu-24.04"), /site-draft 只能依賴 guard/))
})

test('壞例子 6：--skip-smoke／ASN_SKIP_WEZTERM／ACTIONS_STEP_DEBUG／set -x 會紅；多行 run 沒有 set -euo pipefail 會紅；註解裡提到不算', () => {
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG']) {
    assert.ok(flagged(mutate('          npm test', `          npm test ${s}`), new RegExp(s)), s)
    assert.ok(!flagged(`${release}\n# ${s}\n`, new RegExp(s)), `${s} 在註解裡不該算`)
  }
  assert.ok(flagged(mutate('          npm test', '          set -x\n          npm test'), /set -x/))
  assert.ok(flagged(mutate('          set -euo pipefail\n          node scripts/release-ci.mjs', '          node scripts/release-ci.mjs'), /set -euo pipefail 開頭/))
})

test('壞例子：auto 開關接線拿掉、改成 != false、下游 job 沒看 auto 會紅', () => {
  assert.ok(flagged(mutate('[ "${ASN_RELEASE_AUTO:-}" = "true" ]', '[ "${ASN_RELEASE_AUTO:-}" != "false" ]'), /恰為 true/))
  assert.ok(flagged(mutate('ASN_RELEASE_AUTO: ${{ vars.ASN_RELEASE_AUTO }}', 'ASN_RELEASE_AUTO: ${{ inputs.auto }}'), /vars\.ASN_RELEASE_AUTO/))
  assert.ok(flagged(mutate("    needs: guard\n    if: needs.guard.outputs.auto == 'true'\n    runs-on: windows-latest", '    needs: guard\n    runs-on: windows-latest'), /job desktop 要有 if/))
  assert.ok(flagged(mutate("    needs: guard\n    if: needs.guard.outputs.auto == 'true'\n    runs-on: ubuntu-24.04", '    needs: guard\n    runs-on: ubuntu-24.04'), /job site-draft 要有 if/))
})

test('壞例子：縮排有 tab 或奇數空白會紅', () => {
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', '\ttimeout-minutes: 90\n'), /有 tab/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', '   timeout-minutes: 90\n'), /縮排不是 2 的倍數/))
})
