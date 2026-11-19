// #1800：夥伴操作的進度不再用「只有一顆『先關掉（照常進行）』」的框。
// 進行中就地顯示、成功自己消失、失敗在原位講白話並附「重試」、有時間上限；手機與電腦共用同一份元件與文字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createOpRunner, runPartnerOp } from '../ui/lib/partner-ops-ui.mjs'
import { OP_DONE_HIDE_MS, OP_GIVE_UP_MS, OP_PROGRESS_TEXT } from '../ui/lib/partner-ops.mjs'
import { runBanner } from '../ui/lib/mobile-ops.mjs'

const root = new URL('../', import.meta.url)
const read = f => fs.readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n')
const F = (node, agent) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', engine: 'claude', device: '設備' })

function walk(dir, out = []) {
  for (const e of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) { if (!/vendor|node_modules/.test(e.name)) walk(rel + '/', out) } else if (/\.(mjs|js|html)$/.test(e.name)) out.push(rel)
  }
  return out
}

// 假的後台：rows 依序回給輪詢；fail 讓送出本身失敗
function fakeApi(rows, { fail = null } = {}) {
  let i = 0
  return {
    partnerOp: async () => { if (fail) throw new Error(fail); return { id: 'op-1' } },
    partnerOps: async () => { const r = rows[Math.min(i++, rows.length - 1)]; return { ops: r ? [{ id: 'op-1', ...r }] : [] } },
  }
}
const clock = () => { let t = 1_000_000; return { now: () => t, sleep: async ms => { t += ms } } }

test('#1800 守門：ui 裡不能再有「先關掉（照常進行）」這類只有一顆按鈕的進度框文案', () => {
  const bad = walk('ui/').filter(f => /先關掉（照常進行）/.test(read(f)))
  assert.deepEqual(bad, [])
})

test('#1800 進行中：對話框收起、進度掛在那位夥伴上；成功幾秒後自己消失；沒有任何擋畫面的框', async () => {
  const state = { runs: {} }
  const seen = []
  const timers = []
  const c = clock()
  const api = fakeApi([{ status: 'pending' }, { status: 'taken' }, { status: 'ok' }])
  const runner = createOpRunner({
    api, state,
    run: (a, f, op, input, o) => runPartnerOp(a, f, op, input, { ...o, ...c, pollMs: 3000, onUpdate: v => { seen.push(v.phase); o.onUpdate(v) } }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
  })
  const f = F('H', '小文')
  const p = runner.start(f, 'close', {})
  assert.equal(state.runs[f.id].view.done, false, '送出當下就有進行中的就地進度')
  assert.equal(runBanner(state.runs[f.id]).retry, false)
  await p
  assert.ok(seen.includes('working') || seen.includes('sent'))
  assert.equal(state.runs[f.id].view.phase, 'done', '成功先顯示結果')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, OP_DONE_HIDE_MS, '短暫顯示後自己消失')
  timers[0].fn()
  assert.deepEqual(state.runs, {}, '時間一到就消失，不用按任何鍵')
})

test('#1800 失敗：原位白話說明＋可行動作「重試」；重試用同樣的內容再送；原文進 log 不上畫面', async () => {
  const logs = []
  const orig = console.info
  console.info = (...a) => logs.push(a.join(' '))
  try {
    const state = { runs: {} }
    const calls = []
    const c = clock()
    const api = { partnerOp: async b => { calls.push(b); throw new Error('partner_op HTTP 409 busy') }, partnerOps: async () => ({ ops: [] }) }
    const runner = createOpRunner({ api, state, run: (a, f, op, input, o) => runPartnerOp(a, f, op, input, { ...o, ...c }), setTimer: () => 0, clearTimer: () => {} })
    const f = F('H', '小文')
    await runner.start(f, 'rename', { newName: '新名' })
    const b = runBanner(state.runs[f.id])
    assert.equal(b.phase, 'failed')
    assert.equal(b.retry, true, '失敗要有重試')
    assert.equal(b.hideMs, 0, '失敗不會自己消失')
    assert.doesNotMatch(b.text, /HTTP|409|partner_op/, '畫面不放原文')
    assert.ok(logs.some(l => /409 busy/.test(l)), '原文寫進 log')
    await runner.retry(f.id)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].new_name ?? calls[1].newName ?? calls[1].name, calls[0].new_name ?? calls[0].newName ?? calls[0].name)
    assert.deepEqual(calls[1], calls[0], '重試送一樣的內容')
    runner.dismiss(f.id)
    assert.deepEqual(state.runs, {})
  } finally { console.info = orig }
})

