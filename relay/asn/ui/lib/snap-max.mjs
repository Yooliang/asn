// #1788 自畫的放大鈕要有 Windows 11 分割版面：把放大鈕的位置回報給 Rust（它在鈕上蓋一塊透明子視窗回 HTMAXBUTTON），
// 並接收 Rust 轉來的滑過／按下，換鈕的樣式（子視窗蓋住之後，網頁收不到這一塊的滑鼠）。
// 沒有放大鈕的視窗（登入、導覽）、原生外框（鈕被藏起來）、非 Windows（Rust 端什麼都不做）都不會有副作用。
export const SNAP_SELECTOR = '.t-btns .tb[data-snap-max]'
export const SNAP_EVENT = 'asn:snap-max'
const CLASS_OF = { hover: ['snap-hover'], down: ['snap-hover', 'snap-down'], leave: [] }

// 量到的矩形 → 指令參數；量不到、被藏起來（寬高為 0）、數字壞掉都回 null＝該清掉
export function snapArgs(rect, dpr) {
  if (!rect) return null
  const { x, y, width: w, height: h } = rect
  const nums = [x, y, w, h, dpr]
  if (!nums.every(Number.isFinite) || w <= 0 || h <= 0 || dpr <= 0) return null
  return { x, y, w, h, dpr }
}
// 同樣的參數不重複呼叫
const same = (a, b) => (a === b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.dpr === b.dpr)
// Rust 通知 → 要加的樣式（不認得的當作清掉）
export const snapClasses = name => CLASS_OF[name] ?? CLASS_OF.leave

export function makeSnapMax({ call, listen, doc, win, raf = f => win.requestAnimationFrame(f) }) {
  let last = null, queued = false, observed = null
  const btn = () => doc.querySelector(SNAP_SELECTOR)
  const paint = name => {
    const b = btn()
    if (!b) return
    b.classList.remove('snap-hover', 'snap-down')
    for (const c of snapClasses(name)) b.classList.add(c)
  }
  const push = async () => {
    queued = false
    const b = btn()
    const args = b ? snapArgs(b.getBoundingClientRect(), win.devicePixelRatio || 1) : null
    if (same(args, last)) return
    const was = last
    last = args
    try {
      if (args) await call('snap_max_set', args)
      else if (was) { paint('leave'); await call('snap_max_clear') }
    } catch { last = null /* 失敗下次再試；Rust 端已記 log */ }
  }
  const schedule = () => { if (!queued) { queued = true; raf(push) } }
  // 切回原生外框（Aero）：鈕還沒被藏起來之前就同步清掉，免得原生標題區被誤判成放大鈕
  const clearNow = async () => {
    const was = last
    last = null
    paint('leave')
    if (!was) return
    try { await call('snap_max_clear') } catch { last = was /* 失敗下次再試 */ }
  }
  const onFrame = native => {
    if (native === true) clearNow()
    win.setTimeout(watch, 50)
  }
  const watch = () => {
    const b = btn()
    if (b && b !== observed && win.ResizeObserver) { observed = b; new win.ResizeObserver(schedule).observe(b) }
    schedule()
  }
  return {
    push, schedule, paint, onFrame, clearNow,
    async start() {
      watch()
      // 畫面是 Vue 掛上去的，鈕晚幾拍才出現；之後靠視窗大小、外觀、外框、縮放變動重新量
      for (const ms of [150, 600, 1500]) win.setTimeout(watch, ms)
      win.addEventListener('resize', schedule)
      new win.MutationObserver(watch).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-skin', 'class'] })
      const dprWatch = () => { win.matchMedia?.(`(resolution: ${win.devicePixelRatio}dppx)`)?.addEventListener?.('change', () => { schedule(); dprWatch() }, { once: true }) }
      dprWatch()
      await listen(SNAP_EVENT, paint)
      await listen('asn:frame', onFrame)
      await listen('asn:skin', () => win.setTimeout(watch, 50))
    },
  }
}
