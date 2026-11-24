// 回報匯流排的前端訂閱（#2161 2c-2）：subscribe(kind, node, cb)。
// 純邏輯：不碰畫面、不直接碰 Tauri，所有依賴由參數注入（api＝{ get(kind, nodes) }、onReport＝門鈴監聽，回傳取消函式）。
// 規則：
//  - 門鈴（回報事件）只帶 { kind, node }、不帶內容；收到後同一個 kind 先等 DEBOUNCE_MS（最長 MAXWAIT_MS）合併，再用一次 api.get(kind, nodes) 批次讀
//  - 同一個 kind 同時只有一個在途請求；在途時新來的節點排進下一批；一批最多 BATCH_MAX 個，超過就切批、批間序列
//  - 只有 changed_at 比上次讀到的新才通知訂閱者（保活只更新 updated_at，不重複通知）
//  - 後援：回到前景時對所有有訂閱者的 kind 讀一次；之後每 POLL_MS（5 分鐘）讀一次（只在可見時）
//  - 讀失敗不丟給訂閱者，只記一次 console.warn（kind 與連續次數，不含內容）；失敗後至少等 FAIL_WAIT_MS 才再試
//  - 沒有訂閱者的 kind 不讀；取消訂閱到零就停該 kind；全部取消就停後援
export const DEBOUNCE_MS = 300
export const MAXWAIT_MS = 1000
export const BATCH_MAX = 50
export const POLL_MS = 5 * 60 * 1000
export const FAIL_WAIT_MS = 5000
export const WARN_AT = new Set([1, 5, 20])   // 同一 kind 連續失敗，只在這幾次記一行 warn

// changed_at 是否比 prev 新：兩邊都是數字就比數字，否則比時間，再不行比字串
export function isNewer(cur, prev) {
  if (prev === undefined || prev === null) return true
  if (cur === undefined || cur === null) return false
  if (typeof cur === 'number' && typeof prev === 'number') return cur > prev
  const a = Date.parse(cur), b = Date.parse(prev)
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b
  return String(cur) > String(prev)
}

const docVisible = () => !globalThis.document || globalThis.document.visibilityState === 'visible'
const docWatch = cb => {
  const d = globalThis.document
  if (!d?.addEventListener) return () => {}
  const f = () => { if (d.visibilityState === 'visible') cb() }
  d.addEventListener('visibilitychange', f)
  return () => d.removeEventListener('visibilitychange', f)
}

