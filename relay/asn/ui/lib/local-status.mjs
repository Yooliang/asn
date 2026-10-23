// 本機視窗直接讀：名單上「這台電腦」的夥伴，狀態以本機現讀的為準（不繞後台，沒有回報與重拉的延遲）。
// 純函式，瀏覽器與 node 都能跑。locals＝Rust 命令 local_windows 的回傳 [{ name, status, detail, context_pct }]。
import { psmOf, statusOf } from './roster.mjs'

/**
 * 把本機現讀的狀態蓋到 friends 上，回傳新的 Map；沒有任何變動回 null（呼叫端就不用重畫）。
 * 只動：節點是自己、後台名單上在線（不是離線）、本機也找得到同名視窗的好友的 status／psm／contextPct。
 * cwdOf：好友 id → 資料夾標籤（後台名單給的），用來重組個人訊息；沒有就只剩說明。
 */
export function overlayLocal(friends, selfNode, locals, cwdOf = new Map()) {
  if (!Array.isArray(locals) || !locals.length || !selfNode) return null
  const byName = new Map()
  for (const w of locals) if (w && typeof w.name === 'string' && w.name) byName.set(w.name, w)
  let next = null
  for (const [id, f] of friends) {
    if (f.node !== selfNode || f.status === 'offline' || f.panel) continue
    const w = byName.get(f.agent ?? f.nick)
    if (!w) continue
    const status = statusOf(w.status)
    const psm = psmOf({ cwd_label: cwdOf.get(id) ?? '', detail: w.detail })
    const pct = Number.isFinite(w.context_pct) && w.context_pct >= 0 && w.context_pct <= 100 ? Math.round(w.context_pct) : f.contextPct ?? null
    const psmNext = cwdOf.has(id) || w.detail ? psm : f.psm
    if (status === f.status && psmNext === f.psm && pct === (f.contextPct ?? null)) continue
    next ??= new Map(friends)
    next.set(id, { ...f, status, psm: psmNext, contextPct: pct })
  }
  return next
}

/** 合併頻繁觸發：minGapMs 內再觸發的合併成一次（留一個尾巴補跑），避免門鈴連響時狂拉名單 */
export function coalesced(run, minGapMs, { now = () => Date.now(), setT = setTimeout } = {}) {
  let last = -Infinity
  let timer = null
  let running = false
  let again = false
  const fire = async () => {
    timer = null
    last = now()
    running = true
    try { await run() } finally { running = false }
    if (again) { again = false; trigger() }   // 執行中又有人敲：跑完再補一次，不漏掉最新狀態
  }
  const trigger = () => {
    if (running) { again = true; return }
    if (timer) return
    const wait = Math.max(0, last + minGapMs - now())
    if (wait === 0) void fire()
    else timer = setT(fire, wait)
  }
  return trigger
}
