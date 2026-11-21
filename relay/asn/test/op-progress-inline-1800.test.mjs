// #1800：夥伴操作的進度不再用「只有一顆『先關掉（照常進行）』」的框。
// 進行中就地顯示、成功自己消失、失敗在原位講白話（#1907：狀態列只有一行字、不放按鈕，失敗留著等下一個操作蓋掉）、有時間上限；手機與電腦共用同一份元件與文字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createOpRunner, makeOpRun, runPartnerOp } from '../ui/lib/partner-ops-ui.mjs'
import { OP_DONE_HIDE_MS, OP_GIVE_UP_MS, OP_PROGRESS_TEXT, OP_UNCONFIRMED_HIDE_MS, progressView } from '../ui/lib/partner-ops.mjs'
import { hideAfterMs, runBanner } from '../ui/lib/mobile-ops.mjs'

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
  assert.equal(runBanner(state.runs[f.id]).hideMs, 0, '進行中不排消失')
  assert.equal(timers.length, 0)
  await p
  assert.ok(seen.includes('working') || seen.includes('sent'))
  assert.equal(state.runs[f.id].view.phase, 'done', '成功先顯示結果')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, OP_DONE_HIDE_MS, '短暫顯示後自己消失')
  assert.equal(OP_DONE_HIDE_MS, 4000)
  timers[0].fn()
  assert.deepEqual(state.runs, {}, '時間一到就消失，不用按任何鍵')
})

test('#1800 失敗：原位一行白話、沒有重試鈕也不自己消失；runner.retry 仍可程式呼叫、用同樣內容再送；下一個結果蓋掉失敗；原文進 log 不上畫面', async () => {
  const logs = []
  const orig = console.info
  console.info = (...a) => logs.push(a.join(' '))
  try {
    const state = { runs: {} }
    const calls = []
    const timers = []
    const c = clock()
    const api = { partnerOp: async b => { calls.push(b); if (calls.length === 1) throw new Error('partner_op HTTP 409 busy'); return { id: 'op-1' } }, partnerOps: async () => ({ ops: [{ id: 'op-1', status: 'ok' }] }) }
    const runner = createOpRunner({ api, state, run: (a, f, op, input, o) => runPartnerOp(a, f, op, input, { ...o, ...c }), setTimer: (fn, ms) => { timers.push(ms); return timers.length }, clearTimer: () => {} })
    const f = F('H', '小文')
    await runner.start(f, 'rename', { newName: '新名' })
    const b = runBanner(state.runs[f.id])
    assert.equal(b.phase, 'failed')
    assert.deepEqual(Object.keys(b).sort(), ['done', 'hideMs', 'phase', 'text'], '只有一行字，沒有 retry／action／steps')
    assert.equal(b.hideMs, 0, '失敗不會自己消失')
    assert.deepEqual(timers, [], '失敗沒有排任何自動消失')
    assert.equal(state.runs[f.id].view.phase, 'failed', '失敗留在原位')
    assert.doesNotMatch(b.text, /HTTP|409|partner_op/, '畫面不放原文')
    assert.ok(logs.some(l => /409 busy/.test(l)), '原文寫進 log')
    await runner.retry(f.id)   // API 仍在（給程式用），畫面上沒有按鈕
    assert.equal(calls.length, 2)
    assert.equal(state.runs[f.id].view.phase, 'done', '下一個操作的結果蓋掉失敗那一行')
    assert.equal(state.runs[f.id].view.text, '已改名。')
    assert.equal(calls[1].new_name ?? calls[1].newName ?? calls[1].name, calls[0].new_name ?? calls[0].newName ?? calls[0].name)
    assert.deepEqual(calls[1], calls[0], '重試送一樣的內容')
    runner.dismiss(f.id)
    assert.deepEqual(state.runs, {})
  } finally { console.info = orig }
})

