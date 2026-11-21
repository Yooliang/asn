// 自動發佈的判斷核心：純函式，不呼叫 gh、不跑子程序、不寫檔。
// state 格式（版本 1）：
//   { v: 1,
//     done:    { '平台@版號': { result, at, runId } },
//     pending: { '平台@版號': { platform, tag, runId, at } },   // 試跑已過、待正式
//     inflight: null | { key, step: 'dryRun'|'publish', startedAt, pid, platform, tag, runId },
//     seeded: boolean,          // 是否播種過；沒播種的 state 一律不處理任何版本
//     since: { desktop, linux } | null,  // 播種起點；seeded 為 true 卻沒有合法的 since 一律當成沒播種（#4563）
//     seedNoticed: boolean,     // 已回報過「需要播種」
//     pausedNoticed: boolean }  // 已回報過「有未處理失敗而暫停」
// done 的每筆可再有 ackedAt（人工確認清除失敗的時間，見 acknowledge）
// result 取值：published / seeded / ci-failed / dryrun-failed / publish-failed / stale / blocked
// 失敗類（未確認時會暫停更新版本）：ci-failed / dryrun-failed / publish-failed / stale / blocked

export const STATE_VERSION = 1
export const STALE_MS = 2 * 60 * 60 * 1000
const FAILURES = new Set(['ci-failed', 'dryrun-failed', 'publish-failed', 'stale', 'blocked'])
const VERSION_RE = /^\d+\.\d+\.\d+$/
const isVersion = (v) => typeof v === 'string' && VERSION_RE.test(v)
const PLATFORMS = ['desktop', 'linux']
const PLATFORM_NAME = { desktop: '電腦版', linux: 'Linux 版' }

export function emptyState() {
  return { v: STATE_VERSION, done: {}, pending: {}, inflight: null, seeded: false, since: null, seedNoticed: false, pausedNoticed: false }
}

function ms(t) {
  return t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t)
}
const iso = (t) => new Date(ms(t)).toISOString()

function clone(state) {
  const s = state && typeof state === 'object' ? state : {}
  return {
    v: STATE_VERSION,
    done: { ...(s.done || {}) },
    pending: { ...(s.pending || {}) },
    inflight: s.inflight ? { ...s.inflight } : null,
    seeded: s.seeded === true,
    since: s.since && PLATFORMS.every(p => isVersion(s.since[p])) ? { desktop: s.since.desktop, linux: s.since.linux } : null,
    seedNoticed: s.seedNoticed === true,
    pausedNoticed: s.pausedNoticed === true,
  }
}

