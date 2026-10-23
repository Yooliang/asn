// 往上捲自動載入更舊的信：核心 loadOlder 與畫面端純邏輯。
// 後台用一個「會照 before／limit 篩」的假資料源模擬（和真後台同一個語意）；舊後台忽略 before 另外模擬。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnCore, VIEW_BASE } from '../ui/lib/core.mjs'
import { OLDER_PAGE, judgeOlder, olderBeforeIso, olderCursor } from '../ui/lib/history.mjs'
import { TOP_THRESHOLD, keepScroll, olderNote, rearmed, wantsOlder } from '../ui/lib/scrollback.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const NAME = 'T-ASN'
const FID = 'W/W-政策'
const BASE = Date.parse('2026-10-20T00:00:00Z')
const at = n => new Date(BASE + n * 60_000).toISOString()   // 第 n 分鐘
const row = n => ({ id: U(1000 + n), ids: [U(1000 + n)], dir: n % 2 ? 'me' : 'them', body: `第${n}則`, created_at: at(n), reply_to: null, delivered_at: null, acked_at: null })
const roster = () => [
  { id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }], asn: [{ window_name: NAME, version: '0.1.35', status: 'online' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'p' }] },
]

// 假後台：all＝全部的信（由舊到新）。像真函式：先篩 before，再取最近 limit 則（預設 100），由舊到新回
function backend(all, { honorBefore = true, calls = [] } = {}) {
  return async (node, agent, partnerId, before, limit) => {
    calls.push({ before, limit })
    let rows = all
    if (honorBefore && before) rows = rows.filter(r => Date.parse(r.created_at) < Date.parse(before))
    return { messages: rows.slice(-(limit || 100)) }
  }
}

// 跑完（或失敗）一定關掉假後台與核心，否則一個失敗會讓整個測試程序掛住
async function withCore(history, fn) {
  const { relay, core } = await setup(history)
  try { await fn(core) } finally { await core.stop().catch(() => {}); await relay.close() }
}
async function setup(history) {
  const relay = await startFakeRelay({ node: 'T', members: roster() })
  const base = httpTransport(relay.url, NAME)
  const core = new AsnCore({ transport: { ...base, history }, store: memStore(), selfNode: 'T', windowName: NAME, pollMs: 60_000, rosterMs: 60_000, log: () => {} })
  await core.start()
  return { relay, core }
}
const texts = core => core.logOf(FID).map(m => m.text)

test('純邏輯：olderCursor 只看真正的信，不看系統提示行；沒有信回 null', () => {
  assert.equal(olderCursor([]), null)
  assert.equal(olderCursor([{ k: 'sys', text: 'x', t: 5 }]), null)
  assert.equal(olderCursor([{ k: 'sys', t: 1 }, { k: 'them', t: 30 }, { k: 'me', t: 20 }, { k: 'them' }]), 20)
  assert.equal(olderBeforeIso(BASE), new Date(BASE + 1).toISOString(), 'before 比最早那則晚 1 毫秒')
})

test('純邏輯：judgeOlder——不早於目前最早一則＝後台忽略 before（停止）；不到一頁＝沒有更多', () => {
  const cursor = BASE + 10 * 60_000
  const older = n => Array.from({ length: n }, (_, i) => row(i))
  assert.deepEqual(judgeOlder(older(50), cursor), { supported: true, more: true })
  assert.deepEqual(judgeOlder(older(49), cursor), { supported: true, more: false })
  assert.deepEqual(judgeOlder([], cursor), { supported: true, more: false })
  assert.deepEqual(judgeOlder(undefined, cursor), { supported: true, more: false })
  const newest = [row(10), row(11), row(12)]   // 舊後台回的是最新那批：全都不早於 cursor
  assert.deepEqual(judgeOlder(newest, cursor), { supported: false, more: false })
  assert.equal(judgeOlder([...newest, row(3)], cursor).supported, true, '只要有一則更早就算有效')
  assert.equal(OLDER_PAGE, 50)
})

