// 合併前檢查（#1972）：PR 已綠、而且 CI 測的那個合併提交疊在「目前 main 頂端」上，就不用另開臨時 PR 重跑。
//
// 用法：node .github/scripts/premerge-check.mjs <PR 號> [--repo 擁有者/名稱]（預設 Yooliang/asn；在本機 repo 目錄下跑，要能 git ls-remote origin）
// 結束碼：0＝可直接合；1＝不可合（逐條列原因）；2＝資料取不到、無法判定（一律當不可合）。全程唯讀（gh api GET＋git ls-remote）。
//
// 只適用「一次只合一張」。多張疊成一串時，後面那張的 base 會隨前一張合進去而改變，照舊開臨時 PR（紀律 六之 7）。
//
// 判斷：
//  1. PR head 上所有有 pull_request 觸發的 workflow（動態讀 .github/workflows，新增的不用回來改；目前 6 支）在 PR 目前 head SHA 上最近一次 run 要是 completed＋success。
//     有 paths 規則的（linux-build、ui-shots），PR 變更檔沒碰到那些 paths → 本來就不會觸發，不算缺。
//     該觸發卻沒有 run、還在跑、結論不是 success → 不可合（缺 run 絕不當綠）。
//  2. 每個 run 實際測的合併提交（從 run 的 checkout 紀錄抓 refs/pull/N/merge 的 SHA），確認它是 [main 當時頂端, PR head] 的合併，
//     第一個 parent 要等於目前 `git ls-remote origin refs/heads/main`。取不到那個合併提交 → 不可合。
// 判斷邏輯都是純函式（test 在 relay/asn/test/premerge-check.test.mjs）；gh／git 呼叫只在 gather／main 裡。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_REPO = 'Yooliang/asn'
const WORKFLOW_DIR = '.github/workflows'

/** workflow 文字有沒有 pull_request 觸發（pull_request: 區塊、on: pull_request、on: [pull_request, …]）；pull_request_target 另外回報 */
export function prTriggers(yaml) {
  const t = String(yaml ?? '').replace(/\r\n/g, '\n')
  let pr = false, target = false
  for (const m of t.matchAll(/^\s{2,}pull_request(_target)?:/gm)) { if (m[1]) target = true; else pr = true }
  const inline = t.match(/^on:\s*(.*)$/m)?.[1] ?? ''
  if (/\bpull_request_target\b/.test(inline)) target = true
  if (/\bpull_request\b(?!_)/.test(inline)) pr = true
  return { pr, target }
}

/** 從 {檔名: 內容} 挑出所有有 pull_request 觸發的 workflow＝監看清單（動態產生，新增 workflow 不用回來改）。回傳 [{ name, file, target }]，依檔名排序 */
export function listPrWorkflows(filesByName) {
  return Object.keys(filesByName).filter(f => /\.ya?ml$/.test(f)).sort().flatMap(file => {
    const t = prTriggers(filesByName[file])
    return t.pr || t.target ? [{ name: file.replace(/\.ya?ml$/, ''), file, target: t.target && !t.pr }] : []
  })
}

// ---------- 純函式：觸發 paths ----------

