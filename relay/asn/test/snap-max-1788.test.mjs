// #1788 放大鈕的分割版面：回報位置給 Rust、接收 Rust 的滑過／按下通知
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSnapMax, snapArgs, snapClasses, tipText, tipPos, TIP_DELAY_MS, TIP_GAP, TIP_MARGIN, TIP_CLASS } from '../ui/lib/snap-max.mjs'

const rect = { x: 600, y: 0, width: 46, height: 36 }

test('snapArgs：量得到才回報，壞數字與看不見的鈕回 null', () => {
  assert.deepEqual(snapArgs(rect, 1.5), { x: 600, y: 0, w: 46, h: 36, dpr: 1.5 })
  assert.equal(snapArgs(null, 1), null)
  assert.equal(snapArgs({ ...rect, width: 0 }, 1), null, '被藏起來（原生外框）寬高為 0')
  assert.equal(snapArgs({ ...rect, x: NaN }, 1), null)
  assert.equal(snapArgs(rect, 0), null)
})

test('snapClasses：滑過、按下、離開對應的樣式', () => {
  assert.deepEqual(snapClasses('hover'), ['snap-hover'])
  assert.deepEqual(snapClasses('down'), ['snap-hover', 'snap-down'])
  assert.deepEqual(snapClasses('leave'), [])
  assert.deepEqual(snapClasses('???'), [], '不認得的當作離開，不會卡在按下')
})

function fake(initialRect) {
  const classes = new Set()
  const btn = { classList: { add: c => classes.add(c), remove: (...cs) => cs.forEach(c => classes.delete(c)) }, getBoundingClientRect: () => btn.r, r: initialRect }
  const calls = []
  const doc = { querySelector: () => btn.present === false ? null : btn }
  const win = { devicePixelRatio: 1.25 }
  const sm = makeSnapMax({ call: async (c, a) => { calls.push([c, a]) }, listen: async () => {}, doc, win, raf: f => f() })
  return { btn, classes, calls, sm }
}

test('push：位置回報一次，沒變就不重複呼叫；變了才再報', async () => {
  const { btn, calls, sm } = fake(rect)
  await sm.push(); await sm.push()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['snap_max_set', { x: 600, y: 0, w: 46, h: 36, dpr: 1.25 }])
  btn.r = { ...rect, x: 500 }
  await sm.push()
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1].x, 500)
})

test('push：鈕消失（切原生外框）要清掉，且清掉滑過樣式；從沒回報過就不呼叫', async () => {
  const { btn, classes, calls, sm } = fake(rect)
  btn.r = { ...rect, width: 0, height: 0 }
  await sm.push()
  assert.equal(calls.length, 0, '從沒報過不用清')
  btn.r = rect
  await sm.push()
  sm.paint('down')
  assert.ok(classes.has('snap-down'))
  btn.r = { ...rect, width: 0, height: 0 }
  await sm.push()
  assert.equal(calls.at(-1)[0], 'snap_max_clear')
  assert.equal(classes.size, 0)
})

test('paint：按下→滑過→離開，樣式跟著換、不殘留', () => {
  const { classes, sm } = fake(rect)
  sm.paint('down')
  assert.deepEqual([...classes].sort(), ['snap-down', 'snap-hover'])
  sm.paint('hover')
  assert.deepEqual([...classes], ['snap-hover'])
  sm.paint('leave')
  assert.equal(classes.size, 0)
})

test('push：Rust 呼叫失敗後下次會重試（不會以為已經報過）', async () => {
  let fail = true
  const calls = []
  const btn = { classList: { add() {}, remove() {} }, getBoundingClientRect: () => rect }
  const sm = makeSnapMax({ call: async c => { calls.push(c); if (fail) throw new Error('x') }, listen: async () => {}, doc: { querySelector: () => btn }, win: { devicePixelRatio: 1 }, raf: f => f() })
  await sm.push()
  fail = false
  await sm.push()
  assert.equal(calls.length, 2)
})

function walk(fs, dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'target') continue
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
    if (e.isDirectory()) walk(fs, p, out)
    else out.push(p)
  }
  return out
}
const codeOnly = s => s.split('\n').filter(l => !/^\s*\/\/|^\s*\/\*|^\s*\*/.test(l)).map(l => l.replace(/\/\/[^]*$/, '')).join('\n')