test('#1800 逾時：一直沒人接手也有上限，變成失敗並附重試，不會永遠停在「正在…」', async () => {
  const state = { runs: {} }
  const c = clock()
  const api = fakeApi([{ status: 'pending' }])
  const runner = createOpRunner({ api, state, run: (a, f, op, input, o) => runPartnerOp(a, f, op, input, { ...o, ...c, pollMs: 3000 }), setTimer: () => 0, clearTimer: () => {} })
  const f = F('H', '小文')
  const v = await runner.start(f, 'close', {})
  assert.equal(v.phase, 'failed')
  assert.ok(c.now() - 1_000_000 > OP_GIVE_UP_MS, '等超過上限才放棄')
  const b = runBanner(state.runs[f.id])
  assert.equal(b.retry, true)
})

test('#1800 同一位連按：只認最後一次，前一次的進度不會蓋掉新的', async () => {
  const state = { runs: {} }
  const gate = []
  const run = (a, f, op, input, o) => new Promise(res => { gate.push(() => { o.onUpdate({ phase: 'done', done: true, text: op }); res({ phase: 'done', done: true, text: op }) }) })
  const runner = createOpRunner({ api: {}, state, run, setTimer: () => 0, clearTimer: () => {} })
  const f = F('H', '小文')
  const p1 = runner.start(f, 'restart', {})
  const p2 = runner.start(f, 'close', {})
  gate[0](); gate[1]()
  await Promise.all([p1, p2])
  assert.equal(state.runs[f.id].op, 'close')
})

test('#1800 電腦版：非詳情的操作送出後對話框收起（發 run 事件），進度由提示列顯示；不再有進度版面', () => {
  const ui = read('ui/lib/partner-ops-ui.mjs')
  assert.match(ui, /if \(props\.op !== 'info'\) \{[^\n]*emit\('run'[^\n]*emit\('close'\)/)
  const list = read('ui/list.html'), bar = read('ui/lib/actionbar.mjs')
  assert.match(list, /<partner-op-strip /); assert.match(list, /@run="onOpRun"/)
  assert.match(bar, /<partner-op-strip /); assert.match(bar, /@run="onOpRun"/)
})

test('#1800 手機與電腦共用同一份元件與文字：按鈕字只來自 OP_PROGRESS_TEXT', () => {
  const ui = read('ui/lib/partner-ops-ui.mjs'), html = read('ui/m.html'), js = read('ui/m.js'), mob = read('ui/lib/mobile-ops.mjs')
  assert.deepEqual(Object.keys(OP_PROGRESS_TEXT).sort(), ['close', 'dismiss', 'launchNew', 'retry'])
  for (const [name, src] of [['電腦元件', ui], ['手機頁面', html]]) {
    assert.match(src, /OP_PROGRESS_TEXT\.retry|T\.retry/, `${name}的重試用共用文字`)
    assert.match(src, /OP_PROGRESS_TEXT\.close|T\.close/, `${name}的「關閉」用共用文字`)
    assert.doesNotMatch(src, />\s*知道了\s*</, `${name}沒有只有「知道了」的按鈕`)
  }
  assert.match(js, /OP_PROGRESS_TEXT/)
  // 進度的狀態（重試、幾秒後消失）只有一份實作：runBanner／hideAfterMs 在 mobile-ops.mjs，兩邊都從那裡取
  assert.match(mob, /export const hideAfterMs/)
  assert.match(ui, /from '\.\/mobile-ops\.mjs'/); assert.match(js, /hideAfterMs/)
  assert.doesNotMatch(ui + js, /OP_DONE_HIDE_MS|6000\) *\/\/ 成功/, '消失時間不在兩邊各寫一份')
})

// 擁有者 11-19 補充：還要留框的地方（換班接手、開新夥伴的進度），右下角按鈕只寫「關閉」，不加括號說明
test('#1800 留框的進度：按鈕文字只能是「關閉」，不能有全形括號', () => {
  for (const [k, v] of Object.entries(OP_PROGRESS_TEXT)) assert.doesNotMatch(v, /[（）]/, `OP_PROGRESS_TEXT.${k} 不能有括號`)
  assert.equal(OP_PROGRESS_TEXT.close, '關閉'); assert.equal(OP_PROGRESS_TEXT.dismiss, '關閉')
  const ui = read('ui/lib/partner-ops-ui.mjs'), html = read('ui/m.html')
  assert.match(ui, /@click="close">\{\{ T\.close \}\}</)
  assert.match(html, /@click="back">\{\{ OP_PROGRESS_TEXT\.close \}\}</)
  assert.match(html, /@click="closeLaunch">\{\{ OP_PROGRESS_TEXT\.close \}\}</)
  const bad = walk('ui/').filter(f => /先關閉（|先關掉（|不查了/.test(read(f)))
  assert.deepEqual(bad, [])
})
