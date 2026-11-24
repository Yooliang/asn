// #1788 放大鈕的分割版面：回報位置給 Rust、接收 Rust 的滑過／按下通知
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSnapMax, snapArgs, snapClasses } from '../ui/lib/snap-max.mjs'

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
  // 回 HTMAXBUTTON 的程式碼（不含註解）只能出現在 snap_hit.rs（判斷）與 snap_win.rs（最上層視窗程序）
  const hits = files.filter(u => u.pathname.endsWith('.rs') && /HT_?MAXBUTTON/.test(codeOnly(fs.readFileSync(u, 'utf8'))))
  assert.deepEqual(hits.map(u => u.pathname.split('/').pop()).sort(), ['snap_hit.rs', 'snap_win.rs'])
  const rd = p => fs.readFileSync(new URL(`../src-tauri/src/${p}`, import.meta.url), 'utf8')
  assert.ok(codeOnly(rd('snap_max/snap_cover_win.rs')).includes('HTTRANSPARENT'), '透明子視窗要回 HTTRANSPARENT')
  assert.ok(!/HT_?MAXBUTTON/.test(codeOnly(rd('snap_max/snap_cover_win.rs'))), '透明子視窗不能自己回放大鈕')
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