test('分割版面只留一種做法：整個 src-tauri/src 與 ui 都沒有 ASN_SNAP_MODE 與做法一的殘留', async () => {
  const fs = await import('node:fs')
  const roots = [new URL('../src-tauri/src/', import.meta.url), new URL('../ui/', import.meta.url)]
  const files = roots.flatMap(r => walk(fs, r)).filter(u => /\.(rs|mjs|js|html|css|json|toml)$/.test(u.pathname))
  assert.ok(files.length > 50, '掃描範圍太小，路徑可能不對')
  for (const u of files) assert.ok(!fs.readFileSync(u, 'utf8').includes('ASN_SNAP_MODE'), `${u.pathname} 還留著 ASN_SNAP_MODE`)
  // 做法一的子視窗檔不能回來；snap_max 資料夾只留這三個檔
  const dir = new URL('../src-tauri/src/snap_max/', import.meta.url)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['snap_cover_win.rs', 'snap_hit.rs', 'snap_win.rs'])
  // 回 HTMAXBUTTON 的程式碼（不含註解）只能出現在 snap_hit.rs（純函式）與 snap_cover_win.rs（蓋板自己的視窗程序）
  const hits = files.filter(u => u.pathname.endsWith('.rs') && /HT_?MAXBUTTON/.test(codeOnly(fs.readFileSync(u, 'utf8'))))
  assert.deepEqual(hits.map(u => u.pathname.split('/').pop()).sort(), ['snap_cover_win.rs', 'snap_hit.rs'])
  const rd = p => fs.readFileSync(new URL(`../src-tauri/src/${p}`, import.meta.url), 'utf8')
  assert.ok(/HT_MAXBUTTON/.test(codeOnly(rd('snap_max/snap_cover_win.rs'))), '蓋板要自己回 HTMAXBUTTON')
  // HTTRANSPARENT 穿透走不通（到不了另一個行程的 WebView2 底下），也不准再掛網頁容器與最上層視窗的命中 subclass
  for (const u of files.filter(u => u.pathname.endsWith('.rs') && u.pathname.includes('snap_max')))
    assert.ok(!/HTTRANSPARENT|WRY_WEBVIEW/.test(codeOnly(fs.readFileSync(u, 'utf8'))), `${u.pathname} 又用回 HTTRANSPARENT／WRY_WEBVIEW 容器 subclass`)
  const cover = codeOnly(rd('snap_max/snap_cover_win.rs'))
  for (const m of ['WM_NCMOUSEMOVE', 'WM_NCMOUSELEAVE', 'WM_NCLBUTTONDOWN', 'WM_NCLBUTTONUP', 'TME_NONCLIENT'])
    assert.ok(cover.includes(m), `蓋板要自己處理 ${m}`)
  assert.ok(!/SetWindowSubclass|top_proc|container_proc/.test(codeOnly(rd('snap_max/snap_win.rs'))), '最上層視窗與網頁容器的命中 subclass 已拿掉')
})

