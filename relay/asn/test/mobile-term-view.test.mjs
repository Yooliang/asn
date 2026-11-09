// 手機看別台電腦夥伴的終端（PR④）：畫面守門與冒煙假 Tauri 的事件
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { injectSource, tableFor, SCENARIOS, mtermviewFrames } from '../scripts/smoke-lib.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const tag = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, `找不到 ${start}`); return src.slice(i, src.indexOf('</chat-pane>', i)) }

test('m.html：對話分頁的 chat-pane 給看畫面三樣，不給打字', () => {
  const html = read('../ui/m.html')
  const t = tag(html, '<chat-pane v-if="chatFriend"')
  assert.match(t, /:view-active="nav\.tab === 'chats'"/)
  assert.match(t, /:self-node="selfNode"/)
  assert.match(t, /:remote-view-api="mobileRemoteViewApi"/)
  assert.doesNotMatch(t, /remote-input-api/, '手機只能看')
  assert.doesNotMatch(tag(html, '<chat-pane v-if="noticeChat"'), /remote-view-api/, '通知分頁不看終端')
  assert.match(read('../ui/m.js'), /mobileRemoteViewApi/)
})

test('chatpane：切換鈕只在手機且看得到時出現，字與電腦版同一份', () => {
  const src = read('../ui/lib/chatpane.mjs')
  assert.match(src, /const mSwitch = computed\(\(\) => props\.noBar && canRemote\.value\)/)
  assert.match(src, /class="tool-group m-term-switch"[^>]*v-if="mSwitch"/)
  assert.match(src, /:aria-label="TERM_BTN_MSG\.label"/)
  assert.match(src, /:aria-label="TERM_BTN_TERM\.label"/)
  // 切換放在下方圖示列（compose-row 的 toolbar 裡），不再是頂端的大切換列
  const row = src.slice(src.indexOf('<div class="compose-row"'))
  assert.ok(row.indexOf('m-term-switch') > 0 && row.indexOf('m-term-switch') < row.indexOf('<form class="composer"'), '切換鈕要在下方圖示列')
  assert.equal((src.match(/m-term-switch/g) || []).length, 1, '頂端不能再有一列切換')
  assert.match(src, /'is-term': mSwitch && remoteShown/, '看終端時收起輸入框')
  assert.match(src, /watch\(remoteLive, a => \{ if \(!a\) remoteOn\.value = false \}\)/, '離開對話分頁就結束觀看')
  assert.match(src, /:active="remoteLive"/)
})

test('冒煙假 Tauri：listen 記下回呼，指令呼叫後依序送出 __emitOn 的事件', async () => {
  const table = { cmd_a: 1, __emitOn: { cmd_a: mtermviewFrames('z') } }
  const g = { setTimeout, JSON, Object, Array, Promise }
  g.globalThis = g
  vm.createContext(g)
  vm.runInContext(injectSource(table), g)
  const got = []
  const off = await g.__TAURI__.event.listen('term-view-remote-frame', e => got.push(e))
  await g.__TAURI__.core.invoke('cmd_a', {})
  await new Promise(r => setTimeout(r, 400))
  assert.equal(got.length, 4)
  assert.equal(got[0].event, 'term-view-remote-frame')
  assert.equal(got[0].payload.id, 'z')
  assert.equal(got[0].payload.meta.cols, 120)
  off()
  assert.equal(g.__smokeListeners['term-view-remote-frame'].length, 0)
})

test('冒煙情境：五個手機看終端情境帶齊假指令與假的本人確認（ok／cancel／no_lock）', () => {
  const names = SCENARIOS.filter(s => s.name.startsWith('m-term-view')).map(s => s.name)
  assert.deepEqual(names, ['m-term-view', 'm-term-view-360', 'm-term-view-big', 'm-term-view-land', 'm-term-view-cancel', 'm-term-view-nolock', 'm-term-view-late'])
  // 橫向（915×412）：曾經終端被擠成 0，探針斷言終端至少半個螢幕高
  const land = SCENARIOS.find(s => s.name === 'm-term-view-land')
  assert.equal(land.width, 915)
  assert.equal(land.height, 412)
  const t = tableFor(SCENARIOS.find(s => s.name === 'm-term-view'))
  assert.equal(t.term_view_remote_available, true)
  assert.equal(t.term_view_remote_start.id, 'v1')
  assert.ok(t.term_view_remote_start.expires_s > Date.now() / 1000)
  assert.ok(t.__emitOn.term_view_remote_start.length >= 2)
  assert.equal(t.__confirmViewer, 'ok')
  assert.equal(tableFor(SCENARIOS.find(s => s.name === 'm-term-view-cancel')).__confirmViewer, 'cancel')
  assert.equal(tableFor(SCENARIOS.find(s => s.name === 'm-term-view-nolock')).__confirmViewer, 'no_lock')
})