/** GitHub paths 樣式 → 正規表示式：`**` 跨資料夾、`*` 不跨、`?` 單一字元 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** 從 workflow 文字取 on.pull_request 底下的 paths／paths-ignore（沒寫就是 null）。只認這支 repo 用的縮排寫法 */
export function parsePullRequestPaths(yaml) {
  const lines = String(yaml ?? '').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => /^ {2}pull_request:\s*(#.*)?$/.test(l))
  const out = { paths: null, pathsIgnore: null }
  if (start < 0) return out
  let key = null
  for (const l of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(l)) continue
    const indent = l.match(/^ */)[0].length
    if (indent <= 2) break   // 離開 pull_request 區塊
    const k = l.match(/^ {4}(paths|paths-ignore):\s*(#.*)?$/)
    if (k) { key = k[1] === 'paths' ? 'paths' : 'pathsIgnore'; out[key] = []; continue }
    if (/^ {4}\S/.test(l)) { key = null; continue }   // 同層的別的鍵（branches、types…）
    const item = key && l.match(/^\s+-\s+(?:'([^']*)'|"([^"]*)"|(\S+))\s*(#.*)?$/)
    if (item) out[key].push(item[1] ?? item[2] ?? item[3])
  }
  return out
}

/** 依 GitHub 規則（照順序，`!` 開頭的是排除）判斷檔案是否命中 paths */
export function pathsMatch(patterns, file) {
  let hit = false
  for (const p of patterns) {
    if (p.startsWith('!')) { if (globToRegExp(p.slice(1)).test(file)) hit = false }
    else if (globToRegExp(p).test(file)) hit = true
  }
  return hit
}

/** 這張 PR 的變更檔會不會觸發這支 workflow。解析不出規則時保守當「會觸發」（寧可當缺、不放過） */
export function shouldTrigger(yaml, changedFiles) {
  if (yaml == null) return true
  const { paths, pathsIgnore } = parsePullRequestPaths(yaml)
  if (paths) return changedFiles.some(f => pathsMatch(paths, f))
  if (pathsIgnore) return changedFiles.some(f => !pathsMatch(pathsIgnore, f))
  return true
}

// ---------- 純函式：run 與合併提交 ----------

/** 同一個 head SHA 的多個 run 取最新的（run_number 大者；同號取 run_attempt 大者） */
export function pickLatestRun(runs) {
  const list = (runs ?? []).filter(r => r && typeof r === 'object')
  if (!list.length) return null
  return list.reduce((a, b) => {
    const an = a.run_number ?? 0, bn = b.run_number ?? 0
    if (an !== bn) return bn > an ? b : a
    return (b.run_attempt ?? 0) > (a.run_attempt ?? 0) ? b : a
  })
}

/** 從 run 的 checkout 紀錄抓它實際測的合併提交 SHA（fetch 那行：+<sha>:refs/remotes/pull/N/merge）；對不上這張 PR 就當沒有 */
export function extractMergeSha(log, prNumber) {
  const re = /\+([0-9a-f]{40}):refs\/remotes\/pull\/(\d+)\/merge/g
  for (const m of String(log ?? '').matchAll(re)) {
    if (Number(m[2]) === Number(prNumber)) return m[1]
  }
  return null
}

// ---------- 純函式：判斷 ----------

const short = s => String(s ?? '').slice(0, 8)

/**
 * 輸入：
 *   prHeadSha、mainTip：目前 PR head 與 main 頂端
 *   behindBy：main 比（run 測的 base）多幾筆提交，不知道給 null
 *   workflows：[{ name, shouldRun, run: {status, conclusion}|null, merge: {sha, parents:[…]}|null }]
 * 輸出：{ ok, reasons:[字串], notes:[字串] }
 */
export function evaluate({ prHeadSha, mainTip, behindBy = null, workflows }) {
  const reasons = []
  const notes = []
  if (!mainTip) reasons.push('讀不到 main 目前的頂端，沒辦法比對 base')
  // 空集合恆真＝假綠：一支 workflow 都沒有（讀不到目錄、或一支都沒認出）就沒東西可證明「綠」，一律不可
  if (!Array.isArray(workflows) || workflows.length === 0) reasons.push('讀不到、或沒認出任何有 pull_request 觸發的 workflow，沒有任何檢查結果可以證明綠')
  for (const w of Array.isArray(workflows) ? workflows : []) {
    if (!w.shouldRun) { notes.push(`${w.name}：這張 PR 改的檔案本來就不會觸發，不算缺`); continue }
    if (w.unverifiable) { reasons.push(`${w.name}：是 pull_request_target 觸發，這支腳本查不到它的 run，沒辦法確認`); continue }
    const run = w.run
    if (!run) { reasons.push(`${w.name}：缺 run（該觸發卻沒有跑過）`); continue }
    if (run.status !== 'completed') { reasons.push(`${w.name}：還在跑（${run.status}）`); continue }
    if (run.conclusion !== 'success') { reasons.push(`${w.name}：紅燈（結論 ${run.conclusion ?? '無'}）`); continue }
    const m = w.merge
    if (!m || !Array.isArray(m.parents) || m.parents.length < 2) {
      reasons.push(`${w.name}：取不到它實際測的合併提交，沒辦法確認 base`); continue
    }
    if (m.parents[1] !== prHeadSha) { reasons.push(`${w.name}：它測的不是目前這個 head（${short(m.parents[1])}，目前是 ${short(prHeadSha)}）`); continue }
    if (mainTip && m.parents[0] !== mainTip) {
      const n = Number.isInteger(behindBy) ? `落後 main ${behindBy} 筆` : '和 main 目前頂端不同'
      reasons.push(`${w.name}：base 不是目前的 main 頂端（測的 base 是 ${short(m.parents[0])}，main 是 ${short(mainTip)}，${n}）`)
      continue
    }
    notes.push(`${w.name}：綠燈，且疊在最新 main 上測過`)
  }
  return { ok: reasons.length === 0, reasons, notes }
}

/** 把判斷結果印成文字 */
export function formatReport(result) {
  const out = []
  for (const n of result.notes) out.push(`  ✓ ${n}`)
  if (result.ok) { out.push('可直接合（前提：這是唯一要合的一張；多張疊成一串請開臨時 PR）'); return out.join('\n') }
  for (const r of result.reasons) out.push(`  ✗ ${r}`)
  out.push('不可直接合：需重跑／開臨時 PR（標題 tmp: 開頭，用完關掉）')
  return out.join('\n')
}

// ---------- gh／git 呼叫 ----------

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const ghApi = (path, extra = []) => sh('gh', ['api', ...extra, path])
const ghJson = path => JSON.parse(ghApi(path))
// 取不到就回 fallback：呼叫端把「取不到」當不可合處理（evaluate 會列原因），不是吞掉
const tryOr = (fn, fallback) => { try { return fn() } catch { return fallback } }

function mergeOfRun(repo, prNumber, runId) {
  const jobs = tryOr(() => ghJson(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`).jobs, [])
  for (const j of jobs) {
    const log = tryOr(() => ghApi(`repos/${repo}/actions/jobs/${j.id}/logs`), '')
    const sha = extractMergeSha(log, prNumber)
    if (!sha) continue
    const commit = tryOr(() => ghJson(`repos/${repo}/commits/${sha}`), null)
    if (!commit) return { sha, parents: null }   // 合併提交已取不到
    return { sha, parents: (commit.parents ?? []).map(p => p.sha) }
  }
  return null
}

function gather(repo, prNumber) {
  const pr = ghJson(`repos/${repo}/pulls/${prNumber}`)
  if (pr.state !== 'open') console.error(`注意：PR #${prNumber} 目前是 ${pr.merged ? 'merged' : pr.state}，結果只供參考`)
  const prHeadSha = pr.head.sha
  const files = ghApi(`repos/${repo}/pulls/${prNumber}/files?per_page=100`, ['--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)']).split('\n').filter(Boolean)
  const lsRemote = sh('git', ['ls-remote', 'origin', 'refs/heads/main']).trim().split(/\s+/)[0]
  const mainTip = /^[0-9a-f]{40}$/.test(lsRemote) ? lsRemote : null
  // 監看清單＝PR head 上所有有 pull_request 觸發的 workflow；讀不到目錄／檔案就丟錯，整體取不到、當不可合
  const dir = ghJson(`repos/${repo}/contents/${WORKFLOW_DIR}?ref=${prHeadSha}`)
  const texts = {}
  for (const d of dir.filter(x => x.type === 'file' && /\.ya?ml$/.test(x.name))) {
    texts[d.name] = ghApi(`repos/${repo}/contents/${WORKFLOW_DIR}/${d.name}?ref=${prHeadSha}`, ['-H', 'Accept: application/vnd.github.raw'])
  }
  const workflows = listPrWorkflows(texts).map(w => {
    if (w.target) return { name: w.name, shouldRun: true, run: null, merge: null, unverifiable: true }
    const shouldRun = shouldTrigger(texts[w.file], files)
    if (!shouldRun) return { name: w.name, shouldRun, run: null, merge: null }
    const runs = ghJson(`repos/${repo}/actions/workflows/${w.file}/runs?head_sha=${prHeadSha}&event=pull_request&per_page=100`).workflow_runs
    const run = pickLatestRun(runs)
    const merge = run && run.status === 'completed' && run.conclusion === 'success' ? mergeOfRun(repo, prNumber, run.id) : null
    return { name: w.name, shouldRun, run: run && { status: run.status, conclusion: run.conclusion }, merge }
  })
  const firstParent = workflows.map(w => w.merge?.parents?.[0]).find(Boolean)
  const behindBy = mainTip && firstParent && firstParent !== mainTip
    ? tryOr(() => ghJson(`repos/${repo}/compare/${firstParent}...${mainTip}`).ahead_by, null)
    : null
  return { prHeadSha, mainTip, behindBy, workflows }
}

function main(argv) {
  const args = argv.slice(2)
  const ri = args.indexOf('--repo')
  const repo = ri >= 0 ? args.splice(ri, 2)[1] : DEFAULT_REPO
  const pr = Number(args[0])
  if (!Number.isInteger(pr) || pr <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    console.error('用法：node .github/scripts/premerge-check.mjs <PR 號> [--repo 擁有者/名稱]')
    return 2
  }
  let input
  try { input = gather(repo, pr) } catch (e) {
    console.error(`資料取不到，無法判定（一律當不可合）：${String(e.stderr || e.message).split('\n')[0]}`)
    console.log('不可直接合：需重跑／開臨時 PR（標題 tmp: 開頭，用完關掉）')
    return 2
  }
  console.log(`PR #${pr}  head ${short(input.prHeadSha)}  main ${short(input.mainTip)}`)
  const result = evaluate(input)
  console.log(formatReport(result))
  return result.ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv))