test('純邏輯：捲動補償與觸發條件', () => {
  assert.equal(keepScroll(30, 1000, 1400), 430, '前面多了 400px，往下推 400px')
  assert.equal(keepScroll(0, 1000, 1000), 0)
  assert.equal(keepScroll(10, 1000, 990), 0, '不會變負數')
  assert.equal(TOP_THRESHOLD, 120)
  const ok = { top: 100, state: undefined, armed: true, visible: true, hasLog: true }
  assert.equal(wantsOlder(ok), true)
  assert.equal(wantsOlder({ ...ok, top: 121 }), false)
  assert.equal(wantsOlder({ ...ok, state: 'loading' }), false, '同時只跑一個')
  assert.equal(wantsOlder({ ...ok, state: 'done' }), false)
  assert.equal(wantsOlder({ ...ok, armed: false }), false, '失敗後要先離開頂端')
  assert.equal(wantsOlder({ ...ok, visible: false }), false, '隱藏的分頁不載入')
  assert.equal(wantsOlder({ ...ok, hasLog: false }), false)
  assert.equal(rearmed(240), false); assert.equal(rearmed(241), true)
  assert.equal(olderNote('loading'), '載入更早的訊息…')
  assert.equal(olderNote('done'), '沒有更早的訊息了（訊息保存 90 天）')
  assert.equal(olderNote('done', false), '')
  assert.equal(olderNote(undefined), '')
})

test('loadOlder：以最早一則的時間當 before，去重後接在前面；回來滿一頁＝還有更多', async () => {
  const all = Array.from({ length: 300 }, (_, i) => row(i))
  const calls = []
  await withCore(backend(all, { calls }), async core => {
    assert.equal(await core.syncHistory(FID, { force: true }), 100)   // 打開對話：最近 100 則（第 200～299）
    assert.equal(texts(core)[0], '第200則')
    const r1 = await core.loadOlder(FID)
    assert.deepEqual([r1.more, r1.added], [true, 49], '要 50 則，其中最早那一則是重疊的（去重）')
    assert.equal(calls.at(-1).before, olderBeforeIso(BASE + 200 * 60_000))
    assert.equal(calls.at(-1).limit, 50)
    assert.equal(texts(core)[0], '第151則')
    assert.equal(core.logOf(FID).length, 149)
    // 時間順序、沒有重複
    const ts = core.logOf(FID).map(m => m.t)
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b))
    assert.equal(new Set(texts(core)).size, 149)
    assert.equal(core.viewOf(FID).length, 149)
  })
})

test('loadOlder：一路載到最早的一則，回來不到一頁就說沒有更多，之後不再問後台', async () => {
  const all = Array.from({ length: 130 }, (_, i) => row(i))
  const calls = []
  await withCore(backend(all, { calls }), async core => {
    await core.syncHistory(FID, { force: true })   // 第 30～129
    assert.deepEqual(await core.loadOlder(FID), { more: false, added: 30 }, '只剩 30 則＝不到一頁')
    assert.equal(texts(core)[0], '第0則')
    assert.equal(core.logOf(FID).length, 130)
    const n = calls.length
    assert.deepEqual(await core.loadOlder(FID), { more: false, added: 0 })
    assert.equal(calls.length, n, '已經到盡頭：不再打後台')
  })
})

test('loadOlder：剛好滿一頁但再往前已經沒有 → 下一次回空，標為到盡頭', async () => {
  const all = Array.from({ length: 150 }, (_, i) => row(i))
  await withCore(backend(all), async core => {
    await core.syncHistory(FID, { force: true })   // 第 50～149
    assert.deepEqual(await core.loadOlder(FID), { more: true, added: 49 })
    assert.deepEqual(await core.loadOlder(FID), { more: false, added: 1 }, '最後只剩 2 則（含重疊的 1 則）')
    assert.deepEqual(await core.loadOlder(FID), { more: false, added: 0 })
    assert.equal(core.logOf(FID).length, 150)
  })
})