export function createReportBus({
  api, onReport, now = () => Date.now(),
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id),
  isVisible = docVisible, onVisible = docWatch,
} = {}) {
  const kinds = new Map()   // kind -> { subs: Map<node, Set<cb>>, last: Map<node, report>, pending: Set, timer, firstAt, inflight, failUntil, fails }
  let pollTimer = null
  let disposed = false

  const stateOf = kind => kinds.get(kind)
  const clearKindTimer = st => { if (st.timer !== null) { clearTimer(st.timer); st.timer = null } }

  // 排一次讀取：第一個要求開始計時，之後每來一個重新等 DEBOUNCE_MS，但從第一個算起不超過 MAXWAIT_MS；失敗後的等待期內延到期滿
  function schedule(kind) {
    const st = stateOf(kind)
    if (!st || disposed || st.pending.size === 0) return
    if (st.inflight) return   // 在途：回來後再排下一批
    const t = now()
    if (st.timer === null) st.firstAt = t
    else clearKindTimer(st)
    let delay = Math.max(0, Math.min(DEBOUNCE_MS, MAXWAIT_MS - (t - st.firstAt)))
    if (st.failUntil > t) delay = Math.max(delay, st.failUntil - t)
    st.timer = setTimer(() => { st.timer = null; void flush(kind) }, delay)
  }

  function request(kind, node) {
    const st = stateOf(kind)
    if (!st || disposed) return
    st.pending.add(node)
    schedule(kind)
  }

  function deliver(st, r) {
    const set = st.subs.get(r?.node)
    if (!set || set.size === 0) return
    const prev = st.last.get(r.node)
    if (prev && !isNewer(r.changed_at, prev.changed_at)) return
    const rep = { node: r.node, kind: r.kind, payload: r.payload, updated_at: r.updated_at, changed_at: r.changed_at }
    st.last.set(r.node, rep)
    for (const cb of [...set]) { try { cb(rep) } catch (e) { console.warn('[ASN]', `回報訂閱者處理失敗：${r.kind ?? ''}`) } }
  }

  async function flush(kind) {
    const st = stateOf(kind)
    if (!st || disposed || st.inflight) return
    const nodes = [...st.pending].filter(n => st.subs.has(n))
    st.pending.clear()
    if (nodes.length === 0) return
    st.inflight = true
    let i = 0
    try {
      for (; i < nodes.length; i += BATCH_MAX) {
        const chunk = nodes.slice(i, i + BATCH_MAX)
        const res = await api.get(kind, chunk)
        if (disposed || stateOf(kind) !== st) return
        if (!res || res.ok !== true || !Array.isArray(res.reports)) throw new Error('bad-response')
        for (const r of res.reports) deliver(st, r)
      }
      st.fails = 0
    } catch {
      if (disposed || stateOf(kind) !== st) return
      st.fails++
      st.failUntil = now() + FAIL_WAIT_MS
      if (WARN_AT.has(st.fails)) console.warn('[ASN]', `回報讀取失敗：${kind}（連續第 ${st.fails} 次），稍後再試`)   // 只在第 1、5、20 次記，避免洗 console
      for (const n of nodes.slice(i)) st.pending.add(n)   // 沒讀到的下一輪再讀
    } finally {
      if (stateOf(kind) === st) { st.inflight = false; if (!disposed) schedule(kind) }
    }
  }

  const refreshKind = kind => { const st = stateOf(kind); if (st) for (const n of st.subs.keys()) request(kind, n) }
  const refreshAll = () => { if (disposed) return; for (const k of [...kinds.keys()]) refreshKind(k) }

  function armPoll() {
    if (pollTimer !== null || disposed) return
    pollTimer = setTimer(() => {
      pollTimer = null
      if (disposed || kinds.size === 0) return
      armPoll()
      if (isVisible()) refreshAll()
    }, POLL_MS)
  }
  function disarmPoll() { if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null } }

  const offBell = onReport(ev => {
    if (disposed || !ev) return
    const st = stateOf(ev.kind)
    if (st && st.subs.has(ev.node)) request(ev.kind, ev.node)
  })
  const offVisible = onVisible(() => { if (!disposed && isVisible()) refreshAll() })

  function subscribe(kind, node, cb) {
    if (disposed || typeof cb !== 'function') return () => {}
    let st = stateOf(kind)
    if (!st) { st = { subs: new Map(), last: new Map(), pending: new Set(), timer: null, firstAt: 0, inflight: false, failUntil: 0, fails: 0 }; kinds.set(kind, st) }
    let set = st.subs.get(node)
    if (!set) { set = new Set(); st.subs.set(node, set) }
    set.add(cb)
    armPoll()
    const cached = st.last.get(node)
    if (cached) { try { cb(cached) } catch { /* 訂閱者自己的錯不影響匯流排 */ } }   // 已經讀過的：後來的訂閱者馬上拿到目前值
    request(kind, node)   // 訂閱時讀一次最新值（走合併）
    let done = false
    return () => { if (!done) { done = true; unsubscribe(kind, node, cb) } }
  }

  function unsubscribe(kind, node, cb) {
    const st = stateOf(kind)
    if (!st) return
    const set = st.subs.get(node)
    if (set) {
      set.delete(cb)
      if (set.size === 0) { st.subs.delete(node); st.last.delete(node); st.pending.delete(node) }
    }
    if (st.subs.size === 0) {
      clearKindTimer(st)
      kinds.delete(kind)
      if (kinds.size === 0) disarmPoll()
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const st of kinds.values()) clearKindTimer(st)
    kinds.clear()
    disarmPoll()
    try { offBell?.() } catch {}
    try { offVisible?.() } catch {}
  }

  return { subscribe, unsubscribe, refresh: kind => { if (!disposed) refreshKind(kind) }, dispose }
}
