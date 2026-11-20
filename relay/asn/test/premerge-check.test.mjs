// 合併前檢查（#1972）：PR 已綠且 run 測的合併提交疊在目前 main 頂端 → 可直接合；base 舊、紅、缺 run、還在跑 → 不可。
// 只測純函式（判斷與 paths 解析），不打 gh。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluate, extractMergeSha, formatReport, parsePullRequestPaths, pickLatestRun, shouldTrigger } from '../../../.github/scripts/premerge-check.mjs'

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
