// 收信停擺的防護（#177；正見的收信程式 10/27 21:56 之後五天沒再收信，日誌沒有錯誤，門鈴顯示連上）：
// 某一步永遠不結束時，pulling 旗標會一直是 true，之後所有門鈴與輪詢都只設合併旗標、什麼也不做。
// 現在：1) 每輪有整體時限，逾時放掉並走退避重試  2) 被放棄的舊一輪晚點醒來不會跟新一輪重複處理  3) 群組分頁游標不前進時不空轉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReceiver } from '../recv.mjs'
import { createPullWithRetry } from '../../machine/pull-retry.mjs'
import { readJsonl } from '../lib.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { rm, sleep, tmpEnv } from './helpers.mjs'

async function until(f, ms = 4000) {
  const t0 = Date.now()
  while (!f() && Date.now() - t0 < ms) await sleep(10)
  return f()
}
const never = () => new Promise(() => {})

test('pullOnce 永遠不結束：整體逾時後放掉，下一次（退避重試）照常收得到', async () => {
  let calls = 0
  const logs = []
  const pr = createPullWithRetry({
    pullOnce: async () => { calls++; if (calls === 1) await never() },
    log: m => logs.push(m), backoffMs: [5], roundTimeoutMs: 30,
  })
  try {
    void pr.pull('bell')
    assert.equal(pr.getStats().pulling, true)
    assert.ok(await until(() => calls >= 2), '逾時後應重試')
    assert.ok(await until(() => pr.getStats().ok >= 1 && !pr.getStats().pulling))
    const s = pr.getStats()
    assert.equal(s.timeouts, 1)
    assert.equal(s.failed, 1)
    assert.ok(logs.some(l => l.includes('pull timed out')), '逾時要記 log（不是靜靜地停住）')
  } finally { pr.destroy() }
})

test('卡住期間的門鈴只合併、不並行；逾時之後的門鈴與輪詢都能再收信', async () => {
  let calls = 0, concurrent = 0, maxConcurrent = 0
  const pr = createPullWithRetry({
    pullOnce: async () => {
      calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent)
      try { if (calls === 1) await never() } finally { concurrent-- }
    },
    log: () => {}, backoffMs: [1_000_000], roundTimeoutMs: 40,   // 退避拉很長：確認是靠「下一個門鈴」而不是重試計時器
  })
  try {
    void pr.pull('bell')
    void pr.pull('poll'); void pr.pull('bell')   // 卡住期間：合併，不開第二個
    await sleep(10)
    assert.equal(calls, 1)
    assert.ok(await until(() => pr.getStats().timeouts === 1))
    await pr.pull('poll')   // 逾時之後的輪詢：不被「還在 pulling」擋住，直接收
    assert.ok(calls >= 2)
    assert.equal(pr.getStats().ok >= 1, true)
  } finally { pr.destroy() }
})

test('被放棄的舊一輪晚點才完成：不寫、不 ack；信留在收發室，由之後的正常一輪收下，只存一次', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  let inboxCalls = 0
  const acks = []
  const mail = { id: U(1), trust: 'member', from_node: 'w02', from_agent: 'a', body: '一封信', created_at: new Date().toISOString() }
  let late = true
  const api = async (action, opts) => {
    if (action === 'inbox') {
      inboxCalls++
      if (inboxCalls === 1) { await sleep(150); return { messages: [mail] } }   // 第一輪：後端遲遲不回，過了時限才回
      return { messages: late ? [] : [mail] }
    }
    if (action === 'ack') { acks.push(opts.body.ids); return { ok: true } }
    if (action === 'room_list') return { rooms: [] }
    throw new Error('unexpected ' + action)
  }
  const rx = createReceiver({ api, cfg, log: () => {}, backoffMs: [5], roundTimeoutMs: 40 })
  try {
    void rx.pull('bell')
    assert.ok(await until(() => rx.getStats().timeouts === 1))
    await sleep(250)   // 舊一輪現在醒來了：它已被放棄，不能寫、不能 ack
    assert.equal(readJsonl(cfg.inboxFile).length, 0, '被放棄的一輪不寫信')
    assert.deepEqual(acks, [], '被放棄的一輪不 ack')
    late = false
    await rx.pull('poll')   // 之後的正常一輪把信收下
    assert.equal(readJsonl(cfg.inboxFile).length, 1)
    assert.deepEqual(acks, [[U(1)]])
  } finally { rx.destroy(); await st.close(); rm(root) }
})

