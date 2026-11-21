// 自動發佈常駐程式（#1980 第二小項）：輪詢發版 run，全綠就依序跑 local_sign_publish（先 dry-run 再正式）。
// 判斷規則全在 auto_publish_core.mjs；這支只負責呼叫端：取鎖、讀 gh、準備工作樹、跑子程序、存 state、貼群組。
// 用法：node tools/release/auto_publish.mjs [--once] [--interval 120] [--state <檔>] [--room <群組代號>] [--dry-run-only]
//   首次：node tools/release/auto_publish.mjs --seed <版號>（或 --seed-desktop <版號> --seed-linux <版號>）播種後結束（需加 --yes 才會執行；會先對照 gh 最新成功版號與線上 latest.json，起點低於線上版就拒絕）
//   人工確認一筆失敗：node tools/release/auto_publish.mjs --ack <平台@版號>，存檔後結束
//   ⚠ 運行手冊：電腦版自動那條紅了、改走備援手動發版之後，要對那一版下 --ack desktop@<版號>（Linux 若被標 blocked 也要 --ack linux@<版號>），
//     否則有未清除的失敗，兩個平台的新版都會一直暫停（西川 #4561）
// 必須在專用 worktree 內執行，不可在主 checkout。不用 gh run watch（它會每 3 秒查一次、燒光 API 額度）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { decide, applyResult, seed, acknowledge, compareVersions, STALE_MS } from './auto_publish_core.mjs'
import { makeAsnCli, asnCliFail } from './asn_cli.mjs'

export const WORKFLOWS = [
  { platform: 'desktop', file: 'asn-release.yml', re: /^v(\d+\.\d+\.\d+)$/ },
  { platform: 'linux', file: 'asn-release-linux.yml', re: /^linux-v(\d+\.\d+\.\d+)$/ },
]
export const SITE_FILES = ['site/public/index.html', 'site/public/update/latest.json']
// 不放 %LOCALAPPDATA%/ASN（安裝資料夾，重裝會被清）也不放 ~/.asn；放專用資料夾
const DEFAULT_STATE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'asn-auto-publish', 'state.json')
// 連續被鎖住超過這段時間就貼一次群組（鎖超過 STALE_MS 會被當殘留接手，這裡是接手之前的告警）
export const BLOCKED_NOTICE_MS = 30 * 60 * 1000

export function parseArgs(argv) {
  const o = { once: false, interval: 120, state: DEFAULT_STATE, room: null, dryRunOnly: false, seedDesktop: null, seedLinux: null, ack: null, yes: false, error: null }
  for (let i = 0; i < argv.length && !o.error; i++) {
    const a = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) { o.error = `${a} 後面要有值`; return null } return v }
    if (a === '--once') o.once = true
    else if (a === '--dry-run-only') o.dryRunOnly = true
    else if (a === '--interval') { const v = Number(val()); if (!(v >= 10)) o.error = '--interval 要是不小於 10 的秒數'; else o.interval = v }
    else if (a === '--state') o.state = val()
    else if (a === '--room') o.room = val()
    else if (a === '--seed') { const v = val(); o.seedDesktop = v; o.seedLinux = v }
    else if (a === '--seed-desktop') o.seedDesktop = val()
    else if (a === '--seed-linux') o.seedLinux = val()
    else if (a === '--ack') o.ack = val()
    else if (a === '--yes') o.yes = true
    else o.error = `不認得的參數：${a}`
  }
  if (!o.error && o.ack && (o.seedDesktop || o.seedLinux)) o.error = '--ack 和 --seed 不能同時給'
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

// local_sign_publish 正式那步要用的相依（簽章、firebase）；dry-run 不會用到，所以要在這裡先擋（雯 #4536）
export const REQUIRED_DEPS = ['relay/asn/node_modules/@tauri-apps/cli/tauri.js']