// 版號依數字逐段比較（0.2.10 > 0.2.9）
export function compareVersions(a, b) {
  if (!isVersion(a) || !isVersion(b)) throw new Error(`版號格式不對（要是 數字.數字.數字）：${JSON.stringify(a)}、${JSON.stringify(b)}`)
  const pa = String(a).split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

const keyOf = (platform, version) => `${platform}@${version}`
const wait = (state, reason) => ({ action: 'wait', reason, state })

function maxDoneVersion(done, platform) {
  let max = null
  for (const k of Object.keys(done)) {
    const [p, v] = k.split('@')
    if (p === platform && isVersion(v) && (max === null || compareVersions(v, max) > 0)) max = v
  }
  return max
}

function startStep(state, step, key, info, now) {
  const next = clone(state)
  next.inflight = { key, step, startedAt: iso(now), pid: null, platform: info.platform, tag: info.tag, runId: info.runId }
  return { action: step, key, platform: info.platform, tag: info.tag, runId: info.runId, state: next }
}

function finishAsDone(state, key, result, runId, now, message) {
  const next = clone(state)
  if (!next.done[key]) next.done[key] = { result, at: iso(now), runId: runId ?? null }
  delete next.pending[key]
  next.inflight = null
  return { action: 'report', key, result, message, state: next }
}

// 播種：首次啟動時，把 since 以下（含）的版本視為已處理，只處理比 since 新的版本。
// 已播種過、或 done／pending／inflight 已有內容就拒絕（回 { ok: false, reason }）。
// 「state 不存在但看得出曾經跑過」要由常駐程式那層（鎖檔、log）判斷，這裡不知道。
export function seed(state, { since, now } = {}) {
  const st = clone(state)
  if (st.seeded) return { ok: false, reason: '已經播種過，不可重複播種', state: st }
  if (Object.keys(st.done).length || Object.keys(st.pending).length || st.inflight) {
    return { ok: false, reason: 'state 已有處理紀錄，不可播種', state: st }
  }
  for (const p of PLATFORMS) {
    if (!since || !isVersion(since[p])) {
      return { ok: false, reason: `播種版號格式不對或缺少：${p}`, state: st }
    }
  }
  for (const p of PLATFORMS) st.done[keyOf(p, since[p])] = { result: 'seeded', at: iso(now), runId: null }
  st.seeded = true
  st.since = { desktop: since.desktop, linux: since.linux }
  return { ok: true, state: st }
}

// 人工清除一筆失敗：標記已確認，清除後才恢復處理新版。
export function acknowledge(state, key, now) {
  const st = clone(state)
  if (!st.done[key]) throw new Error(`找不到這筆紀錄：${key}`)
  if (!FAILURES.has(st.done[key].result)) throw new Error(`${key} 的結果是 ${st.done[key].result}，不是失敗類，不可清除`)
  if (!st.done[key].ackedAt) st.done[key] = { ...st.done[key], ackedAt: iso(now) }
  if (!unackedFailureVersion(st)) st.pausedNoticed = false
  return st
}

// 沒被人工清除的失敗中，最小的版號（沒有則 null）
function unackedFailureVersion(st) {
  let min = null
  for (const [k, v] of Object.entries(st.done)) {
    if (!FAILURES.has(v.result) || v.ackedAt) continue
    const ver = k.split('@')[1]
    if (!isVersion(ver)) continue
    if (min === null || compareVersions(ver, min) < 0) min = ver
  }
  return min
}

export function decide(args) {
  const notes = []
  const out = decideInner(args, notes)
  return { ...out, notes }
}

function decideInner({ runs = [], state, now }, notes) {
  const st = clone(state)
  const t = ms(now)

  // 播種要有合法的起點（state.since）才算數：seeded:true 卻沒有 since（手改過、寫到一半），當成沒播種，
  // 否則會從最舊的綠燈 run 開始重發舊版（調查員 #4562 實測會發 desktop@0.2.40；領隊 #4563 定做法）
  if (!st.seeded || !st.since) {
    if (st.seedNoticed) return wait(st, '尚未播種')
    st.seedNoticed = true
    return { action: 'report', key: null, result: 'unseeded', state: st,
      message: '自動發佈還沒有播種（不知道哪些舊版已經處理過），不會做任何發佈。請先指定起點版號（例如 --since 0.2.44）播種。' }
  }

  // 重入保護：上一輪子程序還在跑（或程式中途當掉），不准開始別的事
  if (st.inflight) {
    const started = ms(st.inflight.startedAt)
    if (Number.isFinite(started) && t - started <= STALE_MS) return wait(st, '上一輪還在執行')
    const inf = st.inflight
    const name = PLATFORM_NAME[inf.platform] || inf.key
    return finishAsDone(st, inf.key, 'stale', inf.runId, now,
      `${inf.key}：上一次的${inf.step === 'publish' ? '正式發佈' : '試跑'}已超過 2 小時沒有結果，可能中途中斷。` +
      `${name}不會自動重跑，請人工確認簽章與發佈狀況。`)
  }

  // 有沒人工清除的失敗：比失敗版本更新的版本一律不處理（兩個平台都停）
  const failVer = unackedFailureVersion(st)
  let heldBack = false

  // 試跑已過、待正式的優先處理（電腦版優先於 Linux）
  for (const p of PLATFORMS) {
    for (const key of Object.keys(st.pending)) {
      if (key.startsWith(p + '@') && !st.done[key]) {
        const pv = key.split('@')[1]
        if (failVer !== null && isVersion(pv) && compareVersions(pv, failVer) > 0) { heldBack = true; continue }
        return startStep(st, 'publish', key, st.pending[key], now)
      }
    }
  }

  for (const platform of PLATFORMS) {
    // 起點與 done 取大：done 被手改清空也不會回頭發 since 以前的版本（#4563）
    const fromDone = maxDoneVersion(st.done, platform)
    const maxDone = fromDone === null || compareVersions(st.since[platform], fromDone) > 0 ? st.since[platform] : fromDone
    // 每個版號取 createdAt 最新的 run；舊版本與已處理的不理
    const latest = new Map()
    for (const r of runs) {
      if (r.platform !== platform || !r.version) continue
      if (!isVersion(r.version)) {
        const note = `略過格式不對的版號：${JSON.stringify(r.version)}（run ${r.runId ?? '?'}）`
        if (!notes.includes(note)) notes.push(note)
        continue
      }
      if (failVer !== null && compareVersions(r.version, failVer) > 0) {
        if (!st.done[keyOf(platform, r.version)]) heldBack = true
        continue
      }
      if (maxDone !== null && compareVersions(r.version, maxDone) <= 0) continue
      if (st.done[keyOf(platform, r.version)]) continue
      const cur = latest.get(r.version)
      if (!cur || ms(r.createdAt) > ms(cur.createdAt)) latest.set(r.version, r)
    }
    if (!latest.size) continue
    // 每個平台只看最小的待處理版號；它沒跑完就整個平台等
    const version = [...latest.keys()].sort(compareVersions)[0]
    const run = latest.get(version)
    const key = keyOf(platform, version)

    // Linux 一定要等同版電腦版發完；電腦版沒發成就不自動跑
    if (platform === 'linux') {
      const dk = keyOf('desktop', version)
      const d = st.done[dk]
      if (!d) continue
      if (d.result !== 'published') {
        return finishAsDone(st, key, 'blocked', run.runId, now,
          `${key}：電腦版（${dk}）沒發成（${d.result}），Linux 等人工處理，不會自動發佈。`)
      }
    }

    if (run.status !== 'completed') continue
    if (run.conclusion !== 'success') {
      return finishAsDone(st, key, 'ci-failed', run.runId, now,
        `${key}：打包流程沒有成功（${run.conclusion || '未知'}），run ${run.runId}。這一版不會自動發佈，請人工處理。`)
    }
    return startStep(st, 'dryRun', key, { platform, tag: run.tag, runId: run.runId }, now)
  }
  if (heldBack) {
    if (st.pausedNoticed) return wait(st, '有未處理的失敗，暫停中')
    st.pausedNoticed = true
    return { action: 'report', key: null, result: 'paused', state: st,
      message: '有未處理的失敗，暫停自動發佈（電腦版、Linux 版都停），人工處理後清除（acknowledge）才會恢復。' }
  }
  return wait(st, '沒有可做的事')
}

// 子程序跑完後更新 state；report 失敗才有，成功不給（完成訊息由 local_sign_publish 自己貼）
export function applyResult(state, { key, step, ok, detail, now }) {
  const next = clone(state)
  const info = (next.inflight && next.inflight.key === key ? next.inflight : null) || next.pending[key] || {}
  if (next.done[key]) {
    // 已有結果的 key 不覆寫；只收掉這次的執行中／待辦標記
    if (next.inflight && next.inflight.key === key) next.inflight = null
    delete next.pending[key]
    return { state: next, report: null, log: `${key} 已經有結果（${next.done[key].result}），這次的結果（${ok ? '成功' : '失敗'}）不覆寫。` }
  }
  next.inflight = null
  if (step === 'dryRun' && ok) {
    next.pending[key] = { platform: info.platform, tag: info.tag, runId: info.runId, at: iso(now) }
    return { state: next, report: null }
  }
  delete next.pending[key]
  if (ok) {
    next.done[key] = { result: 'published', at: iso(now), runId: info.runId ?? null }
    return { state: next, report: null }
  }
  const result = step === 'dryRun' ? 'dryrun-failed' : 'publish-failed'
  next.done[key] = { result, at: iso(now), runId: info.runId ?? null }
  const what = step === 'dryRun' ? '試跑（dry-run）失敗，沒有正式發佈' : '正式發佈失敗'
  return { state: next, report: `${key}：${what}${detail ? `：${detail}` : ''}。不會自動重試，請人工處理。` }
}