test('每個 unsafe 區塊都有 SAFETY 說明', async () => {
  const fs = await import('node:fs')
  const dir = new URL('../src-tauri/src/snap_max/', import.meta.url)
  let seen = 0
  for (const f of fs.readdirSync(dir)) {
    const lines = fs.readFileSync(new URL(f, dir), 'utf8').split('\n')
    lines.forEach((l, i) => {
      if (/^\s*\/\//.test(l) || !/\bunsafe\b/.test(l)) return
      seen++
      if (/unsafe\s+(extern|fn)/.test(l)) {
        // 函式本身：上方文件註解有 # Safety，或函式內有 SAFETY
        const near = lines.slice(Math.max(0, i - 8), i + 4).join('\n')
        assert.ok(/# Safety|SAFETY:/.test(near), `${f}:${i + 1} unsafe fn 缺 Safety 說明`)
      } else {
        const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        assert.ok(/SAFETY:/.test(near), `${f}:${i + 1} unsafe 區塊缺 // SAFETY:`)
      }
    })
  }
  assert.ok(seen > 20, 'unsafe 數量不對，掃描可能壞了')
})

test('切回原生外框：收到 asn:frame(true) 當下就同步清掉，之後仍照舊 50ms 重量', async () => {
  const calls = [], timers = []
  const btn = { classList: { add() {}, remove() {} }, getBoundingClientRect: () => rect }
  const win = { devicePixelRatio: 1.25, setTimeout: (f, ms) => timers.push([f, ms]) }
  const sm = makeSnapMax({ call: async (c, a) => { calls.push([c, a]) }, listen: async () => {}, doc: { querySelector: () => btn }, win, raf: f => f() })
  await sm.push()
  calls.length = 0
  await sm.onFrame(true)
  assert.deepEqual(calls.map(c => c[0]), ['snap_max_clear'], '同步送出清除')
  assert.deepEqual(timers.map(t => t[1]), [50])
  calls.length = 0
  await sm.onFrame(false)
  assert.equal(calls.length, 0, '切成無框不清除（由重量決定）')
})

test('切回原生外框清除失敗：之後鈕消失時會再清一次，不會以為已清掉', async () => {
  const calls = []
  let fail = true, present = true
  const btn = { classList: { add() {}, remove() {} }, getBoundingClientRect: () => present ? rect : { x: 0, y: 0, width: 0, height: 0 } }
  const sm = makeSnapMax({ call: async c => { calls.push(c); if (c === 'snap_max_clear' && fail) throw new Error('x') }, listen: async () => {}, doc: { querySelector: () => btn }, win: { devicePixelRatio: 1, setTimeout() {} }, raf: f => f() })
  await sm.push()
  await sm.onFrame(true)
  fail = false; present = false
  await sm.push()
  assert.equal(calls.filter(c => c === 'snap_max_clear').length, 2)
})

// ---- #2300 放大鈕的提示文字 ----
const brect = { left: 600, right: 646, top: 0, bottom: 36 }
const VP = { width: 700, height: 500 }
const SIZE = { width: 50, height: 22 }

test('tipText：沒最大化寫「最大化」，已最大化寫「還原」', () => {
  assert.equal(tipText(false), '最大化')
  assert.equal(tipText(true), '還原')
  assert.equal(tipText(undefined), '最大化')
})

test('tipPos：正常時在按鈕正下方置中', () => {
  const p = tipPos({ left: 300, right: 346, top: 0, bottom: 36 }, SIZE, VP)
  assert.deepEqual(p, { left: 323 - 25, top: 36 + TIP_GAP })
})

test('tipPos：靠右邊緣往左挪，不超出視窗', () => {
  const edge = tipPos({ left: 654, right: 700, top: 0, bottom: 36 }, { width: 80, height: 22 }, VP)
  assert.equal(edge.left, VP.width - 80 - TIP_MARGIN, '貼著右邊留邊')
  assert.equal(edge.top, 36 + TIP_GAP)
})

test('tipPos：窄視窗（比提示還窄）貼左、下面放不下改放按鈕上方', () => {
  const p = tipPos({ left: 0, right: 46, top: 0, bottom: 36 }, { width: 80, height: 22 }, { width: 60, height: 500 })
  assert.equal(p.left, TIP_MARGIN, '寬度不夠時至少不超出左邊')
  const low = tipPos({ left: 300, right: 346, top: 470, bottom: 500 }, SIZE, VP)
  assert.equal(low.top, 470 - TIP_GAP - SIZE.height)
  assert.ok(low.top >= TIP_MARGIN)
})

function tipEnv({ maximized = false, w = 700, h = 500, failMax = false } = {}) {
  const timers = new Map(); let id = 0
  const body = { kids: [], appendChild(e) { this.kids.push(e); e.parent = this } }
  const mkEl = () => ({
    style: {}, attrs: {}, className: '', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v },
    getBoundingClientRect() { return { width: 50, height: 22 } },
    remove() { const i = body.kids.indexOf(this); if (i >= 0) body.kids.splice(i, 1) },
  })
  const state = { maximized }
  const btn = { classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ ...brect, x: 600, y: 0, width: 46, height: 36 }) }
  const win = {
    devicePixelRatio: 1, innerWidth: w, innerHeight: h,
    setTimeout: (f, ms) => { timers.set(++id, [f, ms]); return id },
    clearTimeout: i => timers.delete(i),
  }
  const doc = { body, createElement: mkEl, querySelector: () => btn }
  const sm = makeSnapMax({
    call: async () => {}, listen: async () => {}, doc, win, raf: f => f(),
    isMaximized: async () => { if (failMax) throw new Error('x'); return state.maximized },
  })
  const fire = async () => { for (const [i, [f]] of [...timers]) { timers.delete(i); f() } await new Promise(r => setImmediate(r)) }
  return { sm, body, timers, state, fire }
}