// 跑 local_sign_publish 之前把工作樹整理乾淨；回 { ok, why, cat }
// why 含 git 原文（可能帶 remote URL／token），只能進 log；cat 是固定的類別文案，群組只准貼這個
// ⚠ 禁止用 git clean：專用 worktree 的 node_modules 可能是 junction，git clean 會順著刪掉主 checkout 的 node_modules
export function prepareWorktree(deps) {
  const { git, readFile } = deps
  const fail = (cat, why) => ({ ok: false, cat, why: why ?? cat })
  const f = git(['fetch', 'origin'])
  if (f.status !== 0) return fail('git fetch 失敗', `git fetch origin 失敗（${String(f.stderr).trim().slice(0, 200)}）`)
  const t = git(['fetch', '--tags', 'origin'])
  if (t.status !== 0) return fail('標籤衝突（本機可能有衝突的舊標籤），不強制覆蓋，請人工處理', `git fetch --tags 被拒絕，不強制覆蓋（${String(t.stderr).trim().slice(0, 200)}）`)
  const st = git(['status', '--porcelain'])
  if (st.status !== 0) return fail('git status 失敗')
  const dirty = String(st.stdout).split('\n').map((l) => l.trimEnd()).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''))
  const other = dirty.filter((p) => !SITE_FILES.includes(p))
  if (other.length) return fail('工作樹有其他未提交的改動，不自動清理', `工作樹有其他未提交的改動（${other.slice(0, 5).join('、')}），不自動清理`)
  for (const p of dirty) {
    const show = git(['show', `origin/main:${p}`])
    let mine
    try { mine = readFile(p) } catch { mine = null }
    if (show.status !== 0 || mine === null || norm(show.stdout) !== norm(mine)) {
      return fail('site 檔與 main 不一致（不只是換行差異），不自動清理', `${p} 的內容和 origin/main 不一致（不只是換行差異），不自動清理`)
    }
  }
  if (dirty.length) {
    const r = git(['restore', 'site'])
    if (r.status !== 0) return fail('git restore site 失敗')
  }
  const c = git(['checkout', '--detach', 'origin/main'])
  if (c.status !== 0) return fail('切到 origin/main 失敗', `切到 origin/main 失敗（${String(c.stderr).trim().slice(0, 200)}）`)
  const exists = deps.exists ?? ((p) => fs.existsSync(p))
  const missing = REQUIRED_DEPS.filter((p) => !exists(p))
  if (missing.length) return fail('專用工作樹缺相依，請先在 relay/asn 跑 npm ci（dry-run 不會用到所以要先擋）', `專用工作樹缺相依（${missing.join('、')}）`)
  return { ok: true }
}

// 寫檔一律先寫 tmp 再 rename 覆蓋，避免中途當掉留下半個檔（rename 在 Windows 與 POSIX 都會覆蓋目的檔，這裡正好要覆蓋）
export function atomicWrite(deps, p, text) {
  const tmp = `${p}.tmp-${deps.pid}`
  deps.writeFile(tmp, text)
  deps.rename(tmp, p)
}

// 鎖檔內容：「pid 換行 毫秒時間戳」。回 { pid, ts }，空檔或解析不出來的欄位為 NaN
export function parseLock(text) {
  const [a = '', b = ''] = String(text ?? '').trim().split(/\s+/)
  return { pid: Number.parseInt(a, 10), ts: Number.parseInt(b, 10) }
}

// 取鎖；回 { got, stale?, why? }
// 建鎖用 deps.createLock：真實做法是「先把完整內容寫進暫存檔，再 fs.linkSync(tmp, lock)」。
// 選 link 而不是 wx：wx 會先建出空檔、之後才寫內容，另一個實例剛好讀到空檔會誤判；link 讓鎖檔一出現就是完整內容，
// 且目的檔已存在就失敗（EEXIST）、不像 Windows 上的 rename 會直接覆蓋別人的鎖。
// 接手殘留鎖只准用 rename 搶（先改名成 .stale-<自己的 pid>）：rename 失敗代表別人先搶走了，這一輪放棄。
export function acquireLock(lockPath, deps) {
  let written = null
  const tryCreate = () => {
    const c = `${deps.pid}\n${deps.now()}`
    try { deps.createLock(lockPath, c); written = c; return true } catch (e) { if (e.code === 'EEXIST') return false; throw e }
  }
  if (tryCreate()) return { got: true, content: written }
  let text
  try { text = deps.readFile(lockPath) } catch { return { got: false, why: '鎖檔剛好消失或讀不到，這一輪放棄' } }
  const { pid, ts } = parseLock(text)
  // 空檔或讀不出 pid／時間戳：視為另一個實例剛建立、還在寫，絕不當殘留刪掉
  if (!Number.isFinite(pid) || !Number.isFinite(ts)) return { got: false, pid: null, why: '鎖檔內容是空的或讀不懂（另一個實例可能剛建立），這一輪放棄' }
  // 超過 STALE_MS 一律視為殘留（pid 可能被別的程序重用，不能只信 pid 還活著）
  const expired = deps.now() - ts > STALE_MS
  if (!expired && deps.pidAlive(pid)) return { got: false, pid }
  const mine = `${lockPath}.stale-${deps.pid}`
  try { deps.rename(lockPath, mine) } catch { return { got: false, pid, why: '殘留鎖被別人先搶走了，這一輪放棄' } }
  // rename 之後重讀：搬到的必須就是剛才判斷為殘留的那份（pid＋時間戳都一樣），否則搬到的是別人剛建的活鎖，要還回去並放棄
  let again = null
  try { again = parseLock(deps.readFile(mine)) } catch { /* 讀不到當作不一致 */ }
  if (!again || again.pid !== pid || again.ts !== ts) {
    try { deps.rename(mine, lockPath) } catch (e) { deps.log(`搬到的不是殘留鎖而是別人剛建的鎖，且還原失敗（${mine}）：${e.message}`) }
    return { got: false, pid: null, why: '接手時發現鎖已被別人換成新的，已還回原名，這一輪放棄' }
  }
  try { deps.unlink(mine) } catch { /* 刪不掉不影響 */ }
  if (!tryCreate()) return { got: false, pid: null, why: '接手後建鎖失敗，這一輪放棄' }
  return { got: true, stale: pid, expired, content: written }
}