test('mobileRemoteViewApi：每次發起都先本人確認；ok 才送 start，cancel／no_lock 什麼都不送', async () => {
  const { makeMobileRemoteViewApi, CANCELLED } = await import('../ui/lib/mobile-remote-view.mjs')
  const { NO_LOCK_TEXT } = await import('../ui/lib/mobile-confirm.mjs')
  const run = async results => {
    const calls = [], asks = []
    const api = makeMobileRemoteViewApi({ confirm: async () => { asks.push(1); return results.shift() }, invoke: async (cmd, args) => { calls.push([cmd, args]); return { id: 'v1', expires_s: 1 } } })
    return { api, calls, asks }
  }
  const ok = await run(['ok', 'ok'])
  assert.deepEqual(await ok.api.start('H', '小乙', '家用機'), { id: 'v1', expires_s: 1 })
  await ok.api.start('H', '小乙', '')
  assert.deepEqual(ok.calls, [['term_view_remote_start', { toNode: 'H', partner: '小乙', machine: '家用機' }], ['term_view_remote_start', { toNode: 'H', partner: '小乙', machine: null }]])
  assert.equal(ok.asks.length, 2, '每次都重新確認，不記住上一次')
  const cancel = await run(['cancel'])
  await assert.rejects(cancel.api.start('H', '小乙'), e => e.code === CANCELLED && e.message === '')
  assert.deepEqual(cancel.calls, [], '取消：什麼都不送')
  const noLock = await run(['no_lock'])
  await assert.rejects(noLock.api.start('H', '小乙'), e => e.code === 'no_lock' && e.message === NO_LOCK_TEXT)
  assert.deepEqual(noLock.calls, [], '沒設螢幕鎖：也不送')
  for (const weird of [undefined, 'OK', 'yes']) {
    const w = await run([weird])
    await assert.rejects(w.api.start('H', '小乙'))
    assert.deepEqual(w.calls, [], `確認回 ${weird} 一律當沒過`)
  }
  const avail = await run([])
  await avail.api.available('H')
  assert.deepEqual(avail.calls, [['term_view_remote_available', { node: 'H' }]])
  // 畫面：取消時 RemoteView 不顯示錯誤，交給外層切回訊息
  const rv = read('../ui/lib/term-remote.mjs')
  assert.match(rv, /if \(e\?\.code === 'cancel'\) \{ cleanup\(\); emit\('cancel'\); return \}/)
  assert.match(read('../ui/lib/chatpane.mjs'), /:active="remoteLive" @cancel="showMsgs"/)
})

test('守門：手機頁不准直接用電腦版的 remoteViewApi（會跳過生物辨識）；只能用 mobileRemoteViewApi', () => {
  // m.js、m.html 裡出現的 remoteViewApi 一律要是 mobileRemoteViewApi（註解除外）
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '')
  // 手機頁：m.js、m.html，以及 ui/lib 下所有 mobile*.mjs（mobile-remote-view.mjs 本身除外：只有它能包裝電腦版的 available／pause／stop）
  const mobileLibs = fs.readdirSync(new URL('../ui/lib/', import.meta.url)).filter(x => /^mobile.*\.mjs$/.test(x) && x !== 'mobile-remote-view.mjs').map(x => `../ui/lib/${x}`)
  assert.ok(mobileLibs.length >= 5, '有找到手機的模組')
  for (const f of ['../ui/m.js', '../ui/m.html', ...mobileLibs]) {
    const code = strip(read(f))
    // 大小寫有別：mobileRemoteViewApi（大寫 R）不會被 \bremoteViewApi 比到
    assert.equal([...code.matchAll(/\bremoteViewApi\b/g)].length, 0, `${f} 直接用了 remoteViewApi`)
    assert.doesNotMatch(code, /from '\.\/lib\/tauri\.mjs'[^\n]*\bremoteViewApi\b/, `${f} 不能從 tauri.mjs 匯入 remoteViewApi`)
  }
  // 手機那一份的發起不能是電腦版的 start（電腦版不過生物辨識）
  const mob = read('../ui/lib/mobile-remote-view.mjs')
  assert.doesNotMatch(mob, /start:\s*remoteViewApi\.start/)
  assert.doesNotMatch(mob, /\.\.\.remoteViewApi/, '不能整包展開電腦版的介面（會帶進電腦版的 start）')
  assert.match(mob, /const r = await confirm\(\)\s+if \(typeof opts\?\.wanted === 'function' && !opts\.wanted\(\)\) throw [^\n]+\s+if \(r === 'ok'\) return invoke\('term_view_remote_start',/, '發起前一定先本人確認；確認回來時那一次已作廢就不送；ok 才送')
  assert.match(mob, /confirm = \(\) => confirmViewer\(\)/, '預設的確認就是 PR③ 的 confirmViewer')
})

test('確認還在等時切回訊息（那一次作廢），之後才回 ok：完全沒有 start 呼叫（被看的那台不跳允許框、不閃紅條、不寄通知信）', async () => {
  const { makeMobileRemoteViewApi, CANCELLED } = await import('../ui/lib/mobile-remote-view.mjs')
  const calls = []
  let answer
  const api = makeMobileRemoteViewApi({ confirm: () => new Promise(r => { answer = r }), invoke: async (cmd, args) => { calls.push([cmd, args]); return { id: 'v1', expires_s: 1 } } })
  let current = true
  const p = api.start('H', '小乙', '家用機', { wanted: () => current })
  current = false   // 本人切回「訊息」：這一格收掉、序號作廢
  answer('ok')      // 確認很晚才回來
  await assert.rejects(p, e => e.code === CANCELLED)
  assert.deepEqual(calls, [], '作廢的那一次就算回 ok 也不送 start')
  // 重新發起的新一次照常
  const q = api.start('H', '小乙', '家用機', { wanted: () => true })
  answer('ok')
  assert.deepEqual(await q, { id: 'v1', expires_s: 1 })
  assert.deepEqual(calls.map(c => c[0]), ['term_view_remote_start'])
})
