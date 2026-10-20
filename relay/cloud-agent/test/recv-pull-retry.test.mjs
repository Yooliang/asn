// recv pull 失敗退避：假後端 500、重試後收信 ack、持續失敗間隔遞增且上限
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReceiver } from '../recv.mjs'
import { createPullWithRetry } from '../../machine/pull-retry.mjs'
import { readJsonl } from '../lib.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { apiFor, rm, sleep, tmpEnv } from './helpers.mjs'

async function until(f, ms = 8000) {
  const t0 = Date.now()
  while (!f() && Date.now() - t0 < ms) await sleep(25)
  return f()
}

test('inbox 前兩次 500、第三次成功：短退避內寫入 inbox 並 ack', async () => {
  const st = await startFakeRelay({ inboxFailRemaining: 2 })
  st.mail(1)
  const { root, cfg } = tmpEnv(st.url)
  const rx = createReceiver({ api: apiFor(cfg), cfg, log: () => {}, backoffMs: [5, 10, 20, 40] })
  try {
    void rx.pull('bell')
    assert.ok(await until(() => readJsonl(cfg.inboxFile).some(m => m.id === U(1))), '應在退避重試後寫入')
    assert.ok(await until(() => st.acks.at(-1)?.[0] === U(1)), '應 ack')
    assert.deepEqual(st.acks.at(-1), [U(1)])
  } finally {
    rx.destroy()
    await st.close()
    rm(root)
  }
})

test('持續失敗：退避間隔遞增且卡在上限，不會 tight loop', async () => {
  const delays = []
  let n = 0
  const pullOnce = async () => { n++; throw new Error('fetch failed') }
  const pr = createPullWithRetry({
    pullOnce,
    log: () => {},
    backoffMs: [5, 10, 20, 60],
    sleep: ms => { delays.push(ms); return new Promise(r => setTimeout(r, ms)) },
  })
  try {
    void pr.pull('bell')
    assert.ok(await until(() => delays.length >= 3, 2000), `delays=${delays.join(',')}`)
    assert.deepEqual(delays.slice(0, 3), [5, 10, 20])
    assert.ok(await until(() => delays.length >= 4, 2000))
    assert.equal(delays[3], 60)
    assert.ok(n >= 4)
  } finally {
    pr.destroy()
  }
})

test('退避等待中門鈴：合併成一次 pull、不並行', async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const pullOnce = async () => {
    concurrent++
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    await new Promise(r => setTimeout(r, 5))
    concurrent--
    throw new Error('fail')
  }
  const pr = createPullWithRetry({ pullOnce, log: () => {}, backoffMs: [20] })
  try {
    void pr.pull('a')
    await sleep(2)
    void pr.pull('bell')
    await sleep(30)
    assert.equal(maxConcurrent, 1)
  } finally {
    pr.destroy()
  }
})

test('成功後 failStep 重置', async () => {
  let fail = 1
  const pullOnce = async () => { if (fail-- > 0) throw new Error('x') }
  const pr = createPullWithRetry({ pullOnce, log: () => {}, backoffMs: [1] })
  try {
    await pr.pull('a')
    await sleep(5)
    assert.equal(pr.getFailStep(), 0)
    fail = 1
    await pr.pull('b')
    await sleep(5)
    assert.deepEqual(pr.getScheduledDelays(), [1, 1])
  } finally {
    pr.destroy()
  }
})