// 還鎖：鎖檔內的 pid 和時間戳都要是自己取鎖時寫的才刪，否則不動並記 log
export function releaseLock(lockPath, deps, content) {
  let cur
  try { cur = parseLock(deps.readFile(lockPath)) } catch (e) { deps.log(`還鎖時讀不到鎖檔，不刪：${e.message}`); return }
  const mine = parseLock(content)
  if (cur.pid !== mine.pid || cur.ts !== mine.ts) { deps.log(`鎖已被換成別人的（pid ${cur.pid}），不刪`); return }
  try { deps.unlink(lockPath) } catch (e) { deps.log(`還鎖失敗：${e.message}`) }
}

const logPathOf = (opts) => path.join(path.dirname(opts.state), 'auto-publish.log')

// 貼群組：只准傳固定文案（不可含 git／子程序原文，remote URL 可能帶 token）
function makePost(opts, deps) {
  return (text) => {
    if (!opts.room) { deps.log(`（沒有 --room，未貼群組）${text}`); return }
    let r
    try { r = deps.asnCli(['send', '--room', opts.room, '--body', text]) } catch (e) { r = { status: 1, stderr: e.message } }
    if (r.status !== 0) deps.log(`貼群組失敗：${asnCliFail(r)}`)
  }
}

// 去重用的小檔（核心的 state 只保留自己定義的欄位，多的欄位下一輪會被丟掉，所以另放旁邊）
// { blockedSince, blockedNoticed, prep, badState }
function makeNotices(opts, deps) {
  const p = `${opts.state}.notices.json`
  return {
    load() { try { const n = JSON.parse(deps.readFile(p)); return n && typeof n === 'object' ? n : {} } catch { return {} } },
    save(n) { atomicWrite(deps, p, JSON.stringify(n)) },
  }
}

