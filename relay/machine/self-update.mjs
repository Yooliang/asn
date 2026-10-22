// 收發室自己更新、自己重啟（小良哥 10/05：收發室不要再靠別的 AI 來更新重啟，那個 AI 又得靠收發室傳指令，會互相卡住）。
// 橋每隔一段時間（ASN_SELF_UPDATE_MS，預設 10 分鐘；0＝關掉）到 origin/main 看 relay/machine/ 有沒有新版：
//   - 只在「乾淨、在 main、沒有本機 commit」時用 fast-forward 拉下來，不碰有人正在改的工作樹（髒、別的分支、有本機 commit 都跳過並記 log）
//   - 只看 relay/machine/ 的變動：別的目錄有新 commit 不動（那是開發視窗的事，不替他們拉）
//   - 拉好之後由橋自己收尾：不再收新信、等手上「轉交中」的信送完（最多 RESTART_DRAIN_MS），停掉收發室與工作者再結束；
//     run-bridge.ps1 的迴圈 15 秒後用新版重新啟動。
// 這支只放決定規則與 git 呼叫（git 由呼叫端注入，好測試）；收尾流程在 bridge.mjs。
import { execFile } from 'node:child_process'

export const WATCH_PATH = 'relay/machine/'
export const RESTART_DRAIN_MS = 5 * 60_000

/**
 * 依 git 狀態決定要不要更新。
 * info: { branch, dirty, ahead, behind, changed: string[]（HEAD..origin/main 之間動到的 relay/machine/ 檔案） }
 */
export function planUpdate(info) {
  if (info.branch !== 'main') return { action: 'skip', reason: `not on main (${info.branch || '?'})` }
  if (info.dirty) return { action: 'skip', reason: 'working tree has uncommitted changes' }
  if (info.ahead > 0) return { action: 'skip', reason: `${info.ahead} local commit(s) not pushed` }
  if (info.behind === 0) return { action: 'none', reason: 'up to date' }
  if (!info.changed.length) return { action: 'none', reason: `origin/main is ${info.behind} ahead but nothing under ${WATCH_PATH} changed` }
  return { action: 'update', reason: `${info.changed.length} file(s) under ${WATCH_PATH} changed` }
}

/** 真的 git：回 { code, out } */
export const gitRunner = repoDir => args => new Promise(resolve => {
  execFile('git', ['-C', repoDir, ...args], { timeout: 60_000, windowsHide: true }, (err, stdout) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout ?? '').trim() })
  })
})

/**
 * 查一次、需要就 fast-forward。回 { action: 'updated'|'none'|'skip'|'error', reason, from?, to?, changed? }。
 * run(args) → Promise<{ code, out }>
 */
export async function checkAndUpdate(run) {
  const must = async (args, what) => {
    const r = await run(args)
    if (r.code !== 0) throw new Error(`${what} failed (git ${args.join(' ')} exit ${r.code})`)
    return r.out
  }
  try {
    await must(['fetch', '--quiet', 'origin', 'main'], 'fetch')
    const branch = await must(['rev-parse', '--abbrev-ref', 'HEAD'], 'branch')
    // 只看追蹤中的檔案；沒追蹤的檔（log、暫存）不算髒，fast-forward 也不會動到它們（真的衝突時 merge 會自己拒絕）
    const dirty = (await must(['status', '--porcelain', '--untracked-files=no'], 'status')) !== ''
    const [ahead, behind] = (await must(['rev-list', '--left-right', '--count', 'HEAD...origin/main'], 'rev-list')).split(/\s+/).map(Number)
    const changed = (await must(['diff', '--name-only', 'HEAD', 'origin/main', '--', WATCH_PATH], 'diff')).split('\n').filter(Boolean)
    const plan = planUpdate({ branch, dirty, ahead, behind, changed })
    if (plan.action !== 'update') return plan
    const from = await must(['rev-parse', '--short', 'HEAD'], 'rev-parse')
    await must(['merge', '--ff-only', '--quiet', 'origin/main'], 'fast-forward')
    const to = await must(['rev-parse', '--short', 'HEAD'], 'rev-parse')
    return { action: 'updated', reason: plan.reason, from, to, changed }
  } catch (e) {
    return { action: 'error', reason: e.message }
  }
}

/** 收尾時機：沒有轉交中的信就可以重啟；等太久（超過 drainMs）也直接重啟，轉交逾時交給重啟後的橋處理 */
export function readyToRestart(pendingStates, since, now, drainMs = RESTART_DRAIN_MS) {
  if (now - since >= drainMs) return { ok: true, reason: 'drain timeout' }
  const busy = pendingStates.filter(s => s === 'forwarding').length
  return busy ? { ok: false, reason: `${busy} mail(s) still forwarding` } : { ok: true, reason: 'nothing forwarding' }
}

// ---- 上一個橋留下的孤兒程序 -----------------------------------------------------------------------
// 橋被硬砍（Stop-Process、工作排程停掉）時，它開的收發室（claude -p）與工作者（Gemini agy 等）不會跟著結束，
// 新的橋起來後兩組會同時收信（w02 10/06 實際遇過）。橋把自己的 pid 記在 bridge.last（不刪），
// 下次啟動時：上一個橋已經不在了，父程序還是它的程序就是孤兒，連同子孫一起結束。只看父 pid，不依名稱砍程序。

/** table: Map<pid, {ppid}>；回傳上一個橋（lastPid）留下、還活著的直接子程序 */
export function orphansOf(table, lastPid, selfPid) {
  if (!lastPid || lastPid === selfPid || table.has(lastPid)) return [] // 上一個橋還活著（或就是自己）：不碰
  return [...table].filter(([, p]) => p.ppid === lastPid).map(([pid]) => pid).filter(pid => pid !== selfPid)
}

export function killTree(pid) {
  return new Promise(resolve => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 }, err => resolve(!err))
    else { try { process.kill(pid, 'SIGTERM'); resolve(true) } catch { resolve(false) } }
  })
}