test('即使放棄的舊一輪和新一輪交錯進行，同一封信也只寫一次（寫入前查 seen、寫完立刻記）', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  const msg = { id: U(7), trust: 'member', from_node: 'w02', from_agent: 'a', body: 'x', created_at: new Date().toISOString() }
  const gate = []
  const api = async action => {
    if (action === 'inbox') { await new Promise(r => gate.push(r)); return { messages: [msg] } }
    if (action === 'ack') return { ok: true }
    return { rooms: [] }
  }
  const rx = createReceiver({ api, cfg, log: () => {}, backoffMs: [5], roundTimeoutMs: 30 })
  try {
    void rx.pull('bell')
    assert.ok(await until(() => rx.getStats().timeouts === 1 && gate.length >= 2), '第一輪逾時、第二輪也在等')
    gate.forEach(r => r())   // 兩輪同時醒來
    await sleep(100)
    assert.equal(readJsonl(cfg.inboxFile).filter(m => m.id === U(7)).length, 1)
  } finally { rx.destroy(); await st.close(); rm(root) }
})

test('api 呼叫永遠不回：整體逾時後下一輪收得到信', async () => {
  const st = await startFakeRelay()
  st.mail(1)
  const { root, cfg } = tmpEnv(st.url)
  let n = 0
  const real = async (action, opts) => {
    const r = await fetch(`${st.url}?action=${action}`, { method: opts?.method ?? 'GET', headers: { 'x-relay-key': 'fake-grok-node-key', ...(opts?.body ? { 'content-type': 'application/json' } : {}) }, body: opts?.body ? JSON.stringify(opts.body) : undefined })
    return await r.json()
  }
  const api = (action, opts) => (++n === 1 ? never() : real(action, opts))
  const rx = createReceiver({ api, cfg, log: () => {}, backoffMs: [5], roundTimeoutMs: 40 })
  try {
    void rx.pull('startup')
    assert.ok(await until(() => readJsonl(cfg.inboxFile).some(m => m.id === U(1))), '卡住的第一個 api 之後，下一輪應收到')
  } finally { rx.destroy(); await st.close(); rm(root) }
})

test('群組分頁：後端一直回同一頁（游標不前進）時不空轉——每個群組每輪只讀一頁', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  const page = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, at: new Date().toISOString(), body: 'x', from: 'w02', for_me: false }))
  const reads = []
  const api = async action => {
    if (action === 'inbox') return { messages: [] }
    if (action === 'room_list') return { rooms: [{ id: 'g1', name: '群', last_seq: 100, mine: [{ member: 'node~agent' }] }] }
    if (action.startsWith('room_read')) { reads.push(action); return { messages: page } }   // 永遠同一頁（seq 1..100）
    throw new Error('unexpected ' + action)
  }
  // 游標先設成 100：同一頁的訊息全部 <= 游標，被濾掉，不能再翻下一頁
  const fs = await import('node:fs')
  const rx = createReceiver({ api, cfg, log: () => {}, backoffMs: [5], roundTimeoutMs: 1000 })   // 建立時才會建好信箱資料夾
  try {
    fs.writeFileSync(cfg.roomsFile, JSON.stringify({ 'g1|node~agent': 100 }))
    await rx.pull('poll')
    await sleep(30)
    assert.equal(reads.length, 1, `只該讀一頁，實際讀了 ${reads.length} 頁`)
    // 就算後端每一頁都是新訊息，也有頁數上限
    reads.length = 0
    fs.writeFileSync(cfg.roomsFile, JSON.stringify({ 'g1|node~agent': 0 }))
    let seq = 0
    const api2 = async action => {
      if (action === 'inbox') return { messages: [] }
      if (action === 'room_list') return { rooms: [{ id: 'g1', name: '群', last_seq: 99999, mine: [{ member: 'node~agent' }] }] }
      reads.push(action); return { messages: Array.from({ length: 100 }, () => ({ seq: ++seq, at: new Date().toISOString(), body: 'x', from: 'w02', for_me: false })) }
    }
    const rx2 = createReceiver({ api: api2, cfg, log: () => {}, backoffMs: [5], roundTimeoutMs: 1000 })
    await rx2.pull('poll'); await sleep(30)
    assert.ok(reads.length <= 5, `一輪最多 5 頁，實際 ${reads.length}`)
    rx2.destroy()
  } finally { rx.destroy(); await st.close(); rm(root) }
})
