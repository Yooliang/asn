// 自動發佈常駐程式（#1980 第二小項）：輪詢發版 run，全綠就依序跑 local_sign_publish（先 dry-run 再正式）。
// 判斷規則全在 auto_publish_core.mjs；這支只負責呼叫端：取鎖、讀 gh、準備工作樹、跑子程序、存 state、貼群組。
// 用法：node tools/release/auto_publish.mjs [--once] [--interval 120] [--state <檔>] [--room <群組代號>] [--dry-run-only]
// 必須在專用 worktree 內執行，不可在主 checkout。不用 gh run watch（它會每 3 秒查一次、燒光 API 額度）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { decide, applyResult, emptyState } from './auto_publish_core.mjs'
import { makeAsnCli, asnCliFail } from './asn_cli.mjs'

export const WORKFLOWS = [
  { platform: 'desktop', file: 'asn-release.yml', re: /^v(\d+\.\d+\.\d+)$/ },
  { platform: 'linux', file: 'asn-release-linux.yml', re: /^linux-v(\d+\.\d+\.\d+)$/ },
]
export const SITE_FILES = ['site/public/index.html', 'site/public/update/latest.json']
const DEFAULT_STATE = path.join(process.env.LOCALAPPDATA || '.', 'ASN', 'auto-publish', 'state.json')

export function parseArgs(argv) {
  const o = { once: false, interval: 120, state: DEFAULT_STATE, room: null, dryRunOnly: false, error: null }
  for (let i = 0; i < argv.length && !o.error; i++) {
    const a = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) { o.error = `${a} 後面要有值`; return null } return v }
    if (a === '--once') o.once = true
    else if (a === '--dry-run-only') o.dryRunOnly = true
    else if (a === '--interval') { const v = Number(val()); if (!(v >= 10)) o.error = '--interval 要是不小於 10 的秒數'; else o.interval = v }
    else if (a === '--state') o.state = val()
    else if (a === '--room') o.room = val()
    else o.error = `不認得的參數：${a}`
  }
  return o
}

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n')

// gh run list 的列 → 核心要的 runs 格式；同一個 runId 取最新 attempt
export function toRuns(platform, re, rows) {
  const byId = new Map()
  for (const r of rows || []) {
    const m = re.exec(r.headBranch || '')
    if (!m) continue
    const id = String(r.databaseId)
    const cur = byId.get(id)
    if (cur && (cur.attempt ?? 1) > (r.attempt ?? 1)) continue
    byId.set(id, { platform, version: m[1], tag: r.headBranch, runId: id, status: r.status, conclusion: r.conclusion || null, createdAt: r.createdAt, attempt: r.attempt ?? 1 })
  }
  return [...byId.values()]
}

// 啟動時檢查：不是主 checkout（worktree 的 git-dir 與 common-dir 不同）
export function checkWorktree(git) {
  const a = git(['rev-parse', '--absolute-git-dir'])
  const b = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (a.status !== 0 || b.status !== 0) return { ok: false, why: '讀不到 git 目錄資訊，不確定是不是在專用工作樹' }
  const n = (s) => path.resolve(String(s).trim()).toLowerCase()
  if (n(a.stdout) === n(b.stdout)) return { ok: false, why: '目前在主 checkout，自動發佈必須在專用的 git worktree 裡執行' }
  return { ok: true }
}

// 跑 local_sign_publish 之前把工作樹整理乾淨；回 { ok, why }
export function prepareWorktree(deps) {
  const { git, readFile } = deps
  const f = git(['fetch', 'origin'])
  if (f.status !== 0) return { ok: false, why: `git fetch origin 失敗（${String(f.stderr).trim().slice(0, 200)}）` }
  const t = git(['fetch', '--tags', 'origin'])
  if (t.status !== 0) return { ok: false, why: `git fetch --tags 被拒絕（可能本機有衝突的舊標籤），不強制覆蓋，請人工處理（${String(t.stderr).trim().slice(0, 200)}）` }
  const st = git(['status', '--porcelain'])
  if (st.status !== 0) return { ok: false, why: 'git status 失敗' }
  const dirty = String(st.stdout).split('\n').map((l) => l.trimEnd()).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''))
  const other = dirty.filter((p) => !SITE_FILES.includes(p))
  if (other.length) return { ok: false, why: `工作樹有其他未提交的改動（${other.slice(0, 5).join('、')}），不自動清理` }
  for (const p of dirty) {
    const show = git(['show', `origin/main:${p}`])
    let mine
    try { mine = readFile(p) } catch { mine = null }
    if (show.status !== 0 || mine === null || norm(show.stdout) !== norm(mine)) {
      return { ok: false, why: `${p} 的內容和 origin/main 不一致（不只是換行差異），不自動清理` }
    }
  }
  if (dirty.length) {
    const r = git(['restore', 'site'])
    if (r.status !== 0) return { ok: false, why: 'git restore site 失敗' }
  }
  const c = git(['checkout', '--detach', 'origin/main'])
  if (c.status !== 0) return { ok: false, why: `切到 origin/main 失敗（${String(c.stderr).trim().slice(0, 200)}）` }
  return { ok: true }
}

