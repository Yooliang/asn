// #1892 正式發版 workflow（asn-release.yml）的守門，規格第 6 節。這一版只接電腦版與官網（Play 拆到後續）。#2022：只有 desktop-sign 一個 job 可以掛 environment: release、可以用 TAURI_SIGNING_* 兩個 secret（且只在簽章那一步的 env:）；其餘 job 沒有 secrets、沒有 environment。風格比照 ci-workflow-guard／release-rehearsal-guard（字串與正則，不引入 yaml 套件）。通則：
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
import { JOBS, GUARD_STEPS } from '../../../tools/release/notify_status.mjs'

const root = new URL('../../../', import.meta.url)
const RELEASE = '.github/workflows/asn-release.yml'
const RELEASE_ANDROID = '.github/workflows/asn-release-android.yml' // 手機版另一條 CI（#1944）：secrets 只准在它的指定 job（由 release-android-workflow-guard.test.mjs 守）
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
const ALL_JOBS = ['guard', 'desktop', 'attest', 'desktop-sign', 'site-draft', 'notify']
const NOTIFY_JOBS = ['guard', 'desktop', 'attest', 'site-draft'] // #2022 ②-1 不動 notify：desktop-sign 還沒接進通知
const SIGN_JOB = 'desktop-sign'
const SIGN_SECRETS = ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']
const TABLE = {
  guard: { perms: { contents: 'read', actions: 'read' } },
  desktop: { perms: { contents: 'read' } },
  attest: { perms: { contents: 'read', 'id-token': 'write', attestations: 'write' } },
  'desktop-sign': { perms: { contents: 'read' } },
  'site-draft': { perms: { contents: 'read' } },
  notify: { perms: { contents: 'read', issues: 'write' } },
}
const AUTO_IF = "if: needs.guard.outputs.auto == 'true'"
const AUTO_GATED = ['desktop', 'site-draft'] // attest 靠 needs: desktop 連帶略過；notify 是 always()
const FORBIDDEN_TRIGGERS = ['branches', 'pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule', 'workflow_run', 'workflow_call', 'repository_dispatch', 'release']

/** job 文字切成步驟（以 6 空白的 "- " 開頭）；第 0 段是步驟之前的 job 欄位 */
const stepsOf = text => text.split(/\n(?= {6}- )/)
/** 簽章步驟：含 secrets. 的步驟 */
const signStepsOf = text => stepsOf(text).filter(st => /secrets\./.test(st))
/** 這個 job 有沒有把私鑰落地成檔案（有就要 chmod 600＋if: always() 刪除） */
const usesKeyFile = t => /signer\s+sign\b[^\n]*\s(?:-f|--private-key-path)\b/.test(t) || /(?:echo|printf|cat)[^\n]*TAURI_SIGNING_PRIVATE_KEY[^\n]*>/.test(t) || /RUNNER_TEMP[^\n]*\.key\b/.test(t)