export async function runOnce(opts, deps) {
  const { gh, spawn, log } = deps
  const lockPath = `${opts.state}.lock`
  const post = makePost(opts, deps)
  const notices = makeNotices(opts, deps)
  const lock = acquireLock(lockPath, deps)
  if (!lock.got) {
    log(lock.why ?? `鎖被 pid ${lock.pid ?? '未知'} 佔用，這一輪不做任何事`)
    const n = notices.load()
    const now = deps.now()
    if (!Number.isFinite(n.blockedSince)) notices.save({ ...n, blockedSince: now, blockedNoticed: false })
    else if (!n.blockedNoticed && now - n.blockedSince > BLOCKED_NOTICE_MS) {
      notices.save({ ...n, blockedNoticed: true })
      post('自動發佈被鎖住超過 30 分鐘，請檢查')
    }
    return { outcome: 'locked' }
  }
  try {
    if (lock.stale !== undefined) log(`發現殘留的鎖（pid ${lock.stale}${lock.expired ? '，鎖已超過 2 小時' : ' 已不存在'}），已接手`)
    const save = (s) => atomicWrite(deps, opts.state, JSON.stringify(s, null, 2))
    let nt = notices.load()
    const setN = (patch) => { nt = { ...nt, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === undefined) delete nt[k]; notices.save(nt) }
    if (nt.blockedSince !== undefined) setN({ blockedSince: undefined, blockedNoticed: undefined })

    // 不自動建 state：沒播種的 state 不存在時一律拒絕（要先 --seed）
    if (!deps.exists(opts.state)) { log('state 檔不存在，請先用 --seed <版號> 播種（不自動播種）'); return { outcome: 'no-state' } }
    let state
    try { state = JSON.parse(deps.readFile(opts.state)) } catch (e) {
      log(`state 檔讀不懂，停止這一輪（不覆蓋）：${e.message}`)
      if (!nt.badState) { setN({ badState: true }); post('自動發佈的 state 檔讀不懂，已停止處理且不覆蓋原檔，請檢查') }
      return { outcome: 'bad-state' }
    }
    if (nt.badState) setN({ badState: undefined })

    let runs = []
    for (const w of WORKFLOWS) {
      const r = gh(['run', 'list', '--workflow', w.file, '-L', '20', '--json', 'databaseId,headBranch,status,conclusion,createdAt,attempt'])
      if (r.status !== 0) { log(`gh run list ${w.file} 失敗，這一輪略過：${String(r.stderr).trim().slice(0, 200)}`); return { outcome: 'gh-failed' } }
      let rows
      try { rows = JSON.parse(r.stdout) } catch { log(`gh run list ${w.file} 輸出不是 JSON，這一輪略過`); return { outcome: 'gh-failed' } }
      runs = runs.concat(toRuns(w.platform, w.re, rows))
    }

    const d = decide({ runs, state, now: deps.now() })
    for (const n of d.notes || []) log(n)
    if (d.action === 'wait') { log(`等待：${d.reason}`); return { outcome: 'wait' } }
    if (d.action === 'report') {
      log(`回報：${d.message}`)
      if (d.result === 'unseeded') log('提示：請先執行 --seed <版號> 播種')
      save(d.state)
      post(d.message)
      return { outcome: 'report' }
    }
    if (d.action === 'publish' && opts.dryRunOnly) { log(`--dry-run-only：${d.key} 待正式發佈，不執行`); return { outcome: 'dry-run-only' } }
    d.state.inflight.pid = deps.pid
    save(d.state)
    const finish = (ok, detail) => {
      const r = applyResult(d.state, { key: d.key, step: d.action, ok, detail, now: deps.now() })
      if (r.log) log(r.log)
      save(r.state)
      if (r.report) post(r.report)
      return { outcome: ok ? d.action : `${d.action}-failed`, key: d.key }
    }
    const prep = prepareWorktree(deps)
    if (!prep.ok) {
      // 準備階段失敗（還沒開始發佈）：不記進 done，清掉 inflight，下一輪再試；同一類別只貼一次
      log(`工作樹準備失敗：${prep.why}`)
      d.state.inflight = null
      save(d.state)
      if (nt.prep !== prep.cat) { setN({ prep: prep.cat }); post(`準備失敗，尚未發佈：${prep.cat}（${d.key}，下一輪會再試）`) }
      return { outcome: 'prep-failed', key: d.key }
    }
    if (nt.prep !== undefined) setN({ prep: undefined })

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
    releaseLock(lockPath, deps, lock.content)
  }
}

// 啟動檢查：state 不存在時，有跑過的痕跡（log 或鎖檔）就拒絕，沒痕跡就提示先播種
export function checkStartup(opts, deps) {
  if (deps.exists(opts.state)) return { ok: true }
  const traces = [logPathOf(opts), `${opts.state}.lock`].filter((p) => deps.exists(p))
  if (traces.length) return { ok: false, why: `state 檔不存在，但同資料夾看得出以前跑過（${traces.join('、')}），可能是 state 被刪或搬走。為免重複發佈舊版，拒絕啟動也不自動播種；請確認後用 --seed <版號> 手動播種。` }
  return { ok: false, why: '尚未播種：請先執行 --seed <版號>（或 --seed-desktop／--seed-linux）指定起點版號，再啟動常駐程式。' }
}

// --seed / --ack 子命令：取鎖（免得和常駐程式同時寫 state）、做完存檔、回 { code, msg }
export const ONLINE_LATEST = 'https://asnmessenger.web.app/update/latest.json'