// 取鎖；回 { got, stale? }。已有活著的 pid 就 got=false
function acquireLock(lockPath, deps) {
  const tryCreate = () => {
    try { deps.writeExclusive(lockPath, String(deps.pid)); return true } catch (e) { if (e.code === 'EEXIST') return false; throw e }
  }
  if (tryCreate()) return { got: true }
  let old = NaN
  try { old = Number.parseInt(String(deps.readFile(lockPath)).trim(), 10) } catch { /* 讀不到當作殘留 */ }
  if (Number.isFinite(old) && deps.pidAlive(old)) return { got: false, pid: old }
  deps.unlink(lockPath)
  if (!tryCreate()) return { got: false, pid: null }
  return { got: true, stale: Number.isFinite(old) ? old : 'unknown' }
}

export async function runOnce(opts, deps) {
  const { gh, spawn, asnCli, log } = deps
  const lockPath = `${opts.state}.lock`
  const lock = acquireLock(lockPath, deps)
  if (!lock.got) { log(`鎖被 pid ${lock.pid ?? '未知'} 佔用，這一輪不做任何事`); return { outcome: 'locked' } }
  try {
    if (lock.stale !== undefined) log(`發現殘留的鎖（pid ${lock.stale} 已不存在），已接手`)
    const post = (text) => {
      if (!opts.room) { log(`（沒有 --room，未貼群組）${text}`); return }
      let r
      try { r = asnCli(['send', '--room', opts.room, '--body', text]) } catch (e) { r = { status: 1, stderr: e.message } }
      if (r.status !== 0) log(`貼群組失敗：${asnCliFail(r)}`)
    }
    const save = (s) => deps.writeFile(opts.state, JSON.stringify(s, null, 2))

    let state
    if (!deps.exists(opts.state)) state = emptyState()
    else {
      try { state = JSON.parse(deps.readFile(opts.state)) } catch (e) { log(`state 檔讀不懂，停止這一輪（不覆蓋）：${e.message}`); return { outcome: 'bad-state' } }
    }

    let runs = []
    for (const w of WORKFLOWS) {
      const r = gh(['run', 'list', '--workflow', w.file, '-L', '20', '--json', 'databaseId,headBranch,status,conclusion,createdAt,attempt'])
      if (r.status !== 0) { log(`gh run list ${w.file} 失敗，這一輪略過：${String(r.stderr).trim().slice(0, 200)}`); return { outcome: 'gh-failed' } }
      let rows
      try { rows = JSON.parse(r.stdout) } catch { log(`gh run list ${w.file} 輸出不是 JSON，這一輪略過`); return { outcome: 'gh-failed' } }
      runs = runs.concat(toRuns(w.platform, w.re, rows))
    }

    const d = decide({ runs, state, now: deps.now() })
    if (d.action === 'wait') { log(`等待：${d.reason}`); return { outcome: 'wait' } }
    if (d.action === 'report') {
      log(`回報：${d.message}`)
      save(d.state)
      post(d.message)
      return { outcome: 'report' }
    }
    if (d.action === 'publish' && opts.dryRunOnly) { log(`--dry-run-only：${d.key} 待正式發佈，不執行`); return { outcome: 'dry-run-only' } }
    d.state.inflight.pid = deps.pid
    save(d.state)
    const finish = (ok, detail) => {
      const r = applyResult(d.state, { key: d.key, step: d.action, ok, detail, now: deps.now() })
      save(r.state)
      if (r.report) post(r.report)
      return { outcome: ok ? d.action : `${d.action}-failed`, key: d.key }
    }
    const prep = prepareWorktree(deps)
    if (!prep.ok) { log(`工作樹準備失敗：${prep.why}`); return finish(false, prep.why) }

    const args = ['tools/release/local_sign_publish.mjs']
    if (d.platform === 'linux') args.push('--platform', 'linux', '--tag', d.tag, '--run-id', String(d.runId))
    else args.push('--tag', d.tag, '--run-id', String(d.runId), '--with-play', 'no')
    if (d.action === 'dryRun') args.push('--dry-run')
    if (opts.room) args.push('--room', opts.room)
    log(`執行：node ${args.join(' ')}`)
    const r = spawn('node', args)
    log(`子程序結束碼 ${r.status}\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`)
    return finish(r.status === 0, `local_sign_publish 結束碼 ${r.status}，細節看 auto-publish.log`)
  } finally {
    try { deps.unlink(lockPath) } catch (e) { deps.log(`還鎖失敗：${e.message}`) }
  }
}

export function realDeps(opts) {
  const cmd = (bin) => (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') }
  }
  const logPath = path.join(path.dirname(opts.state), 'auto-publish.log')
  return {
    gh: cmd('gh'), git: cmd('git'), spawn: (bin, args) => cmd(bin)(args),
    asnCli: makeAsnCli(),
    now: () => Date.now(), pid: process.pid,
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) },
    writeExclusive: (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, { flag: 'wx' }) },
    unlink: (p) => fs.unlinkSync(p),
    pidAlive: (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } },
    log: (m) => {
      const line = `[${new Date().toISOString()}] ${m}\n`
      try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, line) } catch { /* ignore */ }
      process.stdout.write(line)
    },
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) { console.error(opts.error); process.exit(2) }
  const deps = realDeps(opts)
  const wt = checkWorktree(deps.git)
  if (!wt.ok) { console.error(wt.why); process.exit(2) }
  do {
    try { await runOnce(opts, deps) } catch (e) { deps.log(`這一輪發生例外：${e.stack || e.message}`) }
    if (opts.once) break
    await new Promise((r) => setTimeout(r, opts.interval * 1000))
  } while (true)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