/** #2022 desktop-sign 的專屬規則（secrets、environment、金鑰檔、步驟順序）；回違規訊息陣列 */
const checkSign = (src, jobs) => {
  const bad = []
  // environment：只有 desktop-sign，值是 release，剛好一次
  for (const [name, t] of Object.entries(jobs)) {
    const envs = [...t.matchAll(/^\s*environment\s*:.*$/gm)].map(m => m[0].trim())
    if (name === SIGN_JOB) { if (envs.join('|') !== 'environment: release' || envOf(t) !== 'release') bad.push('desktop-sign 要剛好有 environment: release，現在是 [' + envs.join(' | ') + ']') }
    else if (envs.length) bad.push('只有 desktop-sign 可以掛 environment，但 ' + name + ' 有（' + envs.join(' | ') + '）')
  }
  // secrets：只有 desktop-sign 的簽章步驟，只准那兩個名字，且只在該步驟的 env: 區塊
  for (const [name, t] of Object.entries(jobs)) {
    if (name === SIGN_JOB) continue
    for (const x of secretsOf(t)) bad.push('不准出現 secrets.' + x + '（只有 desktop-sign 的簽章步驟可以）')
    if (/TAURI_SIGNING/.test(t)) bad.push('TAURI_SIGNING_* 只能出現在 desktop-sign（' + name + ' 有）')
  }
  const sj = jobs[SIGN_JOB]
  if (sj !== undefined) {
    const used = secretsOf(sj)
    if (used.join() !== [...SIGN_SECRETS].sort().join()) bad.push('desktop-sign 用到的 secrets 要剛好是 ' + SIGN_SECRETS.join('、') + '，現在是 [' + used.join(', ') + ']')
    const steps = signStepsOf(sj)
    if (steps.length !== 1) bad.push('含 secrets 的步驟要剛好 1 個（簽章），現在是 ' + steps.length + ' 個')
    for (const st of steps) {
      const lines = st.split('\n')
      const ei = lines.findIndex(l => /^ {8}env:\s*$/.test(l))
      const envBody = []
      if (ei >= 0) for (let j = ei + 1; j < lines.length && /^ {10}\S/.test(lines[j]); j++) envBody.push(lines[j])
      for (const l of lines) if (/secrets\./.test(l) && !envBody.includes(l)) bad.push('secrets 只能在簽章步驟的 env: 底下：' + l.trim().slice(0, 60))
      for (const k of SIGN_SECRETS) if (!envBody.some(l => new RegExp('^ {10}' + k + ':\\s*\\$\\{\\{\\s*secrets\\.' + k + '\\s*\\}\\}\\s*$').test(l))) bad.push('簽章步驟的 env: 缺 ' + k)
      if (!/signer\s+sign\b/.test(st)) bad.push('含 secrets 的步驟要是 tauri signer sign')
      if (/signer\s+sign\b[^\n]*\s(?:-k|--private-key|-p|--password)(?:\s|=)/.test(st)) bad.push('私鑰與密碼不准放在命令列參數（行程列表看得到）；改走環境變數')
    }
    // 簽章後才驗、驗完才上傳；步驟順序
    const idx = k => sj.indexOf(k)
    const order = ['actions/checkout@', 'npm ci --ignore-scripts', 'name: asn-installer-unsigned', 'sha256sum -c SHA256SUMS.txt', 'signer sign', 'tools/release/ci_verify_sig.mjs', 'name: asn-installer-signed']
    order.forEach((k, i) => { if (idx(k) < 0) bad.push('desktop-sign 缺 ' + k); else if (i > 0 && idx(order[i - 1]) >= 0 && idx(k) < idx(order[i - 1])) bad.push('desktop-sign 的順序不對：' + k + ' 要在 ' + order[i - 1] + ' 之後') })
    if (!/persist-credentials:\s*false/.test(sj)) bad.push('desktop-sign 的 checkout 要 persist-credentials: false')
    const signed = sj.slice(Math.max(0, idx('name: asn-installer-signed')))
    if (!/retention-days:\s*14\b/.test(signed)) bad.push('asn-installer-signed 的保留天數要跟 unsigned 一樣是 14')
    if (/contents:\s*write|id-token|attestations/.test(sj)) bad.push('desktop-sign 的權限只有 contents: read')
    if (needsOf(sj).slice().sort().join() !== 'attest,desktop') bad.push('desktop-sign 的 needs 要剛好是 desktop、attest')
    if (/gh release|create-release|action-gh-release|site\/public|firebase/.test(sj)) bad.push('desktop-sign 不建 Release、不動官網')
    // 金鑰如果落地成檔：chmod 600，且之後有 if: always() 的刪除步驟
    if (usesKeyFile(sj)) {
      if (!/chmod\s+600\b/.test(sj)) bad.push('私鑰暫存檔要 chmod 600')
      if (!/RUNNER_TEMP/.test(sj)) bad.push('私鑰暫存檔要放在 RUNNER_TEMP')
      const all = stepsOf(sj)
      const si = all.findIndex(st => /secrets\./.test(st))
      const cleanup = all.findIndex((st, i) => i > si && /^ {8}if:\s*always\(\)\s*$/m.test(st) && /\brm\s+-f?\b|\bshred\b/.test(st))
      if (cleanup < 0) bad.push('私鑰暫存檔要有簽章步驟之後、if: always() 的刪除步驟')
    }
  }
  return bad
}

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
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG', 'pull_request', 'workflow_dispatch']) if (src.includes(s)) bad.push(`不准出現 ${s}`)
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
  // 2、3. secrets.（GITHUB_TOKEN 例外）與 environment: 只准 desktop-sign（細則在 checkSign）；逐 job 比對權限與 timeout
  bad.push(...checkSign(src, jobs))
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
    const want = NOTIFY_JOBS
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

