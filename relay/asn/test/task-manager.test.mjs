// 工作管理員（0.2.21）的純邏輯：重複判定、停止走哪條既有的路、只能看的沒有停止鈕、記憶體與時長格式、提示文字、5 秒更新與停止流程。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DASH, PATH, REFRESH_MS, TEXT, confirmView, createTaskManager, dupBanner, dupGroups, formatMemory, formatUptime, initialState, markDuplicates, mergeRows, stopPlan, stopRequest, viewRow } from '../ui/lib/task-manager.mjs'

const NOW = 1_800_000_000_000
const SELF = 'P'
const row = (o = {}) => ({ kind: 'claude', name: 'asn真', engine: 'claude', pid: 100, memory_bytes: 1024 * 1024 * 400, started_ms: NOW - 3 * 3600_000, status: 'idle', by_asn: true, cwd: 'G:/work', live: true, term_id: null, ...o })
const friend = (o = {}) => ({ node: SELF, agent: 'asn真', engine: 'claude', status: 'idle', ...o })
// 已登入、電腦開放遠端管理：停止才能按
const OPS_OK = { signedIn: true, loaded: true, checking: false, machines: { [SELF]: { online: true, launcher: { profiles: [] } } } }
const ctx = (friends, ops = OPS_OK) => ({ friends, selfNode: SELF, ops, asn: {} })

test('重複：兩個都活著、同名、Claude 才算', () => {
  const rows = markDuplicates([row({ pid: 1 }), row({ pid: 2 }), row({ name: '西川', pid: 3 })])
  assert.deepEqual(rows.map(r => r.dup), [true, true, false])
  assert.deepEqual(dupGroups(rows), [{ name: 'asn真', n: 2 }])
})

test('重複：殘留的（不是原本那個程序）不算，剩一個活的就不標', () => {
  const rows = markDuplicates([row({ pid: 1 }), row({ pid: 2, live: false })])
  assert.deepEqual(rows.map(r => r.dup), [false, false])
})

test('重複：不同引擎同名不算（pi、終端、其他程式）', () => {
  const rows = markDuplicates([row({ pid: 1 }), row({ kind: 'pi', engine: 'pi', pid: 2 }), row({ kind: 'terminal', name: 'asn真', pid: 3 })])
  assert.ok(rows.every(r => !r.dup))
})

test('重複：不改原本的清單', () => {
  const src = [row({ pid: 1 }), row({ pid: 2 })]
  markDuplicates(src)
  assert.ok(src.every(r => !('dup' in r)))
})

test('提示文字：頂部與重複列都寫出後果', () => {
  const rows = markDuplicates([row({ pid: 1 }), row({ pid: 2 })])
  assert.equal(TEXT.dupRisk, '同名的視窗有兩個時，信可能兩邊都收不到')
  assert.match(dupBanner(dupGroups(rows)), /同名的視窗有兩個時，信可能兩邊都收不到/)
  assert.match(dupBanner(dupGroups(rows)), /「asn真」開了 2 個視窗/)
  assert.equal(dupBanner([]), '')
  const v = viewRow(rows[0], NOW, ctx([friend()]))
  assert.equal(v.dup, true)
  assert.equal(v.dupNote, TEXT.dupRisk)
})

test('記憶體：拿不到顯示「—」，不報錯', () => {
  for (const bad of [null, undefined, NaN, -1, '12', Infinity]) assert.equal(formatMemory(bad), DASH)
  assert.equal(formatMemory(0), '1 KB')
  assert.equal(formatMemory(412 * 1024 * 1024), '412 MB')
  assert.equal(formatMemory(1.5 * 1024 ** 3), '1.5 GB')
  assert.equal(viewRow(row({ memory_bytes: null }), NOW, ctx([friend()])).memory, DASH)
})

test('開了多久：小時與分鐘；不知道開始時間顯示「—」', () => {
  assert.equal(formatUptime(NOW - (3 * 60 + 12) * 60_000, NOW), '3 小時 12 分')
  assert.equal(formatUptime(NOW - 41 * 60_000, NOW), '41 分鐘')
  assert.equal(formatUptime(NOW - 10_000, NOW), '不到 1 分鐘')
  assert.equal(formatUptime(NOW - 50 * 3600_000, NOW), '2 天 2 小時')
  assert.equal(formatUptime(null, NOW), DASH)
  assert.equal(formatUptime(0, NOW), DASH)
})

