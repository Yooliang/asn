// #2162 ⑦：用到 patchWithFallback 的呼叫端（引導旗標、設備改名的待送名字）碰到壞檔、被占用時的行為。
// 時間用 node 的假計時器快轉（不真的等 3 秒）。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { markOnboarded, planOnboarding } from '../ui/lib/onboard.mjs'
import { clearPendingDeviceName, setDeviceNameOnboard, syncPendingDeviceName, PENDING_KEY, PENDING_BASE_KEY } from '../ui/lib/device-rename.mjs'
import { memStore } from './helpers.mjs'

const codeErr = (code, message) => Object.assign(new Error(message), { code })
const MERGE = () => codeErr('settings:merge', '設定檔內容無法合併，這次沒有存')
const UNREADABLE = () => codeErr('settings:unreadable', '設定檔暫時讀不到，這次沒有存，稍後再試')
const tick = () => new Promise(r => setImmediate(r))

// patch 依序丟 errs 裡的錯誤，之後照常
const flaky = (init, errs) => {
  const st = memStore(init)
  const real = st.patch
  const left = [...errs]
  st.patch = async f => { const e = left.shift(); if (e) { st.patches.push(JSON.parse(JSON.stringify(f))); throw e } await real(f) }   // 失敗的也記一筆；成功的由 memStore.patch 記
  return st
}
// 跑一件事：碰到 unreadable 時快轉 3 秒
const withClock = async run => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p = run()
    p.catch(() => {})   // 失敗時由下面的 await 回報，免得中途變成未處理的拒絕
    for (let i = 0; i < 5; i++) { await tick(); mock.timers.tick(3000) }
    return await p
  } finally { mock.timers.reset() }
}

test('引導旗標 markOnboarded：只送 done；壞檔（merge）退回整份存一次，帶著原有欄位', async () => {
  const st = flaky({ other: 1 }, [MERGE()])
  await markOnboarded(st)
  assert.deepEqual(st.patches, [{ done: true }])
  assert.equal(st.saves, 1)
  assert.deepEqual(st.data, { other: 1, done: true })
})

test('引導旗標 markOnboarded：被占用（unreadable）等一下再 patch 一次，不整份存', async () => {
  const st = flaky({ other: 1 }, [UNREADABLE()])
  await withClock(() => markOnboarded(st))
  assert.deepEqual(st.patches, [{ done: true }, { done: true }])
  assert.equal(st.saves, 0)
  assert.deepEqual(st.data, { other: 1, done: true })
})

test('引導旗標 markOnboarded：兩次都讀不到就丟「沒存成」的白話錯誤（引導畫面會說沒完成），不整份存', async () => {
  const st = flaky({}, [UNREADABLE(), UNREADABLE()])
  const warn = console.warn
  console.warn = () => {}
  try { await assert.rejects(withClock(() => markOnboarded(st)), /沒有存/) } finally { console.warn = warn }
  assert.equal(st.saves, 0)
})

test('planOnboarding 不用引導時設旗標：merge 退回整份存', async () => {
  const st = flaky({ keep: 1 }, [MERGE()])
  const r = await planOnboarding({ store: st, status: async () => ({ signed_in: true }), accountInfo: async () => ({ owner_name: '擁有者' }), startup: { window_name_custom: true } })
  assert.deepEqual(r.steps, [])
  assert.deepEqual(st.data, { keep: 1, done: true })
  assert.equal(st.saves, 1)
})

test('設備改名：清掉待送名字只送這兩欄（null＝刪除）；merge 退回整份存（已去掉這兩欄）', async () => {
  const st = flaky({ done: true, [PENDING_KEY]: '測試', [PENDING_BASE_KEY]: '舊', keep: 1 }, [])
  assert.equal(await clearPendingDeviceName(st), true)
  assert.deepEqual(st.patches, [{ [PENDING_KEY]: null, [PENDING_BASE_KEY]: null }])
  assert.deepEqual(st.data, { done: true, keep: 1 })
  const st2 = flaky({ done: true, [PENDING_KEY]: '測試', keep: 1 }, [MERGE()])
  assert.equal(await clearPendingDeviceName(st2), true)
  assert.equal(st2.saves, 1)
  assert.deepEqual(st2.data, { done: true, keep: 1 }, '整份存的內容沒有待送欄位，也沒丟別的欄位')
})

test('設備改名：清掉待送名字碰到 unreadable 等一下再試一次，不整份存', async () => {
  const st = flaky({ [PENDING_KEY]: '測試', keep: 1 }, [UNREADABLE()])
  assert.equal(await withClock(() => clearPendingDeviceName(st)), true)
  assert.equal(st.saves, 0)
  assert.equal(st.patches.length, 2)
  assert.deepEqual(st.data, { keep: 1 })
})

test('首次引導連不上後台：待送名字只送自己的欄位；merge 退回整份存、unreadable 等一下重試', async () => {
  const offline = async () => { throw new Error('連不上') }
  const a = flaky({ done: true }, [])
  assert.deepEqual(await setDeviceNameOnboard(offline, a, { node: 'P', name: '新名', base: '舊名' }), { deferred: true, note: '目前連不上後台，名字先存在這台，連上後會自動套用。' })
  assert.deepEqual(a.patches, [{ [PENDING_KEY]: '新名', [PENDING_BASE_KEY]: '舊名' }])
  const b = flaky({ done: true }, [MERGE()])
  await setDeviceNameOnboard(offline, b, { node: 'P', name: '新名', base: '舊名' })
  assert.equal(b.saves, 1)
  assert.deepEqual(b.data, { done: true, [PENDING_KEY]: '新名', [PENDING_BASE_KEY]: '舊名' })
  const c = flaky({ done: true }, [UNREADABLE()])
  await withClock(() => setDeviceNameOnboard(offline, c, { node: 'P', name: '新名' }))
  assert.equal(c.saves, 0)
  assert.deepEqual(c.data, { done: true, [PENDING_KEY]: '新名' })
})

test('同一個存檔連續 patch 不同欄位（引導完成旗標＋待送名字）：第一筆碰到 unreadable 等待時第二筆進來，兩筆都存得進去', async () => {
  const st = flaky({}, [UNREADABLE()])
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p1 = markOnboarded(st)
    await tick()
    const offline = async () => { throw new Error('連不上') }
    await setDeviceNameOnboard(offline, st, { node: 'P', name: '新名' })
    mock.timers.tick(3000)
    await p1
  } finally { mock.timers.reset() }
  assert.deepEqual(st.data, { done: true, [PENDING_KEY]: '新名' })
})

test('補送待送名字成功後清掉：只送兩欄、merge 退回整份存', async () => {
  const ctx = { info: { window_name: '舊' }, core: { nodeNames: {} } }
  const ok = async () => ({ ok: true, name: '新名', changed: true })
  const st = flaky({ [PENDING_KEY]: '新名', [PENDING_BASE_KEY]: '舊', keep: 1 }, [MERGE()])
  await syncPendingDeviceName(ok, st, ctx, { node: 'P' })
  assert.equal(st.saves, 1)
  assert.deepEqual(st.data, { keep: 1 })
})