test('2 secrets 與 environment：只有 desktop-sign（environment: release；secrets 只有 TAURI_SIGNING_* 兩個、只在簽章步驟的 env:）；其餘 5 個 job 都沒有；github.token 至少命中 3 次', () => {
  const src = stripComments(release)
  assert.deepEqual([...new Set([...src.matchAll(/secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/g)].map(m => m[0]))].sort(), SIGN_SECRETS.map(k => 'secrets.' + k).sort())
  assert.equal([...src.matchAll(/^\s*environment\s*:/gm)].length, 1)
  assert.doesNotMatch(src, /secrets\s*:\s*inherit/)
  const tokens = [...src.matchAll(/\$\{\{\s*github\.token\s*\}\}/g)]
  assert.ok(tokens.length >= 3, 'github.token 只找到 ' + tokens.length + ' 處，規則可能失效')
  const jobs = jobsOf(src)
  for (const j of ALL_JOBS.filter(x => x !== SIGN_JOB)) { assert.deepEqual(secretsOf(jobs[j]), [], j); assert.equal(envOf(jobs[j]), null, j); assert.doesNotMatch(jobs[j], /TAURI_SIGNING/, j) }
  assert.equal(envOf(jobs[SIGN_JOB]), 'release')
  assert.deepEqual(secretsOf(jobs[SIGN_JOB]), [...SIGN_SECRETS].sort())
  // secrets 全部落在簽章那一步的 env: 底下（8 空白的 env:、10 空白的鍵）
  const st = signStepsOf(jobs[SIGN_JOB])
  assert.equal(st.length, 1)
  assert.equal([...st[0].matchAll(/^ {10}TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?\s*\}\}\s*$/gm)].length, 2)
  assert.ok(/^ {8}env:\s*$/m.test(st[0]))
})

test('#2022 desktop-sign：needs desktop＋attest；權限只有 contents: read；順序、上傳 artifact、不碰 Release 與官網；tauri 版本走 package-lock', () => {
  const jobs = jobsOf(stripComments(release))
  const d = jobs[SIGN_JOB]
  assert.deepEqual(needsOf(d), ['desktop', 'attest'])
  assert.equal(sorted(permsOf(d)), 'contents: read')
  assert.match(d, /name:\s*asn-installer-signed/)
  assert.match(d, /npm ci --ignore-scripts/)
  assert.doesNotMatch(d, /npx\b/)
  assert.deepEqual(checkSign(stripComments(release), jobs), [])
  const lock = JSON.parse(read('relay/asn/package-lock.json'))
  assert.ok(lock.packages['node_modules/@tauri-apps/cli-linux-x64-gnu'], 'package-lock 沒有 linux x64 的 tauri cli 原生套件，Linux runner 會裝不到')
})

test('#2022 不准 pull_request 類觸發：全檔（去註解後）沒有 pull_request（含 _target）', () => {
  assert.doesNotMatch(stripComments(release), /pull_request/)
})

test('#2022 私鑰暫存檔規則：目前不落地（走環境變數）；若將來改成檔案，要 chmod 600、放 RUNNER_TEMP、之後有 if: always() 的刪除步驟', () => {
  const sj = jobsOf(stripComments(release))[SIGN_JOB]
  assert.equal(usesKeyFile(sj), false)
})