test('提示：hover 後要等延遲才出現，不是立刻', async () => {
  const { sm, body, timers } = tipEnv()
  sm.paint('hover')
  assert.equal(body.kids.length, 0, '還沒到時間不能出現')
  assert.equal([...timers.values()][0][1], TIP_DELAY_MS)
})

test('提示：延遲後出現，沒最大化寫「最大化」、在鈕下方、沒超出視窗', async () => {
  const { sm, body, fire } = tipEnv()
  sm.paint('hover'); await fire()
  assert.equal(body.kids.length, 1)
  const t = body.kids[0]
  assert.equal(t.textContent, '最大化')
  assert.equal(t.className, TIP_CLASS)
  assert.equal(t.attrs.role, 'tooltip')
  assert.equal(t.style.top, `${36 + TIP_GAP}px`)
  assert.ok(parseInt(t.style.left) + 50 <= 700 - TIP_MARGIN && parseInt(t.style.left) >= TIP_MARGIN)
  assert.equal(t.style.visibility, 'visible')
})

test('提示：已最大化時寫「還原」', async () => {
  const { sm, body, fire } = tipEnv({ maximized: true })
  sm.paint('hover'); await fire()
  assert.equal(body.kids[0].textContent, '還原')
})

test('提示：文字每次出現都重問視窗狀態（最大化後再 hover 變「還原」）', async () => {
  const { sm, body, fire, state } = tipEnv()
  sm.paint('hover'); await fire()
  assert.equal(body.kids[0].textContent, '最大化')
  sm.paint('leave')
  state.maximized = true
  sm.paint('hover'); await fire()
  assert.equal(body.kids[0].textContent, '還原')
})

test('提示：leave 收掉；down 收掉', async () => {
  const { sm, body, fire } = tipEnv()
  sm.paint('hover'); await fire()
  sm.paint('leave')
  assert.equal(body.kids.length, 0)
  sm.paint('hover'); await fire()
  assert.equal(body.kids.length, 1)
  sm.paint('down')
  assert.equal(body.kids.length, 0)
})

test('提示：延遲期間 leave（或 down）就不會出現', async () => {
  for (const name of ['leave', 'down']) {
    const { sm, body, timers, fire } = tipEnv()
    sm.paint('hover')
    sm.paint(name)
    assert.equal(timers.size, 0, '計時被取消')
    await fire()
    assert.equal(body.kids.length, 0, name)
  }
})

test('提示：問視窗狀態期間（已過延遲）收到 leave 也不會出現', async () => {
  const { sm, body, timers } = tipEnv()
  sm.paint('hover')
  const [f] = [...timers.values()][0]
  timers.clear()
  f()               // 計時到了，開始問狀態（非同步）
  sm.paint('leave') // 問到答案之前離開
  await new Promise(r => setImmediate(r))
  assert.equal(body.kids.length, 0)
})

test('提示：重複 hover 不會疊出兩個', async () => {
  const { sm, body, fire } = tipEnv()
  sm.paint('hover'); sm.paint('hover'); await fire()
  sm.paint('hover'); await fire()
  assert.equal(body.kids.length, 1)
})

test('提示：問不到視窗狀態就不亂寫文字（不出現），也不拋錯', async () => {
  const { sm, body, fire } = tipEnv({ failMax: true })
  const warn = console.warn; console.warn = () => {}
  try { sm.paint('hover'); await fire() } finally { console.warn = warn }
  assert.equal(body.kids.length, 0)
})

test('接線：tauri.mjs 把 Tauri 視窗的 isMaximized 交給 makeSnapMax（不新增 Rust 指令）', async () => {
  const fs = await import('node:fs')
  const src = codeOnly(fs.readFileSync(new URL('../ui/lib/tauri.mjs', import.meta.url), 'utf8'))
  assert.ok(/getCurrentWindow\(\)\.isMaximized\(\)/.test(src), '要用 getCurrentWindow().isMaximized()')
  assert.ok(/makeSnapMax\(\{[^}]*isMaximized[^}]*\}\)/.test(src), 'makeSnapMax 要收到 isMaximized')
  const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
  assert.ok(css.includes(`.${TIP_CLASS}{`) && /\.snap-tip\{[^}]*pointer-events:none/.test(css), '提示不能接滑鼠')
})

test('提示：沒給 isMaximized（舊呼叫）就沒有提示，樣式照舊', () => {
  const { classes, sm } = fake(rect)
  sm.paint('hover')
  assert.ok(classes.has('snap-hover'))
})