test('停止：一般視窗走關閉視窗（close），要登入與開放遠端管理，不放寬', () => {
  const r = markDuplicates([row({ name: '西川' })])[0]
  const f = [friend({ agent: '西川' })]
  assert.deepEqual(stopPlan(r, ctx(f)), { path: PATH.close, ok: true, reason: '' })
  const req = stopRequest(r, ctx(f))
  assert.equal(req.path, PATH.close)
  assert.equal(req.op, 'close')
  assert.equal(req.friend.agent, '西川')
  // 沒登入
  const noLogin = stopPlan(r, ctx(f, { ...OPS_OK, signedIn: false }))
  assert.equal(noLogin.ok, false)
  assert.match(noLogin.reason, /登入/)
  assert.equal(stopRequest(r, ctx(f, { ...OPS_OK, signedIn: false })), null)
  // 電腦沒開放遠端管理
  const closed = stopPlan(r, ctx(f, { ...OPS_OK, machines: { [SELF]: { online: true, launcher: null } } }))
  assert.equal(closed.ok, false)
  assert.match(closed.reason, /沒有開放遠端管理/)
})

test('停止：同名重複走 /asn-close-dup <pid>（寄給同一個視窗）', () => {
  const [a, b] = markDuplicates([row({ pid: 18420 }), row({ pid: 21096 })])
  const c = ctx([friend()])
  assert.equal(stopPlan(b, c).path, PATH.dup)
  assert.deepEqual(stopRequest(b, c), { path: PATH.dup, friendId: 'P/asn真', text: '/asn-close-dup 21096' })
  assert.equal(stopRequest(a, c).text, '/asn-close-dup 18420')
})

test('停止：pi、內建工作者各走自己的 close；終端面板走 term_stop', () => {
  const pi = row({ kind: 'pi', engine: 'pi', name: '小派', pid: 5 })
  const acp = { kind: 'acp', name: '小雙', engine: 'gemini', pid: 0, status: 'idle', live: true }
  const term = { kind: 'terminal', name: 'agy', engine: 'agy', pid: 9, by_asn: true, term_id: 't-7', live: true }
  const c = ctx([friend({ agent: '小派', engine: 'pi' }), friend({ agent: '小雙', engine: 'gemini' })])
  assert.equal(stopRequest(pi, c).op, 'close')
  assert.equal(stopRequest(acp, c).op, 'close')
  assert.deepEqual(stopRequest(term, c), { path: PATH.term, req: { id: 't-7' } })
})

test('停止：只能看的類型沒有停止鈕，也不會有任何請求', () => {
  const c = ctx([friend()])
  for (const kind of ['process', 'mux', 'asn']) {
    const r = { kind, name: kind, pid: 7, live: true }
    assert.equal(stopPlan(r, c).path, PATH.none, kind)
    assert.equal(stopPlan(r, c).ok, false, kind)
    assert.equal(stopRequest(r, c), null, kind)
    const v = viewRow(r, NOW, c)
    assert.equal(v.viewOnly, true, kind)
    assert.equal(v.canStop, false, kind)
    assert.ok(v.why, kind)
  }
  // 接手來的終端窗格不是 ASN 開的
  assert.equal(stopRequest({ kind: 'terminal', by_asn: false, term_id: 'x', pid: 1, live: true }, c), null)
})

test('停止：絕不產生殺程序的請求（沒有 taskkill、沒有按程序編號殺）', () => {
  const [, b] = markDuplicates([row({ pid: 1 }), row({ pid: 2 })])
  const reqs = [stopRequest(b, ctx([friend()])), stopRequest(row({ name: '西川' }), ctx([friend({ agent: '西川' })])), stopRequest({ kind: 'terminal', term_id: 't', pid: 3, by_asn: true, live: true }, ctx([]))]
  for (const r of reqs) assert.ok(['close', 'dup', 'term'].includes(r.path))
  assert.ok(!JSON.stringify(reqs).toLowerCase().includes('taskkill'))
})

test('名單上找不到對應的視窗時，停止反灰並說明', () => {
  const p = stopPlan(row({ name: '不存在' }), ctx([friend()]))
  assert.equal(p.ok, false)
  assert.equal(p.reason, TEXT.noPlace)
})