test('loadOlder：舊後台忽略 before（回的還是最新那批）→ 偵測到、不合併、停止', async () => {
  const all = Array.from({ length: 300 }, (_, i) => row(i))
  const calls = []
  await withCore(backend(all, { honorBefore: false, calls }), async core => {
    await core.syncHistory(FID, { force: true })
    const before = core.logOf(FID).length
    assert.deepEqual(await core.loadOlder(FID), { more: false, added: 0 })
    assert.equal(core.logOf(FID).length, before, '沒有把最新那批當成更舊的合併')
    const n = calls.length
    await core.loadOlder(FID)
    assert.equal(calls.length, n, '偵測到之後不再問')
  })
})

test('loadOlder：同一時間只跑一個；後台 404 → 到盡頭不再問；連不上 → error 可再試且不標到盡頭', async () => {
  const all = Array.from({ length: 300 }, (_, i) => row(i))
  let release = null, calls = 0, mode = 'ok'
  const hist = async (node, agent, pid, before, limit) => {
    if (!before) return { messages: all.slice(-100) }
    calls++
    if (mode === 'wait') await new Promise(r => { release = r })
    if (mode === '404') throw new Error('HTTP 404 not_found')
    if (mode === 'down') throw new Error('連不上')
    return backend(all)(node, agent, pid, before, limit)
  }
  await withCore(hist, async core => {
    await core.syncHistory(FID, { force: true })
    mode = 'wait'
    const p1 = core.loadOlder(FID)
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(await core.loadOlder(FID), { more: true, added: 0, busy: true }, '第二個直接回忙碌，不再打後台')
    release(); assert.equal((await p1).added, 49)
    assert.equal(calls, 1)
    mode = 'down'
    const bad = await core.loadOlder(FID)
    assert.equal(bad.error, true); assert.equal(bad.more, true)
    mode = 'ok'
    assert.equal((await core.loadOlder(FID)).added, 49, '失敗不算到盡頭，下次還能載')
    mode = '404'
    assert.deepEqual(await core.loadOlder(FID), { more: false, added: 0 })
    const n = calls
    await core.loadOlder(FID)
    assert.equal(calls, n, '後台不支援：之後不再問')
  })
})

test('畫面顯示範圍：預設最近 200 列；往上載入後依載入量加寬；存檔上限放寬到 2000', async () => {
  const all = Array.from({ length: 400 }, (_, i) => row(i))
  await withCore(backend(all), async core => {
    await core.syncHistory(FID, { force: true })
    for (let i = 0; i < 4; i++) await core.loadOlder(FID)   // 100 + 4×49 = 296 列
    assert.equal(core.logOf(FID).length, 296)
    assert.equal(VIEW_BASE, 200)
    assert.equal(core.viewOf(FID).length, 296, '載入的都顯示，不再只取最後 200')
    assert.equal(core.viewOf(FID)[0].text, '第104則')
    const src = fs.readFileSync(new URL('../ui/lib/core.mjs', import.meta.url), 'utf8')
    assert.match(src, /const LOG_KEEP = 2000/)
  })
})

test('接線（靜態）：三個宿主都不再 slice(-200)、都把 loadOlder 交給 chat-pane；傳輸層把 before／limit 帶給 Rust', () => {
  const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
  for (const f of ['m.js', 'list.js']) assert.doesNotMatch(read(f), /logOf\(id\)\.slice\(-200\)/, f)
  for (const f of ['m.html', 'list.html', 'chat.html']) assert.match(read(f), /:load-older="loadOlder"/, f)
  for (const f of ['m.js', 'lib/tauri.mjs']) assert.match(read(f), /relay_chat_history', \{ node, agent: agent \|\| null, partnerId: partnerId \|\| null, before: before \|\| null, limit: limit \|\| null \}/, f)
  const pane = read('lib/chatpane.mjs')
  assert.match(pane, /@scroll\.passive="onScroll"/)
  assert.match(pane, /keepScroll\(keep\.top, keep\.h, el\.scrollHeight\)/)
  assert.match(pane, /if \(!keep\) scrollDown\(\)/, '載入更舊的信時不能被拉到底')
})
