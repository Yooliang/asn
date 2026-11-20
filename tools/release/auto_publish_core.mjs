// 自動發佈的判斷核心：純函式，不呼叫 gh、不跑子程序、不寫檔。
// state 格式（版本 1）：
//   { v: 1,
//     done:    { '平台@版號': { result, at, runId } },
//     pending: { '平台@版號': { platform, tag, runId, at } },   // 試跑已過、待正式
//     inflight: null | { key, step: 'dryRun'|'publish', startedAt, pid, platform, tag, runId } }
// result 取值：published / ci-failed / dryrun-failed / publish-failed / stale / blocked

export const STATE_VERSION = 1
export const STALE_MS = 2 * 60 * 60 * 1000
const PLATFORMS = ['desktop', 'linux']
const PLATFORM_NAME = { desktop: '電腦版', linux: 'Linux 版' }

export function emptyState() {
  return { v: STATE_VERSION, done: {}, pending: {}, inflight: null }
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
  }
}

// 版號依數字逐段比較（0.2.10 > 0.2.9）
export function compareVersions(a, b) {
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
    if (p === platform && (max === null || compareVersions(v, max) > 0)) max = v
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
  next.done[key] = { result, at: iso(now), runId: runId ?? null }
  delete next.pending[key]
  next.inflight = null
  return { action: 'report', key, result, message, state: next }
}

export function decide({ runs = [], state, now }) {
  const st = clone(state)
  const t = ms(now)

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

  // 試跑已過、待正式的優先處理（電腦版優先於 Linux）
  for (const p of PLATFORMS) {
    for (const key of Object.keys(st.pending)) {
      if (key.startsWith(p + '@') && !st.done[key]) {
        return startStep(st, 'publish', key, st.pending[key], now)
      }
    }
  }

  for (const platform of PLATFORMS) {
    const maxDone = maxDoneVersion(st.done, platform)
    // 每個版號取 createdAt 最新的 run；舊版本與已處理的不理
    const latest = new Map()
    for (const r of runs) {
      if (r.platform !== platform || !r.version) continue
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
  return wait(st, '沒有可做的事')
}

// 子程序跑完後更新 state；report 失敗才有，成功不給（完成訊息由 local_sign_publish 自己貼）
export function applyResult(state, { key, step, ok, detail, now }) {
  const next = clone(state)
  const info = (next.inflight && next.inflight.key === key ? next.inflight : null) || next.pending[key] || {}
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