test('2 secrets：除 asn-release-android.yml 外，其他 workflow 與 .github/actions/ 沒有任何 secrets.（GITHUB_TOKEN 例外）；演練檔與 actions 沒有 environment: release、contents: write', () => {
  const others = [...listFiles('.github/workflows/'), ...listFiles('.github/actions/')].filter(f => f !== RELEASE && f !== RELEASE_ANDROID)
  assert.ok(others.length >= 3, `其他檔只找到 ${others.length} 個，規則可能失效`)
  // site-deploy.yml（#1947 ④）只准用官網部署金鑰這一個，而且只在 site-deploy job 的 env（細節由 site-deploy-workflow-guard 守）
  const allowedOf = f => (f === '.github/workflows/site-deploy.yml' ? ['secrets.FIREBASE_SERVICE_ACCOUNT_ASNMESSENGER'] : [])
  for (const f of others) assert.deepEqual([...stripComments(read(f)).matchAll(/secrets\.(?!GITHUB_TOKEN\b)\w+/g)].map(m => m[0]), allowedOf(f), f)
  const strict = ['.github/workflows/asn-release-rehearsal.yml', ...listFiles('.github/actions/')]
  assert.ok(strict.length >= 2)
  for (const f of strict) {
    const s = stripComments(read(f))
    assert.doesNotMatch(s, /environment:\s*release/, f)
    assert.doesNotMatch(s, /contents:\s*write/, f)
  }
})