test('#1800 逾時：一直沒人接手也有上限，變成失敗（一行字、不自己消失），不會永遠停在「正在…」', async () => {
  const state = { runs: {} }
  const c = clock()
  const api = fakeApi([{ status: 'pending' }])
  const runner = createOpRunner({ api, state, run: (a, f, op, input, o) => runPartnerOp(a, f, op, input, { ...o, ...c, pollMs: 3000 }), setTimer: () => 0, clearTimer: () => {} })
  const f = F('H', '小文')
  const v = await runner.start(f, 'close', {})
  assert.equal(v.phase, 'failed')
  assert.ok(c.now() - 1_000_000 > OP_GIVE_UP_MS, '等超過上限才放棄')
  const b = runBanner(state.runs[f.id])
  assert.deepEqual([b.phase, b.hideMs, 'retry' in b, 'action' in b], ['failed', 0, false, false])
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
  assert.match(ui, /from '\.\/mobile-ops\.mjs'/); assert.match(js, /opRunner\.move\(f\.id, next\)/, '手機改名後倒數也由 runner 搬，不另設計時器')
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

// ---- 一審退回的四點（asn西川）：以下都是行為測試，真的跑函式、看按了之後發生什麼 ----
const quiet = async fn => { const o = console.info; const logs = []; console.info = (...a) => logs.push(a.join(' ')); try { await fn(logs) } finally { console.info = o } }

test('#1800 封存失敗：狀態列沒有重試鈕，但 runner.retry 仍會讓後台真的再收到一次封存請求（手機與電腦共用 createOpRunner＋makeOpRun）', async () => {
  await quiet(async logs => {
    const calls = []
    const api = { partnerArchive: async b => { calls.push(b); if (calls.length === 1) throw new Error('partner_archive HTTP 500 boom'); return { ok: true } } }
    const state = { runs: {} }
    const runner = createOpRunner({ api, state, run: makeOpRun({ archive: undefined }), setTimer: () => 0, clearTimer: () => {} })
    const f = F('H', '小文')
    await runner.start(f, 'archive', {})
    const b = runBanner(state.runs[f.id])
    assert.equal(b.phase, 'failed'); assert.equal('retry' in b, false); assert.equal(b.hideMs, 0)
    assert.equal(calls.length, 1)
    await runner.retry(f.id)
    assert.equal(calls.length, 2, '按重試後後台再收到一次')
    assert.equal(state.runs[f.id].view.phase, 'done')
    assert.ok(logs.some(l => /封存失敗/.test(l)))
  })
})

test('#1800 連按只認最後一次：舊的最後才回來，畫面仍是新的、舊的不會排自動消失', async () => {
  const state = { runs: {} }
  const gate = []
  const timers = []
  const run = (a, f, op, input, o) => new Promise(res => { gate.push(() => { const v = { phase: 'done', done: true, text: op }; o.onUpdate(v); res(v) }) })
  const runner = createOpRunner({ api: {}, state, run, setTimer: (fn, ms) => { timers.push(ms); return timers.length }, clearTimer: () => {} })
  const f = F('H', '小文')
  const p1 = runner.start(f, 'restart', {})
  const p2 = runner.start(f, 'close', {})
  gate[1](); await p2
  assert.equal(state.runs[f.id].view.text, 'close')
  const nTimers = timers.length
  gate[0](); await p1                       // 舊的最後才回來
  assert.equal(state.runs[f.id].op, 'close', '畫面仍是新的那次')
  assert.equal(state.runs[f.id].view.text, 'close')
  assert.equal(timers.length, nTimers, '舊的不會再排一個自動消失')
})

test('#1800 手機非詳情操作走共用 runner（不再自己 set 進度、沒有第二份「只認最後一次」）', () => {
  const js = read('ui/m.js')
  assert.match(js, /createOpRunner\(\{ api: opsTransport/)
  assert.match(js, /opRunner\.start\(f, op, input\)/)
  assert.doesNotMatch(js, /setRun\(opsRuns\.value, f\.id, \{ op, view: v, input \}\)/)
})

test('#1800 後台回報失敗、沒確認：原文完整寫進 log（不截斷），畫面只有白話', async () => {
  const longDetail = 'window_not_found: ' + 'x'.repeat(200) + ' END'
  for (const [row, phase] of [[{ status: 'failed', detail: longDetail }, 'failed'], [{ status: 'unconfirmed', detail: longDetail }, 'unconfirmed']]) {
    await quiet(async logs => {
      const c = clock()
      const v = await runPartnerOp(fakeApi([row]), F('H', '小文'), 'close', {}, { ...c, pollMs: 3000 })
      assert.equal(v.phase, phase)
      assert.doesNotMatch(v.text, /window_not_found|END/)
      assert.ok(logs.some(l => l.includes(longDetail)), phase + '：原文完整進 log')
    })
  }
  await quiet(async logs => {   // 送出失敗也要完整
    const long = 'HTTP 500 ' + 'y'.repeat(200) + ' END'
    await runPartnerOp({ partnerOp: async () => { throw new Error(long) }, partnerOps: async () => ({ ops: [] }) }, F('H', '小文'), 'close', {}, clock())
    assert.ok(logs.some(l => l.includes(long)))
  })
})

test('#1800 電腦功能列：狀態列不再有開新夥伴的接線；對話框（partner-op-dialog）的開新夥伴仍一路接到清單頁', () => {
  const bar = read('ui/lib/actionbar.mjs'), list = read('ui/list.html')
  assert.match(bar, /emits: \['call', 'ops', 'term', 'back', 'member', 'launch-new'\]/)
  assert.match(bar, /<partner-op-strip /)
  assert.doesNotMatch(bar, /<partner-op-strip [^>]*@launch-new/, '狀態列沒有按鈕，不再發 launch-new')
  assert.doesNotMatch(list, /<partner-op-strip [^>]*@launch-new/)
  assert.doesNotMatch(read('ui/list.js'), /launchNewFromRun/)
  assert.match(bar, /<partner-op-dialog [^>]*@launch-new="onLaunchNew"/)
  assert.match(bar, /emit\('launch-new', \{ node:/)
  assert.match(list, /<action-bar [^>]*@launch-new="launchNewFromOp"/)
})


// ---- #1907 夥伴操作狀態列：只有一行字、不放按鈕；成功 4 秒、未確認 15 秒自己消失；滑鼠／手指停著時暫停倒數 ----
test('#1907 自動消失的時間：成功 4000、未確認 15000、失敗與進行中 0、成功但有詳情列 0（hideAfterMs 與 runBanner 一致）', () => {
  assert.equal(OP_DONE_HIDE_MS, 4000); assert.equal(OP_UNCONFIRMED_HIDE_MS, 15000)
  const cases = [
    [{ phase: 'done', done: true, text: 'x' }, 4000], [{ phase: 'unconfirmed', done: true, text: 'x' }, 15000],
    [{ phase: 'failed', done: true, text: 'x' }, 0], [{ phase: 'working', done: false, text: 'x' }, 0], [{ phase: 'sent', done: false, text: 'x' }, 0],
    [{ phase: 'done', done: true, text: 'x', rows: [{ label: 'PID', value: '1' }] }, 0],
  ]
  for (const [v, ms] of cases) {
    assert.equal(hideAfterMs(v), ms, v.phase + (v.rows ? '（有詳情列）' : ''))
    assert.equal(runBanner({ op: 'x', view: v }).hideMs, ms)
  }
  assert.equal(hideAfterMs(null), 0); assert.equal(hideAfterMs({ phase: 'done', done: true, text: 'x', log: ['a'] }), 4000, 'log 不影響消失')
})

test('#1907 hold／release：成功後 hold 清掉計時、release 用剩下的毫秒重排（不是整段重來）；到期後 dismiss', async () => {
  const state = { runs: {} }
  let t = 10_000, seq = 0
  const timers = new Map(), cleared = []
  const run = async (a, f, op, input, o) => { const v = { phase: 'done', done: true, text: '已改名。' }; o.onUpdate(v); return v }
  const runner = createOpRunner({ api: {}, state, run, now: () => t, setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq }, clearTimer: id => { cleared.push(id); timers.delete(id) } })
  const f = F('H', '小文')
  await runner.start(f, 'rename', { newName: 'x' })
  assert.deepEqual([...timers.values()].map(x => x.ms), [OP_DONE_HIDE_MS])
  t += 1500
  runner.hold(f.id)
  assert.equal(timers.size, 0, 'hold 清掉計時'); assert.equal(cleared.length, 1)
  runner.hold(f.id)
  assert.equal(cleared.length, 1, '重複 hold 不再清（也不弄丟剩餘時間）')
  t += 60_000   // 停著很久也不倒數
  assert.ok(state.runs[f.id], '被 hold 住時不會消失')
  runner.release(f.id)
  assert.deepEqual([...timers.values()].map(x => x.ms), [OP_DONE_HIDE_MS - 1500], '用剩下的 2500 毫秒重新計時，不是 4000')
  runner.release(f.id)
  assert.equal(timers.size, 1, '重複 release 不會多排一個')
  // 第二輪：再 hold 一次，剩餘時間從重排的時間點算起
  t += 500
  runner.hold(f.id); runner.release(f.id)
  assert.deepEqual([...timers.values()].map(x => x.ms), [OP_DONE_HIDE_MS - 1500 - 500])
  const fire = [...timers.values()][0].fn
  timers.clear()
  fire()
  assert.deepEqual(state.runs, {}, 'release 後到期就 dismiss')
  assert.doesNotThrow(() => { runner.hold(f.id); runner.release(f.id) }, '消失後再 hold／release 不出事')
  assert.equal(timers.size, 0)
})

test('#1907 hold／release：沒在倒數的（進行中、失敗、從沒操作過）什麼都不做', async () => {
  for (const mode of ['failed', 'working']) {
    const state = { runs: {} }
    const timers = [], cleared = []
    const run = (a, f, op, input, o) => { const v = mode === 'failed' ? { phase: 'failed', done: true, text: '沒有成功：x' } : { phase: 'working', done: false, text: '正在處理…' }; o.onUpdate(v); return mode === 'failed' ? Promise.resolve(v) : new Promise(() => {}) }
    const runner = createOpRunner({ api: {}, state, run, now: () => 0, setTimer: (fn, ms) => { timers.push(ms); return timers.length }, clearTimer: id => cleared.push(id) })
    const f = F('H', '小文')
    void runner.start(f, 'close', {})
    await new Promise(r => setImmediate(r))
    const before = JSON.stringify(state.runs)
    runner.hold(f.id); runner.release(f.id); runner.hold(f.id)
    assert.deepEqual([timers, cleared, JSON.stringify(state.runs)], [[], [], before], mode)
  }
  const runner = createOpRunner({ api: {}, state: { runs: {} }, setTimer: () => { throw new Error('不該排') }, clearTimer: () => { throw new Error('不該清') } })
  assert.doesNotThrow(() => { runner.hold('H/none'); runner.release('H/none') })
})

test('#1907 守門：狀態列（PartnerOpStrip 範本、list.html／actionbar 的 partner-op-strip、m.html 的 .m-ops-run）沒有任何按鈕', () => {
  const ui = read('ui/lib/partner-ops-ui.mjs')
  const tpl = ui.match(/export const PartnerOpStrip = \{[\s\S]*?template: `([\s\S]*?)`,\n\}/)?.[1]
  assert.ok(tpl && tpl.includes('op-strip-row'), '取得 PartnerOpStrip 範本')
  assert.doesNotMatch(tpl, /<button|<a\s|role="button"|@click/, 'PartnerOpStrip 範本沒有按鈕、沒有點擊')
  assert.match(tpl, /<div class="op-strip-row"[^>]*@mouseenter="hold\(it\.id\)"[^>]*@mouseleave="release\(it\.id\)"/, '滑鼠停在上面暫停倒數')
  assert.doesNotMatch(ui, /emits: \['launch-new'\]/)
  const htmls = fs.readdirSync(new URL('ui/', root)).filter(n => n.endsWith('.html'))
  assert.ok(htmls.includes('list.html') && htmls.includes('m.html'))
  let strips = 0
  for (const n of htmls) {
    const src = read('ui/' + n)
    for (const m of src.matchAll(/<partner-op-strip\b[^>]*>([\s\S]*?)<\/partner-op-strip>/g)) { strips++; assert.doesNotMatch(m[0], /<button/, n + ' 的 partner-op-strip 裡沒有按鈕') }
    assert.doesNotMatch(src, /partner-op-strip[^>]*@launch-new/, n)
  }
  assert.ok(strips >= 1, 'list.html 有 partner-op-strip')
  assert.match(read('ui/lib/actionbar.mjs'), /<partner-op-strip [^>]*><\/partner-op-strip>/)
  const m = read('ui/m.html')
  const block = m.match(/<div class="m-ops-run"[^>]*>([\s\S]*?)<\/div>/)
  assert.ok(block, '取得 .m-ops-run 區塊')
  assert.doesNotMatch(block[0], /<button|<ol|m-ops-run-more|@click/, '手機狀態列沒有按鈕、步驟、補充')
  assert.match(block[1], /^\s*<p class="m-ops-run-tx">\{\{ opsBanner\.text \}\}<\/p>\s*$/, '只剩一行字')
  assert.match(block[0], /@touchstart\.passive="holdRun" @touchend="releaseRun" @touchcancel="releaseRun"/)
})

test('#1907 換班接手成功的那一行字：沒有路徑（斜線、反斜線）也沒有模型名稱；這些都在 log', () => {
  const result = { handoff_path: 'C:\\Users\\x\\.asn\\handoff\\p_1\\a.md', handoff_done: true, model: 'claude-opus-5-5', model_basis: 'launch_same' }
  const v = progressView({ status: 'ok', result }, { op: 'handover' })
  assert.equal(v.text, '已換班，新視窗接手了')
  assert.doesNotMatch(v.text, /[/\\]|opus|claude|\.md/)
  assert.ok(v.log.some(l => l.includes(result.handoff_path)), 'log 有交接檔路徑')
  assert.ok(v.log.some(l => l.includes('claude-opus-5-5') && l.includes('和前任一樣')), 'log 有模型與依據')
  assert.equal(runBanner({ op: 'handover', view: v }).text, v.text)
})

test('#1907 runPartnerOp：完成且有 log 才寫進 ui.log（原文不吞掉）；沒有 log 不寫', async () => {
  await quiet(async logs => {
    const c = clock()
    await runPartnerOp(fakeApi([{ status: 'ok', result: { handoff_path: 'D:/h/a.md', handoff_done: false } }]), F('H', '小文'), 'handover', {}, { ...c, pollMs: 3000 })
    const hit = logs.filter(l => l.includes('[ASN] 夥伴操作結果'))
    assert.equal(hit.length, 1); assert.match(hit[0], /handover/); assert.match(hit[0], /交接檔：D:\/h\/a\.md；前任沒有寫完交接/)
    logs.length = 0
    await runPartnerOp(fakeApi([{ status: 'ok' }]), F('H', '小文'), 'close', {}, { ...c, pollMs: 3000 })
    assert.deepEqual(logs.filter(l => l.includes('夥伴操作結果')), [])
  })
})

// 小悠一審（#2035）必修 1：改名成功後，手機的按住暫停要管到新位址上的倒數
test('#1907 runner.move：改名後倒數跟著搬到新位址，按住暫停找得到，舊位址不再倒數', async () => {
  const state = { runs: {} }
  let t = 0, seq = 0
  const timers = new Map()
  const run = async (a, f, op, input, o) => { const v = { phase: 'done', done: true, text: '已改名。' }; o.onUpdate(v); return v }
  const runner = createOpRunner({ api: {}, state, run, now: () => t, setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq }, clearTimer: id => timers.delete(id) })
  const f = F('H', '舊名')
  await runner.start(f, 'rename', { newName: '新名' })
  t += 1000
  runner.move(f.id, 'H/新名')
  assert.deepEqual(Object.keys(state.runs), ['H/新名'], '進度搬到新位址')
  assert.deepEqual([...timers.values()].map(x => x.ms), [OP_DONE_HIDE_MS - 1000], '剩餘時間跟著搬，不是整段重來')
  runner.hold('H/新名')
  assert.equal(timers.size, 0, '用新位址 hold 得到')
  t += 60_000
  assert.ok(state.runs['H/新名'], '按著不消失')
  runner.release('H/新名')
  const fire = [...timers.values()][0].fn
  timers.clear(); fire()
  assert.deepEqual(state.runs, {}, '放開後到期才消失')
})

// 必修 2：滑鼠一直停在列上，新結果蓋掉舊結果時 mouseenter 不會再觸發
test('#1907 滑鼠一直停著：新結果蓋掉舊結果後，新的倒數也是暫停的，mouseleave 才開始', async () => {
  const state = { runs: {} }
  let seq = 0
  const timers = new Map()
  const run = async (a, f, op, input, o) => { const v = { phase: 'done', done: true, text: '好了。' }; o.onUpdate(v); return v }
  const runner = createOpRunner({ api: {}, state, run, now: () => 0, setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq }, clearTimer: id => timers.delete(id) })
  const f = F('H', '小文')
  await runner.start(f, 'close', {})
  runner.hold(f.id)            // 滑鼠停上去
  await runner.start(f, 'close', {})   // 新結果蓋掉舊結果；沒有再觸發 mouseenter
  assert.equal(timers.size, 0, '新倒數一開始就是暫停的')
  assert.ok(state.runs[f.id])
  runner.release(f.id)
  assert.deepEqual([...timers.values()].map(x => x.ms), [OP_DONE_HIDE_MS], '滑鼠移開才開始倒數')
})

// asn真裁示：狀態列只有一格；失敗後面接一句能做的事（不放按鈕）
test('#1907 狀態列只有一格：任何夥伴的新操作蓋掉上一則；失敗留著並接「再按一次就會重試」', async () => {
  const state = { runs: {} }
  const run = async (a, f, op, input, o) => { const v = f.nick === '甲' ? { phase: 'failed', done: true, text: '沒有成功：電腦不在線' } : { phase: 'done', done: true, text: '已關閉。' }; o.onUpdate(v); return v }
  const runner = createOpRunner({ api: {}, state, run, setTimer: () => 0, clearTimer: () => {} })
  const a = F('H', '甲'), b = F('H', '乙')
  await runner.start(a, 'close', {})
  assert.deepEqual(Object.keys(state.runs), [a.id], '失敗留著')
  assert.equal(runBanner(state.runs[a.id]).text, '沒有成功：電腦不在線，再按一次就會重試')
  assert.equal(runBanner({ view: { phase: 'done', done: true, text: '已關閉。' } }).text, '已關閉。', '成功的文字不動')
  await runner.start(b, 'close', {})
  assert.deepEqual(Object.keys(state.runs), [b.id], '另一位夥伴的新操作蓋掉上一則，不疊起來')
})

// 小悠複看（#2035）：只留一格＝只清畫面；被蓋掉那位的背景工作做完時 onDone 照跑（名單、對話分頁、釘選才會更新）
test('#1907 被蓋掉的操作：畫面不再顯示它，但做完時 onDone 照跑，也不把畫面搶回來', async () => {
  const state = { runs: {} }
  const done = []
  let finishA
  const run = (a, f, op, input, o) => f.nick === '甲'
    ? new Promise(res => { finishA = () => { const v = { phase: 'done', done: true, text: '已改名。' }; o.onUpdate(v); res(v) } })
    : (async () => { const v = { phase: 'working', done: false, text: '正在處理…' }; o.onUpdate(v); return v })()
  const runner = createOpRunner({ api: {}, state, run, setTimer: () => 0, clearTimer: () => {}, onDone: d => done.push(d.friend.id) })
  const a = F('H', '甲'), b = F('H', '乙')
  const pa = runner.start(a, 'rename', { newName: 'x' })
  await runner.start(b, 'close', {})
  assert.deepEqual(Object.keys(state.runs), [b.id], '畫面只剩後來的那一位')
  finishA(); await pa
  assert.deepEqual(done, [a.id], '被蓋掉的改名做完，onDone 照跑')
  assert.deepEqual(Object.keys(state.runs), [b.id], '不把畫面搶回來')
})

test('#1907 失敗但再按也沒用（找不到對話紀錄）：不接「再按一次就會重試」', () => {
  assert.equal(runBanner({ view: { phase: 'failed', done: true, text: '沒有成功：x', noRetry: true } }).text, '沒有成功：x')
  assert.equal(runBanner({ view: { phase: 'failed', done: true, text: '沒有成功：x' } }).text, '沒有成功：x，再按一次就會重試')
})
