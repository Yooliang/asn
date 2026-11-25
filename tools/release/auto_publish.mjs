// 自動發佈常駐程式（#1980、#2003）：輪詢發版 run，全綠就依序跑 local_sign_publish（先 dry-run 再正式）。
// 運行手冊（第一次上線、--seed、--ack、各檔案用途、回報訊息怎麼處理、怎麼停止）：docs/release/自動發佈運行手冊.md
// 用法：node tools/release/auto_publish.mjs [--once] [--interval 120] [--state <檔>] [--room <群組代號>] [--dry-run-only]
//   播種：--seed <版號>（或 --seed-desktop／--seed-linux）--yes；人工確認一筆失敗：--ack <平台@版號>（同版告警一起清）；人工清一類告警：--ack-alert <類別>
// 判斷規則全在 auto_publish_core.mjs；這支只負責呼叫端：取鎖、讀 gh、準備工作樹、跑子程序、存 state、貼群組。
// 所有相對路徑與子程序（git、gh、node）都以 repo 根目錄為基準，不受啟動目錄影響；--state 給相對路徑則以啟動目錄解析成絕對路徑。
// 必須在專用 worktree 內執行，不可在主 checkout。不用 gh run watch（它會每 3 秒查一次、燒光 API 額度）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { decide, applyResult, seed, acknowledge, compareVersions, validateState, STALE_MS } from './auto_publish_core.mjs'
import { makeAsnCli, asnCliFail, parsePostFailedMarker } from './asn_cli.mjs'

// repo 根目錄取自這支腳本自己的位置，不用 git rev-parse：後者要靠 cwd 才知道在哪個 repo，而 cwd 正是會漂移的東西；
// 腳本在哪個 worktree 裡，根目錄就是那個 worktree（checkWorktree 再確認它不是主 checkout）。
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const WORKFLOWS = [
  { platform: 'desktop', file: 'asn-release.yml', re: /^v(\d+\.\d+\.\d+)$/ },
  { platform: 'linux', file: 'asn-release-linux.yml', re: /^linux-v(\d+\.\d+\.\d+)$/ },
]
export const SITE_FILES = ['site/public/index.html', 'site/public/update/latest.json']
// 不放 %LOCALAPPDATA%/ASN（安裝資料夾，重裝會被清）也不放 ~/.asn；放專用資料夾
const DEFAULT_STATE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'asn-auto-publish', 'state.json')
// 連續被鎖住超過這段時間就貼一次群組（鎖超過 STALE_MS 會被當殘留接手，這裡是接手之前的告警）
export const BLOCKED_NOTICE_MS = 30 * 60 * 1000
// gh 連續失敗（含 403 rate limit）超過這段時間就貼一次群組
export const GH_FAIL_NOTICE_MS = 30 * 60 * 1000

// 告警檔裡會出現的類別（--ack-alert 只認這些）
export const ALERT_CAUSES = ['post-failed', 'already-running', 'bad-state', 'gh-failed', 'prep-failed']

