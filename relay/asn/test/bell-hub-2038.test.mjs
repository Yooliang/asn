// #2038 PR-5：relay-bell 門鈴改走事件中心——多個處理器共用一個底層 listener、順序＝訂閱順序、接線守門
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEventHub } from '../ui/lib/event-hub.mjs'
import { HUB_MIGRATED } from '../ui/lib/rust-events.mjs'

const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
const m = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')

test('hub 上訂 4 個 relay-bell 處理器：一聲門鈴各跑 1 次、順序＝訂閱順序、底層只有 1 個 listener', async () => {
  const recs = []
  const hub = createEventHub({ listen: (evt, fn) => { recs.push({ evt, fn }); return Promise.resolve(() => {}) } })
  const got = []
  for (const n of ['pull', 'secret', 'perm', 'term']) hub.on('relay-bell', () => got.push(n))
  await hub.ready()
  assert.equal(recs.filter(r => r.evt === 'relay-bell').length, 1, '底層 listener 只能有 1 個')
  recs[0].fn({ payload: null })
  assert.deepEqual(got, ['pull', 'secret', 'perm', 'term'])
})

test('relay-bell 已登記為搬進 hub 的事件', () => {
  assert.ok(HUB_MIGRATED.includes('relay-bell'))
})

test('接線：list.js、m.js 不再直接 listen relay-bell（relay-report-bell 不在此列）', () => {
  assert.ok(!/listen\('relay-bell'/.test(list))
  assert.ok(!/listen\('relay-bell'/.test(m))
})

test('接線：m.js 有 4 個門鈴接收處，各自對應的動作都在', () => {
  const calls = [...m.matchAll(/core(?:\?\.hub|\.hub)?\.on\('relay-bell', ([^\n]*)/g)].map(x => x[1])
  assert.equal(calls.length, 4)
  for (const must of ["core.pull('bell')", 'checkSecrets()', 'checkPermReqs()', 'checkTermReqs()']) {
    assert.ok(calls.some(c => c.includes(must)), `m.js 缺門鈴接收處：${must}`)
  }
})

// 為什麼沒登入時不訂也沒關係：core 只在啟動時 screen 是 'main' 才建立。沒登入（login）、首次引導（onboard）、錯誤（fatal）畫面要進到 main，一定會重跑整頁：
// 登入成功 finishLogin → location.reload() 或 bridge.relaunch()；引導完成 finishOnboard → location.reload()；
// 「先不要，回名單」(backFromLogin) 只在 !info.needs_login 時顯示，也就是一開始就在 main、core 已存在。所以根元件不會在 core 是 null 的情況下進到 main。
test('接線：m.js 根元件三處門鈴在沒登入（core 是 null）時不會拋錯', () => {
  const lines = m.split('\n')
  const mHtml = fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8')
  const fn = (name) => { const i = m.indexOf(name); return i < 0 ? '' : m.slice(i, i + 600) }
  const login = fn('async function finishLogin()').split('async function startLogin')[0]
  const onboard = fn('const finishOnboard =').split('\n')[0]
  assert.ok(login.includes('location.reload()') && login.includes('bridge.relaunch()'), 'finishLogin 必須整頁重跑（reload／relaunch）')
  assert.ok(onboard.includes('location.reload()'), 'finishOnboard 必須整頁重跑')
  assert.ok(/v-if="[^"]*!info\.needs_login[^"]*"[^>]*@click="backFromLogin"/.test(mHtml), '回名單按鈕只能在 !info.needs_login 時顯示')
  assert.equal(lines.filter(l => /^\s*core\.hub\.on\('relay-bell'/.test(l)).length, 0, '有沒加守門的 core.hub.on，沒登入時會拋錯')
  assert.equal(lines.filter(l => /^\s*core\?\.hub\.on\('relay-bell'/.test(l)).length, 3)
})

test('接線：m.js 頂層門鈴之後緊接 await core.hub.ready()（原本是 await listen），根元件三處不等（原本 void listen）', () => {
  assert.ok(!/await core\.on\('relay-bell'/.test(m))
  const lines = m.split('\n')
  const top = lines.findIndex(l => /^\s*core\.on\('relay-bell'/.test(l))
  const isReady = l => /^\s*await core\.hub\.ready\(\)/.test(l)   // 只認真的程式行，註解掉的不算
  assert.ok(top > 0, 'm.js 頂層門鈴不見了')
  assert.ok(isReady(lines[top + 1] ?? ''), '頂層門鈴下一行要是 await core.hub.ready()，保住原本 await listen 的啟動順序')
  assert.equal(lines.filter(isReady).length, 1, '只在頂層那一處等；根元件三處維持不等')
})

test('接線：list.js 有 2 個門鈴接收處，頂層那個排在 await core.ready() 之前', () => {
  const calls = [...list.matchAll(/core(?:\.hub)?\.on\('relay-bell'/g)]
  assert.equal(calls.length, 2)
  const top = list.indexOf("core.on('relay-bell'")
  const ready = list.indexOf('await core.ready()', top)
  assert.ok(top > 0 && ready > top, "core.on('relay-bell') 必須在 await core.ready() 之前，否則第一聲門鈴可能漏掉")
})

test('接線：list.js 帳號切換的門鈴只在非截圖模式註冊', () => {
  assert.ok(/if \(!info\.shot\) \{\s*setInterval\([^\n]*\n\s*core\.hub\.on\('relay-bell', \(\) => void accounts\.pollIncoming\(\)\)\s*\}/.test(list))
})
