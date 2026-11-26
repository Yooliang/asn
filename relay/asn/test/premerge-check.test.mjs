// 合併前檢查（#1972）：PR 已綠且 run 測的合併提交疊在目前 main 頂端 → 可直接合；base 舊、紅、缺 run、還在跑 → 不可。
// 只測純函式（判斷與 paths 解析），不打 gh。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluate, extractMergeSha, listPrWorkflows, prTriggers, formatReport, parsePullRequestPaths, pickLatestRun, shouldTrigger } from '../../../.github/scripts/premerge-check.mjs'

const HEAD = 'a'.repeat(40)
const MAIN = 'b'.repeat(40)
const OLD = 'c'.repeat(40)
const green = base => ({ run: { status: 'completed', conclusion: 'success' }, merge: { sha: 'd'.repeat(40), parents: [base, HEAD] } })
const wf = (name, over = {}) => ({ name, shouldRun: true, ...green(MAIN), ...over })
const four = over => ['asn-linux-build', 'asn-backend-tests', 'asn-ui-shots', 'asn-pr-checklist'].map(n => wf(n, over?.[n]))
const run = workflows => evaluate({ prHeadSha: HEAD, mainTip: MAIN, workflows })

test('#1972 base 相同且全綠 → 可合', () => {
  const r = run(four())
  assert.equal(r.ok, true)
  assert.match(formatReport(r), /可直接合/)
})

test('#1972 base 舊（run 測的合併提交第一個 parent 不是 main 頂端）→ 不可', () => {
  const r = evaluate({ prHeadSha: HEAD, mainTip: MAIN, behindBy: 3, workflows: four({ 'asn-backend-tests': green(OLD) }) })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('\n'), /asn-backend-tests.*base.*落後 main 3 筆/)
  assert.match(formatReport(r), /需重跑／開臨時 PR/)
})

test('#1972 任一支紅 → 不可', () => {
  for (const c of ['failure', 'cancelled', 'skipped', null]) {
    const r = run(four({ 'asn-ui-shots': { run: { status: 'completed', conclusion: c }, merge: green(MAIN).merge } }))
    assert.equal(r.ok, false, String(c))
    assert.match(r.reasons.join('\n'), /asn-ui-shots：紅燈/)
  }
})

test('#1972 該觸發卻缺 run → 不可（缺 run 不能當綠）', () => {
  const r = run(four({ 'asn-linux-build': { run: null, merge: null } }))
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('\n'), /asn-linux-build：缺 run/)
})

test('#1972 還在跑 → 不可', () => {
  for (const status of ['in_progress', 'queued', 'waiting']) {
    const r = run(four({ 'asn-pr-checklist': { run: { status, conclusion: null }, merge: null } }))
    assert.equal(r.ok, false, status)
    assert.match(r.reasons.join('\n'), /asn-pr-checklist：還在跑/)
  }
})

test('#1972 不該觸發的 workflow 沒有 run → 不影響判斷', () => {
  const r = run(four({ 'asn-ui-shots': { shouldRun: false, run: null, merge: null } }))
  assert.equal(r.ok, true)
  assert.match(r.notes.join('\n'), /asn-ui-shots.*本來就不會觸發/)
})

test('#1972 不該觸發的不能蓋掉其他支的紅', () => {
  const r = run(four({ 'asn-ui-shots': { shouldRun: false, run: null, merge: null }, 'asn-backend-tests': { run: { status: 'completed', conclusion: 'failure' }, merge: null } }))
  assert.equal(r.ok, false)
})

test('#1972 取不到 run 測的合併提交 → 不可', () => {
  for (const merge of [null, { sha: 'd'.repeat(40), parents: null }, { sha: 'd'.repeat(40), parents: [MAIN] }]) {
    const r = run(four({ 'asn-backend-tests': { merge } }))
    assert.equal(r.ok, false)
    assert.match(r.reasons.join('\n'), /取不到它實際測的合併提交/)
  }
})

test('#1972 run 測的不是目前 head → 不可；讀不到 main 頂端 → 不可', () => {
  const r = run(four({ 'asn-backend-tests': { merge: { sha: 'd'.repeat(40), parents: [MAIN, OLD] } } }))
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('\n'), /不是目前這個 head/)
  assert.equal(evaluate({ prHeadSha: HEAD, mainTip: null, workflows: four() }).ok, false)
})