export function parseArgs(argv) {
  const o = { once: false, interval: 120, state: DEFAULT_STATE, room: null, dryRunOnly: false, seedDesktop: null, seedLinux: null, ack: null, ackAlert: null, yes: false, error: null }
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
    else if (a === '--ack-alert') o.ackAlert = val()
    else if (a === '--yes') o.yes = true
    else o.error = `不認得的參數：${a}`
  }
  if (!o.error && o.ack && (o.seedDesktop || o.seedLinux)) o.error = '--ack 和 --seed 不能同時給'
  if (!o.error && o.ackAlert !== null) {
    if (o.ack || o.seedDesktop || o.seedLinux) o.error = '--ack-alert 不能和 --ack、--seed 同時給'
    else if (!ALERT_CAUSES.includes(o.ackAlert)) o.error = `不認得的告警類別：${o.ackAlert}（可用：${ALERT_CAUSES.join('、')}）`
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

// local_sign_publish 正式那步要用的相依（簽章、firebase）；dry-run 不會用到，所以要在這裡先擋（雯 #4536）
// 這裡放相對於 repo 根目錄的路徑，檢查時以 deps.repoRoot 為基準
export const REQUIRED_DEPS = ['relay/asn/node_modules/@tauri-apps/cli/tauri.js']
const rootOf = (deps) => deps.repoRoot ?? REPO_ROOT

// 無害雜檔（#2229）：只認「工作樹根目錄」底下、「未追蹤」（git status 的 ??）、檔名符合下列樣式的檔，準備工作樹時直接刪掉並記 log。
// 窄清單、寫死：*.stackdump 是 bash／cygwin 當機時寫在當前目錄的紀錄（11-24 bash.exe.stackdump 讓發版停了 40 分鐘），沒有任何內容會被發版用到。
// 選擇「刪」而不是「忽略」：local_sign_publish 開跑前自己也會查工作樹乾淨，只在這裡忽略它還是會停。
// 已追蹤檔的改動（即使檔名符合）、子資料夾裡的同名檔、清單外的未追蹤檔，一律照舊停下、不清理。
export const JUNK_UNTRACKED = [/^[^/\\]+\.stackdump$/]
export const isJunkUntracked = (line) => line.startsWith('?? ') && JUNK_UNTRACKED.some((re) => re.test(line.slice(3).replace(/^"|"$/g, '')))

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
  const lines = String(st.stdout).split('\n').map((l) => l.trimEnd()).filter(Boolean)
  const junk = lines.filter(isJunkUntracked).map((l) => l.slice(3).replace(/^"|"$/g, ''))
  const dirty = lines.filter((l) => !isJunkUntracked(l)).map((l) => l.slice(3).replace(/^"|"$/g, ''))
  const other = dirty.filter((p) => !SITE_FILES.includes(p))
  if (other.length) return fail('工作樹有其他未提交的改動，不自動清理', `工作樹有其他未提交的改動（${other.slice(0, 5).join('、')}），不自動清理`)
  // 清單外的改動都沒問題了才刪雜檔（有任何一項要停下時，什麼都不動）
  for (const p of junk) {
    try { (deps.unlink ?? ((x) => fs.unlinkSync(x)))(path.join(rootOf(deps), p)); deps.log?.(`已刪除無害雜檔 ${p}（當機紀錄，不影響發佈）`) } catch (e) { return fail('工作樹有無法刪除的雜檔，請人工處理', `無法刪除雜檔 ${p}：${e.message}`) }
  }
  for (const p of dirty) {
    const show = git(['show', `origin/main:${p}`])
    let mine
    try { mine = readFile(path.join(rootOf(deps), p)) } catch { mine = null }
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
  const missing = REQUIRED_DEPS.filter((p) => !exists(path.join(rootOf(deps), p)))
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

// 告警檔（#2229）：常駐程式不在 Claude 視窗底下，asn-cli 寄不了信；卡住或貼群組失敗時改寫這個檔，由 asn真／asn雯 的巡檢讀。
// 格式：{ updatedAt, alerts: { <類別>: { cause, reason, message, ref, firstAt, lastAt, count, status: 'active'|'resolved', resolvedAt? } } }
// 節流：同類別、同 reason 且還是 active → 只更新 lastAt／count；reason 變了、或已 resolved 後再發生 → 重新計（新告警）。
// 恢復時標成 resolved（留著讓讀的人分得出「發生過、現在沒事」）。訊息只放固定文案與版本，不放 git／子程序原文。
export const ALERT_FILE = 'alert.json'
export const alertPathOf = (opts) => path.join(path.dirname(opts.state), ALERT_FILE)

export function makeAlerts(opts, deps) {
  const p = alertPathOf(opts)
  const load = () => { try { const a = JSON.parse(deps.readFile(p)); return a && typeof a === 'object' && a.alerts && typeof a.alerts === 'object' ? a : { alerts: {} } } catch { return { alerts: {} } } }
  const save = (alerts) => {
    try { atomicWrite(deps, p, JSON.stringify({ updatedAt: new Date(deps.now()).toISOString(), alerts }, null, 2)) } catch (e) { deps.log(`寫告警檔失敗（不影響發版）：${e.message}`) }
  }
  return {
    raise(cause, reason, message, ref = null) {
      try {
        const now = new Date(deps.now()).toISOString()
        const cur = load().alerts
        const old = cur[cause]
        const next = old && old.status === 'active' && old.reason === reason
          ? { ...old, message, ref: ref ?? old.ref, lastAt: now, count: (old.count ?? 1) + 1 }
          : { cause, reason, message, ref, firstAt: now, lastAt: now, count: 1, status: 'active' }
        save({ ...cur, [cause]: next })
      } catch (e) { deps.log(`寫告警檔失敗（不影響發版）：${e.message}`) }
    },
    // 累加版 raise（#2345）：同類已有 active 告警時，把這一行接在原訊息後面（同一行不重複），不蓋掉前一筆；沒有就新建。
    // 用在同一版電腦版與 Linux 都沒貼成，兩個平台的補貼原文都要留。ref 取最新一筆，--ack-alert 一次清全部
    raiseAppend(cause, reason, line, ref = null) {
      try {
        const cur = load().alerts
        const old = cur[cause]
        if (old && old.status === 'active' && old.reason === reason) {
          const lines = String(old.message).split('\n')
          if (!lines.includes(line)) this.raise(cause, reason, `${old.message}\n${line}`, ref)
          return
        }
        this.raise(cause, reason, line, ref)
      } catch (e) { deps.log(`寫告警檔失敗（不影響發版）：${e.message}`) }
    },
    resolve(cause) {
      try {
        const cur = load().alerts
        if (cur[cause]?.status !== 'active') return
        save({ ...cur, [cause]: { ...cur[cause], status: 'resolved', resolvedAt: new Date(deps.now()).toISOString() } })
      } catch (e) { deps.log(`寫告警檔失敗（不影響發版）：${e.message}`) }
    },
    // 人工 --ack <平台@版號>：ref 是這個 key（或 `<key>（<tag>）` 這種帶標籤寫法）的 active 告警一起 resolve，其他 ref 不動；回傳清掉幾筆
    resolveByRef(key) {
      try {
        const cur = load().alerts
        const hit = Object.keys(cur).filter((c) => cur[c]?.status === 'active' && typeof cur[c].ref === 'string' && (cur[c].ref === key || cur[c].ref.startsWith(`${key}（`)))
        if (!hit.length) return 0
        const at = new Date(deps.now()).toISOString()
        save({ ...cur, ...Object.fromEntries(hit.map((c) => [c, { ...cur[c], status: 'resolved', resolvedAt: at }])) })
        return hit.length
      } catch (e) { deps.log(`寫告警檔失敗（不影響發版）：${e.message}`); return 0 }
    },
  }
}

// 貼群組：只准傳固定文案（不可含 git／子程序原文，remote URL 可能帶 token）
// 失敗時寫告警檔 post-failed（getRef 給目前處理的版本；noAlert 給沒持鎖的分支，免得和持鎖者搶寫告警檔）
function makePost(opts, deps, alerts, getRef = () => null) {
  return (text, { noAlert = false } = {}) => {
    if (!opts.room) { deps.log(`（沒有 --room，未貼群組）${text}`); return }
    let r
    try { r = deps.asnCli(['send', '--room', opts.room, '--body', text]) } catch (e) { r = { status: 1, stderr: e.message } }
    if (r.status !== 0) {
      deps.log(`貼群組失敗：${asnCliFail(r)}`)
      if (!noAlert) alerts.raiseAppend('post-failed', 'post-failed', `通知群組失敗，這則訊息沒人看到，請人工確認並通知：${text}`, getRef())
    } else if (!noAlert) alerts.resolve('post-failed')
  }
}

// 常駐程式單一實例鎖（#2229）：重啟排程時 Stop-ScheduledTask 只結束外層 powershell、舊 node 還在，會變兩個同時跑。
// pid 檔 <state 資料夾>/auto-publish.pid，內容「pid 換行 毫秒時間戳」，用 link 排他建立（兩個同時啟動只有一個建得成）。
// 檔裡的 pid 還活著「而且命令列確實是 auto_publish」才算有人在跑；pid 不在、或被別的程式重用（命令列不是 auto_publish）都視為殘留，接手。
// deps.isAutoPublish(pid) 回 true／false／null（null＝查不到命令列：保守當作有人在跑，由人確認後刪 pid 檔）。
export const pidFileOf = (opts) => path.join(path.dirname(opts.state), 'auto-publish.pid')

export function acquireInstance(opts, deps) {
  const f = pidFileOf(opts)
  const mine = `${deps.pid}
${deps.now()}`
  const tryCreate = () => { try { deps.createLock(f, mine); return true } catch (e) { if (e.code === 'EEXIST') return false; throw e } }
  if (tryCreate()) return { got: true, content: mine }
  let other = NaN
  let seen = null
  try { seen = deps.readFile(f); other = parseLock(seen).pid } catch { /* 讀不到：當作殘留或剛被刪 */ }
  if (Number.isFinite(other) && other !== deps.pid && deps.pidAlive(other)) {
    const who = deps.isAutoPublish(other)
    if (who !== false) return { got: false, pid: other, unknown: who === null }
  }
  const stale = `${f}.stale-${deps.pid}`
  try { deps.rename(f, stale) } catch { return { got: false, pid: null, lost: true } }
  // rename 之後核對搬走的就是剛才判斷為殘留的那份；不一樣代表搬到別人剛建好的有效鎖，要還回原名並放棄
  let moved = null
  try { moved = deps.readFile(stale) } catch { /* 讀不到就當不一樣 */ }
  if (moved === null || moved !== seen) {
    if (moved !== null) { try { deps.createLock(f, moved) } catch { /* 還不回去也沒關係（原名已被別人建了新的） */ } }
    try { deps.unlink(stale) } catch { /* 刪不掉不影響 */ }
    return { got: false, pid: null, lost: true }
  }
  try { deps.unlink(stale) } catch { /* 刪不掉不影響 */ }
  if (!tryCreate()) return { got: false, pid: null, lost: true }
  return { got: true, content: mine, tookOver: Number.isFinite(other) ? other : null }
}

// 啟動時呼叫：拿不到鎖就寫 log 與告警檔（類別 already-running），呼叫端據此以非 0 結束
export function claimInstance(opts, deps) {
  const inst = acquireInstance(opts, deps)
  if (!inst.got) {
    const why = inst.pid ? `已經有一個自動發佈常駐程式在跑（pid ${inst.pid}），這個沒有啟動。若要重啟，請先停掉舊的、確認它結束後再啟動${inst.unknown ? '（查不到那個 pid 是什麼程式；確定它不是自動發佈的話，刪掉 auto-publish.pid 再啟動）' : ''}` : '同時有另一個常駐程式在啟動，這個沒有啟動'
    deps.log(why)
    makeAlerts(opts, deps).raise('already-running', 'already-running', why)
  } else makeAlerts(opts, deps).resolve('already-running')
  return inst
}

// 結束時刪 pid 檔：內容還是自己的才刪
export function releaseInstance(opts, deps, content) {
  const f = pidFileOf(opts)
  try { if (deps.readFile(f) === content) deps.unlink(f) } catch { /* 沒有就算了 */ }
}

// 被鎖住時記「開始被擋的時間」的檔：每個 pid 一份，只有該程序自己讀寫，所以不需要鎖
const blockedPathOf = (opts, deps) => `${opts.state}.blocked-since-${deps.pid}`

// 去重用的小檔（核心的 state 只保留自己定義的欄位，多的欄位下一輪會被丟掉，所以另放旁邊）
// { prep, badState, ghFailSince, ghFailNoticed }；只准持鎖時讀改寫（被鎖住的那條分支改用 blocked-since-<pid>）
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
  const alerts = makeAlerts(opts, deps)
  let ref = null
  const post = makePost(opts, deps, alerts, () => ref)
  const notices = makeNotices(opts, deps)
  const lock = acquireLock(lockPath, deps)
  if (!lock.got) {
    log(lock.why ?? `鎖被 pid ${lock.pid ?? '未知'} 佔用，這一輪不做任何事`)
    // 沒持鎖：絕不碰 <state>.notices.json（那是持鎖者的檔，這裡讀改寫會蓋掉別人剛寫的去重標記）。
    // 「開始被擋的時間」與「已貼過」只記在只歸自己（pid）用的檔，不會和任何實例競爭
    const bp = blockedPathOf(opts, deps)
    let b = {}
    try { const x = JSON.parse(deps.readFile(bp)); if (x && typeof x === 'object') b = x } catch { /* 沒有或壞了就重新計時 */ }
    const now = deps.now()
    if (!Number.isFinite(b.since)) atomicWrite(deps, bp, JSON.stringify({ since: now, noticed: false }))
    else if (!b.noticed && now - b.since > BLOCKED_NOTICE_MS) {
      atomicWrite(deps, bp, JSON.stringify({ ...b, noticed: true }))
      post('自動發佈被鎖住超過 30 分鐘，請檢查', { noAlert: true })
    }
    return { outcome: 'locked' }
  }
  try {
    if (lock.stale !== undefined) log(`發現殘留的鎖（pid ${lock.stale}${lock.expired ? '，鎖已超過 2 小時' : ' 已不存在'}），已接手`)
    const save = (s) => atomicWrite(deps, opts.state, JSON.stringify(s, null, 2))
    let nt = notices.load()
    const setN = (patch) => { nt = { ...nt, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === undefined) delete nt[k]; notices.save(nt) }
    // 取到鎖了：清掉自己的「被擋計時」檔（舊版寫在 notices 的欄位也順便清掉）
    try { if (deps.exists(blockedPathOf(opts, deps))) deps.unlink(blockedPathOf(opts, deps)) } catch (e) { log(`清除被擋計時檔失敗：${e.message}`) }
    if (nt.blockedSince !== undefined) setN({ blockedSince: undefined, blockedNoticed: undefined })

    // 不自動建 state：沒播種的 state 不存在時一律拒絕（要先 --seed）
    if (!deps.exists(opts.state)) { log('state 檔不存在，請先用 --seed <版號> 播種（不自動播種）'); return { outcome: 'no-state' } }
    let state
    let badWhy = null
    try {
      state = JSON.parse(deps.readFile(opts.state))
      const v = validateState(state)
      if (!v.ok) badWhy = `結構不對：${v.why}`
    } catch (e) { badWhy = `讀不懂：${e.message}` }
    if (badWhy) {
      log(`state 檔${badWhy}，停止這一輪（不覆蓋）`)
      alerts.raise('bad-state', 'bad-state', '自動發佈的 state 檔讀不懂或結構不對，已停止處理且不覆蓋原檔，請人工檢查或修復 state 檔')
      if (!nt.badState) { setN({ badState: true }); post('自動發佈的 state 檔讀不懂或結構不對，已停止處理且不覆蓋原檔，請檢查') }
      return { outcome: 'bad-state' }
    }
    if (nt.badState) setN({ badState: undefined })
    alerts.resolve('bad-state')

    // gh 連續失敗計時（持鎖才寫 notices）：從第一次失敗起算，超過 GH_FAIL_NOTICE_MS 貼一次固定句，不放 stderr；成功後清掉
    const ghFailed = () => {
      const now = deps.now()
      if (Number.isFinite(nt.ghFailSince) && now - nt.ghFailSince > GH_FAIL_NOTICE_MS) alerts.raise('gh-failed', 'gh-failed', '連續 30 分鐘查不到 GitHub 上的發版狀態，請檢查工作機的 gh 登入與網路')
      if (!Number.isFinite(nt.ghFailSince)) setN({ ghFailSince: now, ghFailNoticed: false })
      else if (!nt.ghFailNoticed && now - nt.ghFailSince > GH_FAIL_NOTICE_MS) {
        setN({ ghFailNoticed: true })
        post('自動發佈連續 30 分鐘查不到 GitHub 上的發版狀態，請檢查 gh 登入或網路')
      }
      return { outcome: 'gh-failed' }
    }
    let runs = []
    for (const w of WORKFLOWS) {
      const r = gh(['run', 'list', '--workflow', w.file, '-L', '20', '--json', 'databaseId,headBranch,status,conclusion,createdAt,attempt'])
      if (r.status !== 0) { log(`gh run list ${w.file} 失敗，這一輪略過：${String(r.stderr).trim().slice(0, 200)}`); return ghFailed() }
      let rows
      try { rows = JSON.parse(r.stdout) } catch { log(`gh run list ${w.file} 輸出不是 JSON，這一輪略過`); return ghFailed() }
      runs = runs.concat(toRuns(w.platform, w.re, rows))
    }

    alerts.resolve('gh-failed')
    if (nt.ghFailSince !== undefined) { log('gh 已恢復，清掉連續失敗計時'); setN({ ghFailSince: undefined, ghFailNoticed: undefined }) }

    const d = decide({ runs, state, now: deps.now() })
    for (const n of d.notes || []) log(n)
    if (d.action === 'wait') { log(`等待：${d.reason}`); return { outcome: 'wait' } }
    if (d.action === 'report') {
      log(`回報：${d.message}`)
      if (d.result === 'unseeded') log('提示：請先執行 --seed <版號> 播種')
      save(d.state)
      // 這一類回報在決定階段就貼，下面 ref 還沒指派；不先帶上的話貼群組失敗的告警 ref 會是 null（#2287）
      if (d.key) ref = d.key
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
    ref = d.key
    const refLabel = `${d.key}（${d.tag}）`
    const prep = prepareWorktree(deps)
    if (!prep.ok) {
      alerts.raise('prep-failed', prep.cat, `${refLabel} 還沒發佈：${prep.cat}。處理好之後會自動重試`, ref)
      // 準備階段失敗（還沒開始發佈）：不記進 done，清掉 inflight，下一輪再試；同一類別只貼一次
      log(`工作樹準備失敗：${prep.why}`)
      d.state.inflight = null
      save(d.state)
      if (nt.prep !== prep.cat) { setN({ prep: prep.cat }); post(`準備失敗，尚未發佈：${prep.cat}（${d.key}，下一輪會再試）`) }
      return { outcome: 'prep-failed', key: d.key }
    }
    if (nt.prep !== undefined) setN({ prep: undefined })
    alerts.resolve('prep-failed')

    const root = rootOf(deps)
    const args = [path.join(root, 'tools', 'release', 'local_sign_publish.mjs')]
    if (d.platform === 'linux') args.push('--platform', 'linux', '--tag', d.tag, '--run-id', String(d.runId))
    else args.push('--tag', d.tag, '--run-id', String(d.runId), '--with-play', 'no')
    if (d.action === 'dryRun') args.push('--dry-run')
    if (opts.room) args.push('--room', opts.room)
    log(`執行：node ${args.join(' ')}`)
    const r = spawn('node', args, { cwd: root })
    log(`子程序結束碼 ${r.status}\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`)
    const out = finish(r.status === 0, `local_sign_publish 結束碼 ${r.status}，細節看 auto-publish.log`)
    // 正式發佈成功但群組沒貼成（#2345）：子程序結束碼是 0，只能靠 stdout 的固定標記得知。發佈結果照記成功（不暫停發佈），
    // 另外留 post-failed 告警讓人補貼。放在 finish 之後：finish 若貼出別的訊息成功會 resolve post-failed，不能把這筆清掉；
    // 之後只有 --ack-alert post-failed（一次清全部）、或下一次真的貼成功才會清；已發佈的版本不是失敗類，--ack 不收。
    // 同一版電腦版與 Linux 都沒貼成時用累加寫入，兩個平台的原文都保留
    if (r.status === 0 && d.action === 'publish') {
      const pf = parsePostFailedMarker(r.stdout)
      if (pf) alerts.raiseAppend('post-failed', 'post-failed', `${d.key} 已發佈成功，但發版完成的通知沒貼到群組，請人工補貼這則原文：${pf.text}`, ref)
    }
    return out
  } finally {
    releaseLock(lockPath, deps, lock.content)
  }
}

// 啟動檢查：state 不存在時，有跑過的痕跡（log、鎖檔、notices 檔）就拒絕，沒痕跡就提示先播種
export function checkStartup(opts, deps) {
  if (deps.exists(opts.state)) return { ok: true }
  const traces = [logPathOf(opts), `${opts.state}.lock`, `${opts.state}.notices.json`].filter((p) => deps.exists(p))
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
      const v = validateState(st)
      if (!v.ok) return { code: 1, msg: `state 檔結構不對：${v.why}` }
      let next
      const before = st?.done?.[opts.ack]?.result
      try { next = acknowledge(st, opts.ack, deps.now()) } catch (e) { return { code: 1, msg: e.message } }
      atomicWrite(deps, opts.state, JSON.stringify(next, null, 2))
      deps.log(`--ack：pid ${deps.pid} 清除 ${opts.ack}，原結果 ${before}，時間 ${new Date(deps.now()).toISOString()}`)
      const n = makeAlerts(opts, deps).resolveByRef(opts.ack)
      return { code: 0, msg: `已確認 ${opts.ack}${n ? `，同版的 ${n} 筆告警一併清除` : ''}` }
    }
    if (opts.ackAlert) {
      if (!ALERT_CAUSES.includes(opts.ackAlert)) return { code: 2, msg: `不認得的告警類別：${opts.ackAlert}` }
      const alerts = makeAlerts(opts, deps)
      let active = false
      try { active = JSON.parse(deps.readFile(alertPathOf(opts))).alerts?.[opts.ackAlert]?.status === 'active' } catch { /* 沒有告警檔＝沒東西可清 */ }
      if (!active) return { code: 0, msg: `${opts.ackAlert} 目前沒有需要清的告警` }
      alerts.resolve(opts.ackAlert)
      deps.log(`--ack-alert：pid ${deps.pid} 清除告警 ${opts.ackAlert}，時間 ${new Date(deps.now()).toISOString()}`)
      return { code: 0, msg: `已清除告警 ${opts.ackAlert}` }
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

// --state 給相對路徑時，以啟動目錄解析成絕對路徑；回 { state, note }，note 非 null 時要寫進 log
export function resolveStatePath(state, cwd) {
  if (path.isAbsolute(state)) return { state, note: null }
  const abs = path.resolve(cwd, state)
  return { state: abs, note: `--state 給的是相對路徑 ${state}，以啟動目錄 ${cwd} 解析，實際使用：${abs}` }
}

export function realDeps(opts, repoRoot = REPO_ROOT) {
  const cmd = (bin) => (args, o = {}) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: repoRoot, ...o })
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') }
  }
  const logPath = logPathOf(opts)
  return {
    repoRoot,
    gh: cmd('gh'), git: cmd('git'), spawn: (bin, args, o) => cmd(bin)(args, o),
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
    isAutoPublish: (pid) => {
      try {
        const r = process.platform === 'win32'
          ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { encoding: 'utf8', timeout: 15000 })
          : spawnSync('ps', ['-p', String(Number(pid)), '-o', 'args='], { encoding: 'utf8', timeout: 15000 })
        const out = String(r.stdout ?? '').trim()
        if (r.status !== 0 || !out) return null
        return /auto_publish/.test(out)
      } catch { return null }
    },
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
  const rs = resolveStatePath(opts.state, process.cwd())
  opts.state = rs.state
  const deps = realDeps(opts)
  if (rs.note) deps.log(rs.note)
  if (opts.ack || opts.ackAlert || opts.seedDesktop || opts.seedLinux) {
    const r = await runCommand(opts, deps)
    ;(r.code === 0 ? console.log : console.error)(r.msg)
    process.exit(r.code)
  }
  const wt = checkWorktree(deps.git)
  if (!wt.ok) { console.error(wt.why); process.exit(2) }
  const st = checkStartup(opts, deps)
  if (!st.ok) { console.error(st.why); process.exit(2) }
  let inst = null
  if (!opts.once) {
    inst = claimInstance(opts, deps)
    if (!inst.got) process.exit(3)
    if (inst.tookOver) deps.log(`發現殘留的 pid 檔（pid ${inst.tookOver} 已不在或不是自動發佈），已接手`)
    const cleanup = () => releaseInstance(opts, deps, inst.content)
    process.on('exit', cleanup)
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0))
  }
  do {
    try { await runOnce(opts, deps) } catch (e) { deps.log(`這一輪發生例外：${e.stack || e.message}`) }
    if (opts.once) break
    await new Promise((r) => setTimeout(r, opts.interval * 1000))
  } while (true)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