test('合併：名單上這台電腦的內建工作者列進來，沒有程序編號與記憶體', () => {
  const rows = mergeRows({ rows: [row({ name: '西川' })] }, [friend({ agent: '西川' }), friend({ agent: '小雙', engine: 'gemini' }), { node: 'Q', agent: '別台', engine: 'gemini', status: 'idle' }, friend({ agent: '離線的', engine: 'gemini', status: 'offline' })], SELF)
  assert.deepEqual(rows.map(r => r.name), ['西川', '小雙'])
  const v = viewRow(rows[1], NOW, ctx([friend({ agent: '小雙', engine: 'gemini' })]))
  assert.equal(v.pid, DASH)
  assert.equal(v.memory, DASH)
  assert.equal(v.engine, 'Gemini')
})

test('確認框：寫出是哪一個、另一個不受影響、不是 ASN 開的會留下終端機分頁', () => {
  const rows = markDuplicates([row({ pid: 18420 }), row({ pid: 21096, by_asn: false, started_ms: NOW - 41 * 60_000 })])
  const c = confirmView(rows[1], rows, NOW)
  assert.equal(c.title, '要停止「asn真」的這個視窗嗎？')
  assert.ok(c.lines.some(l => l.includes('程序編號 21096') && l.includes('41 分鐘前開的')))
  assert.ok(c.lines.some(l => l.includes('另一個「asn真」（編號 18420）不受影響')))
  assert.ok(c.notes.some(n => n.includes('終端機分頁會留下')))
  assert.equal(c.ok, '停止這個視窗')
})

test('畫面文字不含內部識別碼（對照表編號、對話編號）', () => {
  const r = row({ session_id: 'sess-secret-1', term_id: 'term-secret-2' })
  const v = viewRow(r, NOW, ctx([friend()]))
  assert.ok(!JSON.stringify({ ...v, key: '' }).includes('secret'))
  assert.ok(!JSON.stringify(confirmView(r, [r], NOW)).includes('secret'))
})

// ---------- 控制器 ----------

function setup({ snapshot, friends, runOp, sendMail, termStop, ops = OPS_OK } = {}) {
  const calls = { list: 0, runOp: [], mail: [], term: [], timers: 0, cleared: 0 }
  const state = initialState()
  const tm = createTaskManager({
    api: { taskManagerList: async () => { calls.list++; return snapshot ?? { rows: [], known: [] } }, termStop: async req => { calls.term.push(req); return termStop ?? null } },
    getFriends: () => friends ?? [friend()], getSelfNode: () => SELF, getOpsCtx: () => ops, now: () => NOW,
    runOp: runOp ?? (async (api, f, op) => { calls.runOp.push([f.agent, op]); return { phase: 'done', text: '視窗已關閉，對話記錄還在。' } }),
    sendMail: sendMail ?? (async (id, text) => { calls.mail.push([id, text]); return { ok: true } }),
    setTimer: (fn, ms) => { calls.timers++; calls.ms = ms; return 1 }, clearTimer: () => { calls.cleared++ }, state, log: () => {},
  })
  return { tm, calls, state }
}

test('更新：只在頁面開著時才排每 5 秒更新，關掉就停', async () => {
  const { tm, calls } = setup()
  await tm.refresh()
  assert.equal(calls.list, 0, '沒開頁面不讀')
  tm.open()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(calls.list, 1)
  assert.equal(calls.timers, 1)
  assert.equal(calls.ms, REFRESH_MS)
  assert.equal(REFRESH_MS, 5000)
  tm.close()
  assert.equal(calls.cleared, 1)
  await tm.refresh()
  assert.equal(calls.list, 1, '關掉後不再讀')
})

test('更新失敗：說人話，不報錯，保留舊清單', async () => {
  const bad = createTaskManager({ api: { taskManagerList: async () => { throw new Error('boom 503') } }, getFriends: () => [], getSelfNode: () => SELF, getOpsCtx: () => OPS_OK, now: () => NOW, setTimer: () => 1, clearTimer: () => {}, log: () => {} })
  bad.open()
  await new Promise(r => setTimeout(r, 5))
  const v = bad.view()
  assert.equal(v.error, TEXT.loadFail)
  assert.ok(!v.error.includes('503'))
})

test('停止流程：詢問 → 確認框 → 走 close', async () => {
  const snapshot = { rows: [row({ name: '西川' })], known: [] }
  const { tm, calls } = setup({ snapshot, friends: [friend({ agent: '西川' })] })
  tm.open()
  await new Promise(r => setTimeout(r, 5))
  const key = tm.view().rows[0].key
  assert.equal(tm.view().rows[0].canStop, true)
  tm.ask(key)
  assert.equal(tm.view().confirm.title, '要停止「西川」的這個視窗嗎？')
  await tm.confirm()
  assert.deepEqual(calls.runOp, [['西川', 'close']])
  assert.equal(tm.view().confirm, null)
})