test('#1972 pickLatestRun 取最新 run；extractMergeSha 只認這張 PR', () => {
  assert.equal(pickLatestRun([]), null)
  assert.equal(pickLatestRun([{ run_number: 5, id: 1 }, { run_number: 7, id: 2 }, { run_number: 7, run_attempt: 2, id: 3 }]).id, 3)
  const sha = 'e'.repeat(40)
  const log = `fetch --prune origin +refs/heads/*:refs/remotes/origin/* +${sha}:refs/remotes/pull/1971/merge`
  assert.equal(extractMergeSha(log, 1971), sha)
  assert.equal(extractMergeSha(log, 1972), null)
  assert.equal(extractMergeSha('', 1971), null)
})

test('#1972 trigger paths：真 workflow 檔（linux-build／ui-shots 有 paths、backend-tests／checklist 沒有）', () => {
  const read = f => fs.readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), 'utf8')
  const build = read('asn-linux-build.yml'), shots = read('asn-ui-shots.yml')
  assert.ok(parsePullRequestPaths(build).paths.includes('relay/asn/**'))
  assert.ok(parsePullRequestPaths(shots).paths.includes('relay/asn/ui/**'))
  assert.equal(parsePullRequestPaths(read('asn-backend-tests.yml')).paths, null)
  assert.equal(parsePullRequestPaths(read('asn-pr-checklist.yml')).paths, null)
  // 只改文件：linux-build、ui-shots 都不觸發；backend-tests／checklist 沒 paths，一定觸發
  assert.equal(shouldTrigger(build, ['docs/開發紀律.md']), false)
  assert.equal(shouldTrigger(shots, ['docs/開發紀律.md']), false)
  assert.equal(shouldTrigger(read('asn-backend-tests.yml'), ['docs/開發紀律.md']), true)
  // 碰到 paths 就觸發；`*` 不跨資料夾
  assert.equal(shouldTrigger(build, ['relay/asn/src/a.rs']), true)
  assert.equal(shouldTrigger(shots, ['relay/asn/ui/x/y.js']), true)
  assert.equal(shouldTrigger(shots, ['relay/asn/scripts/smoke-lib.mjs']), true)
  assert.equal(shouldTrigger(shots, ['relay/asn/scripts/other.mjs']), false)
  assert.equal(shouldTrigger(null, ['x']), true)   // 讀不到 workflow 檔 → 保守當會觸發
})