test('3 權限白名單：逐 job 比對 3.2 表；頂層只有 contents: read；全檔無 contents: write（6 個 job 各一份 permissions）', () => {
  const src = stripComments(release)
  assert.equal([...src.matchAll(/^ {4}permissions:\s*$/gm)].length, 6)
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

test('3 timeout：desktop 90 分鐘，其餘 5 個 job 各 20 分鐘', () => {
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
  assert.deepEqual(needsOf(jobs.notify), NOTIFY_JOBS)
  assert.match(jobs.notify, /^ {4}if:\s*always\(\)\s*$/m)
  assert.equal(envOf(jobs.notify), null)
  assert.ok(needsOf(jobs.attest).includes('desktop'))
  assert.deepEqual(needsOf(jobs['site-draft']), ['guard'])
  assert.deepEqual(needsOf(jobs.desktop), ['guard'])
  // notify_run 只傳實際在 needs 的 job：workflow 的 job（扣掉 guard、notify）都要是 notify_status 認得的
  const real = NOTIFY_JOBS.filter(j => j !== 'guard')
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

test('#1953 desktop：e2e 失敗時上傳截圖與輸出（if: failure()、7 天、路徑跟 npm test 的 ASN_E2E_KEEP 一致）', () => {
  const d = jobsOf(stripComments(release)).desktop
  assert.match(d, /ASN_E2E_KEEP:\s*\$\{\{\s*runner\.temp\s*\}\}\/asn-e2e-keep/)
  const step = d.split(/\n\s*-\s+name:/).find(s => /asn-e2e-shots/.test(s))
  assert.ok(step, '找不到 e2e 截圖上傳步驟')
  assert.match(step, /^\s+if:\s*failure\(\)\s*$/m)
  assert.match(step, /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/asn-e2e-keep\//)
  assert.match(step, /retention-days:\s*7\b/)
  assert.ok(d.indexOf('asn-e2e-shots') > d.indexOf('npm test'), '上傳排在 npm test 之後')
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
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', '    environment: release\n    timeout-minutes: 90\n'), /只有 desktop-sign 可以掛 environment/))
  assert.ok(flagged(mutate('  notify:\n    needs:', '  notify:\n    environment: release\n    needs:'), /只有 desktop-sign 可以掛 environment/))
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

test('guard 的「記錄卡在哪一步」輸出的每個名字都在通知的固定白名單裡（不然 notify 會悄悄丟掉步驟名）', () => {
  const text = read(RELEASE)
  const names = [...text.matchAll(/name="([^"]+)"/g)].map(m => m[1])
  assert.ok(names.length >= 5, `只找到 ${names.length} 個步驟名`)
  for (const n of names) assert.ok(GUARD_STEPS.includes(n), `workflow 輸出「${n}」，但 GUARD_STEPS 沒有它`)
  // 壞例子：workflow 改了名字、白名單沒跟著改
  assert.ok(![...text.replace('name="標籤與版本檔"', 'name="標籤檢查"').matchAll(/name="([^"]+)"/g)].every(m => GUARD_STEPS.includes(m[1])))
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
  if (bodies.length < 12) bad.push(`run 區塊命中數太少：${bodies.length}`)
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

test('#1892 run: 區塊不內插 ${{ }}、不用 || true／set +e／continue-on-error（白名單：guard 取其他 run 編號那行，至少命中 1 次；run 區塊至少 12 個）', () => {
  const W = release
  assert.deepEqual(runProblems(W), [])
  assert.ok(runBodies(W).length >= 12, 'run 區塊命中數太少')
  assert.ok([...stripComments(W).matchAll(/^\s+\w+:\s*\$\{\{/gm)].length >= 15, 'env／with 的 ${{ }} 至少 15 處（確認外部值確實走 env:）')
})

test('#1892 壞例子：run 內加 ${{ }}、|| true、set +e、continue-on-error 會紅；白名單那行被改掉或拿掉會紅；env: 與註解裡的不算', () => {
  const W = release
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

// ---- #2022 desktop-sign 的壞例子：每條新規則都要真的會紅 ----
const SIGN_RUN = '          if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then echo "沒有拿到簽章私鑰（environment release 的 secret）" >&2; exit 1; fi\n'
const SIGN_STEP_NAME = '      - name: 驗簽、反向驗證、簽章前後雜湊\n'
// 只回 checkRelease 與 run 區塊規則合併後的訊息（run 裡的 ${{ }} 由 runProblems 守）
const allProblems = src => [...checkRelease(src), ...runProblems(src)]
const hit = (src, re) => allProblems(src).some(m => re.test(m))

test('#2022 壞例子：secret 寫進 run、secret 出現在簽章步驟 env 以外、換名字、多一個 secret 都會紅', () => {
  assert.deepEqual(allProblems(release), [])
  assert.ok(hit(mutate(SIGN_RUN, `${SIGN_RUN}          echo "\${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"\n`), /run 內不准|secrets 只能在簽章步驟的 env/))
  // 別的步驟（驗簽）的 env 放 secret
  assert.ok(hit(mutate('          BEFORE_SHA: ${{ steps.pre.outputs.sha }}\n', '          BEFORE_SHA: ${{ steps.pre.outputs.sha }}\n          K: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n'), /含 secrets 的步驟要剛好 1 個/))
  // 別的 job 用到 TAURI_SIGNING 的 secret，或任何別的 secret
  assert.ok(hit(mutate('          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          node scripts/release-ci.mjs', '          GH_TOKEN: ${{ github.token }}\n          K: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n        run: |\n          set -euo pipefail\n          node scripts/release-ci.mjs'), /只有 desktop-sign 的簽章步驟可以|TAURI_SIGNING_\* 只能出現在 desktop-sign/))
  assert.ok(hit(mutate('          INSTALLER: ${{ steps.pre.outputs.name }}\n        run: |\n          set -euo pipefail\n          if [ -z', '          INSTALLER: ${{ steps.pre.outputs.name }}\n          OTHER: ${{ secrets.ASN_X }}\n        run: |\n          set -euo pipefail\n          if [ -z'), /secrets 要剛好是|用到的 secrets/))
  assert.ok(hit(mutate('TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}'), /簽章步驟的 env: 缺 TAURI_SIGNING_PRIVATE_KEY_PASSWORD/))
  // 私鑰放在命令列參數
  assert.ok(hit(mutate('tauri.js signer sign "$INSTALLER"', 'tauri.js signer sign -k "$TAURI_SIGNING_PRIVATE_KEY" "$INSTALLER"'), /命令列參數/))
})

test('#2022 壞例子：environment 掛到 desktop／別的 job、desktop-sign 少了或改值、權限變大都會紅', () => {
  assert.ok(hit(mutate('    timeout-minutes: 90\n', '    environment: release\n    timeout-minutes: 90\n'), /只有 desktop-sign 可以掛 environment，但 desktop 有/))
  assert.ok(hit(mutate('  site-draft:\n    needs: guard', '  site-draft:\n    environment: release\n    needs: guard'), /只有 desktop-sign 可以掛 environment，但 site-draft 有/))
  assert.ok(hit(mutate('    environment: release\n', ''), /desktop-sign 要剛好有 environment: release/))
  assert.ok(hit(mutate('    environment: release\n', '    environment: staging\n'), /desktop-sign 要剛好有 environment: release/))
  assert.ok(hit(mutate('    environment: release\n    permissions:\n      contents: read\n', '    environment: release\n    permissions:\n      contents: read\n      id-token: write\n'), /job desktop-sign 的 permissions|id-token 只能在 attest|權限只有 contents: read/))
  assert.ok(hit(mutate('    environment: release\n    permissions:\n      contents: read\n', '    environment: release\n    permissions:\n      contents: write\n'), /contents: write|job desktop-sign 的 permissions/))
})

test('#2022 壞例子：pull_request 觸發、desktop-sign 的 needs 少一個、順序顛倒、建 Release 都會紅', () => {
  assert.ok(hit(mutate('on:\n  push:', 'on:\n  pull_request:\n  push:'), /pull_request/))
  assert.ok(hit(mutate('    needs:\n      - desktop\n      - attest\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    environment', '    needs:\n      - desktop\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    environment'), /desktop-sign 的 needs/))
  assert.ok(hit(mutate('          test -s "$INSTALLER.sig"\n', '          test -s "$INSTALLER.sig"\n          gh release create v1 "$INSTALLER"\n'), /不建 Release/))
})

test('#2022 壞例子：私鑰落地成檔案時，沒有 chmod 600／沒有 if: always() 的刪除步驟會紅；補齊就放行', () => {
  const write = '          printf \'%s\' "$TAURI_SIGNING_PRIVATE_KEY" > "$RUNNER_TEMP/asn.key"\n'
  const file = mutate(SIGN_RUN, `${SIGN_RUN}${write}`)
  assert.ok(hit(file, /chmod 600/), '沒 chmod 600 要紅')
  assert.ok(hit(file, /if: always\(\) 的刪除步驟/), '沒刪除步驟要紅')
  const chmod = file.replace(write, `${write}          chmod 600 "$RUNNER_TEMP/asn.key"\n`)
  assert.ok(!hit(chmod, /chmod 600/) && hit(chmod, /if: always\(\) 的刪除步驟/))
  const cleanup = '      - name: 刪掉私鑰暫存檔\n        if: always()\n        run: |\n          set -euo pipefail\n          rm -f "$RUNNER_TEMP/asn.key"\n\n'
  // 刪除步驟放在簽章之前（順序錯）：不算數
  const before = chmod.replace('      - name: 簽章（私鑰只在這一步的 env）\n', `${cleanup}      - name: 簽章（私鑰只在這一步的 env）\n`)
  assert.ok(hit(before, /if: always\(\) 的刪除步驟/))
  const ok = chmod.replace(SIGN_STEP_NAME, `${cleanup}${SIGN_STEP_NAME}`)
  assert.deepEqual(checkRelease(ok).filter(m => /暫存檔/.test(m)), [])
  // 有 always() 但沒有 rm：不算數
  assert.ok(hit(ok.replace('rm -f "$RUNNER_TEMP/asn.key"', 'echo done'), /if: always\(\) 的刪除步驟/))
  // 有 rm 但沒有 always()：不算數
  assert.ok(hit(ok.replace('        if: always()\n        run: |\n          set -euo pipefail\n          rm', '        run: |\n          set -euo pipefail\n          rm'), /if: always\(\) 的刪除步驟/))
})