test('停止流程：重複的那列走寄 /asn-close-dup 給本人', async () => {
  const snapshot = { rows: [row({ pid: 18420 }), row({ pid: 21096 })], known: [] }
  const { tm, calls } = setup({ snapshot })
  tm.open()
  await new Promise(r => setTimeout(r, 5))
  const dup = tm.view().rows.find(r => r.pid === '21096')
  assert.equal(dup.dup, true)
  tm.ask(dup.key)
  await tm.confirm()
  assert.deepEqual(calls.mail, [['P/asn真', '/asn-close-dup 21096']])
  assert.deepEqual(calls.runOp, [])
})

test('停止流程：只能看的列，詢問不會開確認框', async () => {
  const snapshot = { rows: [{ kind: 'mux', name: '終端服務', pid: 500, live: true, inside: 2 }], known: [] }
  const { tm } = setup({ snapshot })
  tm.open()
  await new Promise(r => setTimeout(r, 5))
  const v = tm.view().rows[0]
  assert.equal(v.status, '2 個視窗')
  tm.ask(v.key)
  assert.equal(tm.view().confirm, null)
})

test('認得但沒在跑：折疊區列出，在跑的不重複', async () => {
  const snapshot = { rows: [row({ name: '西川' })], known: [{ name: '西川', engine: 'claude' }, { name: '小東', engine: 'claude' }] }
  const { tm } = setup({ snapshot, friends: [friend({ agent: '西川' }), friend({ agent: '小東', status: 'offline' })] })
  tm.open()
  await new Promise(r => setTimeout(r, 5))
  const v = tm.view()
  assert.deepEqual(v.known.map(k => k.name), ['小東'])
  assert.equal(v.known[0].canWake, true)
})

test('頁面、設定與 Rust 的接線：入口、指令與只讀清單都在', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const rd = p => fs.readFileSync(path.join(root, p), 'utf8')
  const panel = rd('ui/lib/settings-panel.mjs')
  assert.match(panel, /openTasks\(curDev\.key\)/)
  for (const op of ['tm-open', 'tm-close', 'tm-ask', 'tm-cancel', 'tm-confirm', 'tm-wake']) assert.ok(rd('ui/list.js').includes(`case '${op}'`), op)
  assert.match(rd('ui/lib/tauri.mjs'), /taskManagerList: \(\) => invoke\('task_manager_list'\)/)
  const lib = rd('src-tauri/src/lib.rs')
  const desktopList = lib.slice(lib.indexOf('.invoke_handler('), lib.lastIndexOf('.invoke_handler('))
  assert.match(desktopList, /[\s,]task_manager_list[\s,]/)
  // Rust 清單模組只讀：不呼叫任何結束程序、關視窗的方法
  const rs = rd('src-tauri/src/launch/taskmgr.rs')
  const prod = rs.slice(0, rs.indexOf('#[cfg(test)]'))
  assert.ok(!/\.terminate\(|\.close_window\(|taskkill|TerminateProcess/i.test(prod), '清單模組不能結束程序')
  assert.match(rd('src-tauri/Cargo.toml'), /Win32_System_ProcessStatus/)
})

test('冒煙情境：工作管理員 Aero 與現代各一張，探測表達式語法正確', async () => {
  const { SCENARIOS, TASKMGR_PROBES, taskmgrProbeSource, tableFor, probeKind } = await import('../scripts/smoke-lib.mjs')
  const vm = await import('node:vm')
  const sc = SCENARIOS.filter(s => s.probe?.taskmgr)
  assert.deepEqual(sc.map(s => s.name), ['list-taskmgr-aero', 'list-taskmgr-modern'])
  assert.ok(sc.every(s => s.shot))
  assert.equal(probeKind(sc[0].probe), '工作管理員檢查')
  assert.doesNotThrow(() => new vm.Script(taskmgrProbeSource(TASKMGR_PROBES.taskmgr)))
  const t = tableFor(sc[0])
  assert.ok(t.task_manager_list.rows.filter(r => r.kind === 'claude' && r.name === 'asn真').length >= 2, '至少一組重複')
})
