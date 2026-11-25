// #1788 自畫的放大鈕要有 Windows 11 分割版面：把放大鈕的位置回報給 Rust（它在鈕上蓋一塊蓋板子視窗、自己回 HTMAXBUTTON），
// 並接收 Rust 轉來的滑過／按下，換鈕的樣式（蓋板蓋住之後，網頁收不到這一塊的滑鼠）。
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

// ---- 放大鈕的提示文字（#2300）：蓋板蓋住之後網頁收不到滑鼠，title 不會跳出來，所以前端自己畫一個 ----
export const TIP_DELAY_MS = 500   // 跟系統提示一樣，停一下才出現
export const TIP_GAP = 6          // 離按鈕下緣
export const TIP_MARGIN = 4       // 離視窗邊緣
export const TIP_CLASS = 'snap-tip'
// 沒最大化寫「最大化」，已最大化寫「還原」
export const tipText = maximized => (maximized === true ? '還原' : '最大化')
// 提示放在按鈕正下方、水平置中；靠邊放不下就往內挪，不超出視窗（視窗比提示還窄時貼左）
export function tipPos(btnRect, tipSize, viewport) {
  const { left: bl, right: br, bottom: bb, top: bt } = btnRect
  const { width: w, height: h } = tipSize
  const { width: vw, height: vh } = viewport
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))
  const left = clamp(Math.round((bl + br) / 2 - w / 2), TIP_MARGIN, vw - w - TIP_MARGIN)
  let top = bb + TIP_GAP
  if (top + h > vh - TIP_MARGIN) top = bt - TIP_GAP - h   // 下面放不下就放在按鈕上方
  return { left: Math.max(TIP_MARGIN, left), top: Math.max(TIP_MARGIN, top) }
}

// 提示的生命週期：hover 後等 TIP_DELAY_MS 才問視窗狀態並畫出來；leave／down 收掉；等待期間收到 leave 就不會出現
export function makeTip({ doc, win, getBtn, isMaximized, delay = TIP_DELAY_MS }) {
  let timer = null, el = null, seq = 0
  const hide = () => {
    seq++
    if (timer !== null) { win.clearTimeout(timer); timer = null }
    if (el) { el.remove(); el = null }
  }
  const render = async my => {
    let maximized
    try { maximized = await isMaximized() } catch (e) { console.warn('[ASN]', `放大鈕提示：問不到視窗是否最大化 ${e?.message ?? e}`); return }
    const b = getBtn()
    if (my !== seq || !b) return   // 問的時候已經離開或按下
    const t = doc.createElement('div')
    t.className = TIP_CLASS
    t.setAttribute('role', 'tooltip')
    t.textContent = tipText(maximized)
    t.style.visibility = 'hidden'
    doc.body.appendChild(t)
    const r = t.getBoundingClientRect()
    const { left, top } = tipPos(b.getBoundingClientRect(), { width: r.width, height: r.height }, { width: win.innerWidth, height: win.innerHeight })
    t.style.left = `${left}px`
    t.style.top = `${top}px`
    t.style.visibility = 'visible'
    el = t
  }
  const hover = () => {
    if (timer !== null || el) return   // 已在等或已顯示：重複的 hover 不重排
    const my = ++seq
    timer = win.setTimeout(() => { timer = null; void render(my) }, delay)
  }
  return { hover, hide, shown: () => el }
}

export function makeSnapMax({ call, listen, doc, win, raf = f => win.requestAnimationFrame(f), isMaximized = null }) {
  let last = null, queued = false, observed = null
  const btn = () => doc.querySelector(SNAP_SELECTOR)
  // 沒給 isMaximized（測試、舊呼叫）就沒有提示
  const tip = isMaximized ? makeTip({ doc, win, getBtn: btn, isMaximized }) : null
  const paint = name => {
    if (tip) { if (name === 'hover') tip.hover(); else tip.hide() }
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