// auto-publish-daemon.test.mjs 會讀 docs/release/ 底下的運行手冊：只改手冊也要跑 Node 測試，不然 main 紅了沒人知道（#2360）
test('改 docs/release/ 要觸發跑 Node 測試的 workflow（PR 和推 main 都要）', () => {
  const build = fs.readFileSync(new URL('../../../.github/workflows/asn-linux-build.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(shouldTrigger(build, ['docs/release/自動發佈運行手冊.md']), true, 'PR 只改運行手冊要觸發')
  const push = build.match(/^  push:\n([\s\S]*?)^  pull_request:/m)?.[1] ?? ''
  assert.ok(push.includes("- 'relay/asn/**'"), '找得到 push 的 paths（防假綠）')
  assert.ok(push.includes("- 'docs/release/**'"), '推 main 只改運行手冊也要觸發')
})

// ---------- 一審必修：監看清單不能漏 workflow ----------
const WF_DIR = new URL('../../../.github/workflows/', import.meta.url)
const realWorkflows = () => Object.fromEntries(fs.readdirSync(WF_DIR).filter(f => /\.ya?ml$/.test(f)).map(f => [f, fs.readFileSync(new URL(f, WF_DIR), 'utf8')]))
// 有 pull_request 觸發卻刻意不監看的 workflow：檔名 → 理由（目前沒有；要排除就寫在這裡並附理由）
const EXCLUDED = {}

test('#1972 守門：repo 內每支有 pull_request 觸發的 workflow 都在監看清單（或在附理由的排除清單）', () => {
  const files = realWorkflows()
  const watched = new Set(listPrWorkflows(files).map(w => w.file))
  // 用另一種寫法（逐行找 pull_request 鍵）獨立數一遍，不依賴 prTriggers
  const expected = Object.keys(files).filter(f => /^\s*pull_request(_target)?:/m.test(files[f]) || /^on:.*pull_request/m.test(files[f]))
  assert.ok(expected.length >= 6, `預期至少 6 支，實際 ${expected.length}`)
  for (const f of expected) {
    assert.ok(watched.has(f) || (EXCLUDED[f] && EXCLUDED[f].length > 4), `${f} 有 pull_request 觸發，卻不在監看清單、也不在附理由的排除清單`)
  }
  for (const f of ['wezterm-build.yml', 'asn-wezterm-linux-probe.yml', 'asn-linux-build.yml', 'asn-backend-tests.yml', 'asn-ui-shots.yml', 'asn-pr-checklist.yml', 'asn-node-tests.yml']) {
    assert.ok(watched.has(f), `${f} 要被監看`)
  }
  assert.ok(!watched.has('asn-release.yml'), '只有 workflow_dispatch／push 觸發的不在清單')
})

test('#1972 改到 wezterm 檔：wezterm-build 紅燈／缺 run → 不可', () => {
  const files = realWorkflows()
  assert.equal(shouldTrigger(files['wezterm-build.yml'], ['.github/scripts/wezterm-src-prepare.sh']), true)
  assert.equal(shouldTrigger(files['wezterm-build.yml'], ['relay/asn/ui/a.js']), false)
  const mk = over => [...four(), wf('wezterm-build', over)]
  assert.equal(run(mk()).ok, true)
  assert.equal(run(mk({ run: null, merge: null })).ok, false)
  assert.equal(run(mk({ run: { status: 'completed', conclusion: 'failure' }, merge: null })).ok, false)
  assert.equal(run(mk({ run: { status: 'in_progress', conclusion: null }, merge: null })).ok, false)
})

test('#1972 prTriggers 認得各種寫法；pull_request_target 查不到 run 一律不可；別種縮排的 paths 保守當會觸發', () => {
  assert.deepEqual(prTriggers('on:\n  pull_request:\n    paths:\n      - a\n'), { pr: true, target: false })
  assert.deepEqual(prTriggers('on: [push, pull_request]\n'), { pr: true, target: false })
  assert.deepEqual(prTriggers('on: pull_request\n'), { pr: true, target: false })
  assert.deepEqual(prTriggers('on:\n  push:\n  workflow_dispatch:\n'), { pr: false, target: false })
  assert.deepEqual(prTriggers('on:\n  pull_request_target:\n'), { pr: false, target: true })
  assert.equal(run([...four(), { name: 'x', shouldRun: true, run: null, merge: null, unverifiable: true }]).ok, false)
  // 四格縮排的寫法解析不到 paths → 保守回 true
  assert.equal(shouldTrigger('on:\n    pull_request:\n        paths:\n            - a/**\n', ['zzz']), true)
})

test('#1972 二審：workflows 是空的（空集合恆真）→ 不可，並印出原因', () => {
  for (const workflows of [[], undefined, null]) {
    const r = evaluate({ prHeadSha: HEAD, mainTip: MAIN, workflows })
    assert.equal(r.ok, false, String(workflows))
    assert.match(r.reasons.join('\n'), /沒認出任何有 pull_request 觸發的 workflow/)
    assert.match(formatReport(r), /需重跑／開臨時 PR/)
  }
})

test('#1972 二審：讀不到 .github/workflows（空目錄）或沒有任何一支有 pull_request 觸發 → 不可', () => {
  assert.deepEqual(listPrWorkflows({}), [])
  assert.equal(evaluate({ prHeadSha: HEAD, mainTip: MAIN, workflows: listPrWorkflows({}) }).ok, false)
  const noPr = { 'asn-release.yml': 'on:\n  push:\n    tags:\n      - "v*"\n', 'notes.txt': 'pull_request:' }
  assert.equal(evaluate({ prHeadSha: HEAD, mainTip: MAIN, workflows: listPrWorkflows(noPr) }).ok, false)
})