export async function runCommand(opts, deps) {
  const lockPath = `${opts.state}.lock`
  const lock = acquireLock(lockPath, deps)
  if (!lock.got) return { code: 3, msg: lock.why ?? `鎖被 pid ${lock.pid ?? '未知'} 佔用（常駐程式正在跑？），稍後再試` }
  try {
    if (opts.ack) {
      if (!deps.exists(opts.state)) return { code: 1, msg: 'state 檔不存在，沒有可確認的紀錄' }
      let st
      try { st = JSON.parse(deps.readFile(opts.state)) } catch (e) { return { code: 1, msg: `state 檔讀不懂：${e.message}` } }
      let next
      const before = st?.done?.[opts.ack]?.result
      try { next = acknowledge(st, opts.ack, deps.now()) } catch (e) { return { code: 1, msg: e.message } }
      atomicWrite(deps, opts.state, JSON.stringify(next, null, 2))
      deps.log(`--ack：pid ${deps.pid} 清除 ${opts.ack}，原結果 ${before}，時間 ${new Date(deps.now()).toISOString()}`)
      return { code: 0, msg: `已確認 ${opts.ack}` }
    }
    if (deps.exists(opts.state)) return { code: 2, msg: 'state 檔已存在，不可播種（--seed 只能在 state 不存在時用）' }
    // 起點合理性檢查：先顯示兩平台最新成功的版號，再對照線上 latest.json，低於線上版或讀不到都拒絕
    const lines = []
    for (const w of WORKFLOWS) {
      const g = deps.gh(['run', 'list', '--workflow', w.file, '--status', 'success', '-L', '20', '--json', 'databaseId,headBranch,status,conclusion,createdAt,attempt'])
      if (g.status !== 0) return { code: 2, msg: `gh run list ${w.file} 失敗，查不到最新成功的 run，拒絕播種` }
      let latest = null
      try { for (const x of toRuns(w.platform, w.re, JSON.parse(g.stdout))) if (latest === null || compareVersions(x.version, latest) > 0) latest = x.version } catch { return { code: 2, msg: `gh run list ${w.file} 輸出讀不懂，拒絕播種` } }
      lines.push(`${w.platform} 最新成功的 run 版號：${latest ?? '（沒有）'}`)
    }
    let online
    try {
      const res = await deps.fetch(ONLINE_LATEST)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      online = (await res.json()).version
      if (!/^\d+\.\d+\.\d+$/.test(online ?? '')) throw new Error('version 欄位不是版號')
    } catch (e) { return { code: 2, msg: `讀不到線上 latest.json（${e.message}），無法確認起點，拒絕播種` } }
    lines.push(`線上 latest.json 版號：${online}`)
    for (const [p, v] of [['desktop', opts.seedDesktop], ['linux', opts.seedLinux]]) {
      if (/^\d+\.\d+\.\d+$/.test(v ?? '') && compareVersions(v, online) < 0) return { code: 2, msg: `${p} 的起點 ${v} 低於線上版 ${online}，會重發舊版，拒絕播種` }
    }
    const plan = `${lines.join('\n')}\n播種計畫：desktop ${opts.seedDesktop}、linux ${opts.seedLinux}`
    if (!opts.yes) return { code: 4, msg: `${plan}\n尚未播種：確認無誤後加 --yes 才會執行` }
    deps.log(plan)
    const r = seed(undefined, { since: { desktop: opts.seedDesktop, linux: opts.seedLinux }, now: deps.now() })
    if (!r.ok) return { code: 2, msg: r.reason }
    atomicWrite(deps, opts.state, JSON.stringify(r.state, null, 2))
    return { code: 0, msg: `已播種：desktop ${opts.seedDesktop}、linux ${opts.seedLinux}` }
  } finally {
    releaseLock(lockPath, deps, lock.content)
  }
}

export function realDeps(opts) {
  const cmd = (bin) => (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') }
  }
  const logPath = logPathOf(opts)
  return {
    gh: cmd('gh'), git: cmd('git'), spawn: (bin, args) => cmd(bin)(args),
    asnCli: makeAsnCli(),
    fetch: (u) => fetch(u, { signal: AbortSignal.timeout(15000) }),
    now: () => Date.now(), pid: process.pid,
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) },
    rename: (a, b) => fs.renameSync(a, b),
    createLock: (p, s) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const tmp = `${p}.tmp-${process.pid}`
      fs.writeFileSync(tmp, s)
      try { fs.linkSync(tmp, p) } finally { try { fs.unlinkSync(tmp) } catch { /* ignore */ } }
    },
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
  if (opts.ack || opts.seedDesktop || opts.seedLinux) {
    const r = await runCommand(opts, deps)
    ;(r.code === 0 ? console.log : console.error)(r.msg)
    process.exit(r.code)
  }
  const wt = checkWorktree(deps.git)
  if (!wt.ok) { console.error(wt.why); process.exit(2) }
  const st = checkStartup(opts, deps)
  if (!st.ok) { console.error(st.why); process.exit(2) }
  do {
    try { await runOnce(opts, deps) } catch (e) { deps.log(`這一輪發生例外：${e.stack || e.message}`) }
    if (opts.once) break
    await new Promise((r) => setTimeout(r, opts.interval * 1000))
  } while (true)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
