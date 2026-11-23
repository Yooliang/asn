// #2177：夥伴操作（交接、重啟、喚醒…）的進度與結果，直接顯示在對話最下面「上次接收訊息」那一行的位置，
// 不另外多一條；操作結束後那一行恢復成「上次接收訊息是…」；換對象不殘留。電腦與手機共用 ChatPane 的同一條狀態列。
// 電腦：真的掛載 ChatPane（含功能列 ActionBar），按「喚醒」走真的 runner；手機：ChatPane 由 m.html 傳 opNote，同樣掛載驗證。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as mobileOps from '../ui/lib/mobile-ops.mjs'
import { OP_DONE_HIDE_MS, OP_POLL_MS, OP_UNCONFIRMED_HIDE_MS } from '../ui/lib/partner-ops.mjs'
import { mountComponent } from './helpers/render.mjs'

// chatpane.mjs、annotator.mjs 在載入當下就解構全域 Vue，要用 mountComponent 共用的那一份真的 Vue（不然 ref 之類是空殼）
const hadVue = Object.getOwnPropertyDescriptor(globalThis, 'Vue')
const probe = mountComponent({ render() { return globalThis.Vue.h('i') } })
globalThis.Vue = probe.Vue
const { ChatPane } = await import('../ui/lib/chatpane.mjs')
probe.unmount()
if (hadVue) Object.defineProperty(globalThis, 'Vue', hadVue); else delete globalThis.Vue

const opLineNote = run => mobileOps.opLineNote(run)   // 還原到沒有這個函式的舊版時，是各項測試自己紅，不是整檔載入失敗

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const LAUNCHER = { profiles: [{ id: 'claude' }], cwd_allow: ['D:/x'] }
const LAST_AT = new Date(2026, 10, 21, 15, 57).getTime()
const friend = (agent, o = {}) => ({ id: `M1/${agent}`, node: 'M1', agent, nick: agent, engine: 'claude', status: 'offline', lastAt: LAST_AT, ...o })
const settle = async m => { for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }

// opStatus：partner_ops 回的狀態（pending＝一直進行中）
const api = (opStatus, sent = []) => ({
  authStatus: async () => ({ signed_in: true }),
  launchers: async () => ({ machines: [{ node: 'M1', launcher: LAUNCHER, online: true }] }),
  partnerConsoleQuery: async () => ({}), subagentsQuery: async () => ({}), tasksQuery: async () => ({}),
  partnerOp: async body => { sent.push(body); return { id: 'op1' } },
  partnerOps: async () => ({ ops: [{ id: 'op1', status: opStatus.value, result: {} }] }),
})
const mount = async (propsFn) => { const m = mountComponent(ChatPane, propsFn); await settle(m); return m }
// 假時鐘：狀態列「成功 4 秒／未確認 15 秒後消失」的計時器收進 pending（不真的等），測試自己決定何時觸發；
// 後台輪詢的間隔（3 秒）直接改成立刻到。runner 的 setTimer／clearTimer 預設就是全域的 setTimeout／clearTimeout
function fakeTimers() {
  const real = { st: globalThis.setTimeout, ct: globalThis.clearTimeout }
  const pending = new Map(), armed = []
  let seq = 0
  globalThis.setTimeout = (f, ms, ...a) => {
    if (ms === OP_POLL_MS) return real.st(f, 0, ...a)
    if ((ms > OP_DONE_HIDE_MS - 1500 && ms <= OP_DONE_HIDE_MS) || ms === OP_UNCONFIRMED_HIDE_MS) { const id = `fake-${++seq}`; pending.set(id, f); armed.push(ms); return id }
    return real.st(f, ms, ...a)
  }
  globalThis.clearTimeout = id => { if (typeof id === 'string' && pending.has(id)) pending.delete(id); else real.ct(id) }
  return { pending, armed, fire: () => { const fs_ = [...pending.values()]; pending.clear(); fs_.forEach(f => f()) }, restore: () => { globalThis.setTimeout = real.st; globalThis.clearTimeout = real.ct } }
}
const until = async (m, fn, ms) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) { await new Promise(r => setTimeout(r, 50)); await m.nextTick() } }
const lines = m => m.findAll('.typing')
const text = m => lines(m)[0]?.textContent.replace(/\s+/g, ' ').trim() ?? ''
const wake = async m => { const w = m.find('[data-slot="line-wake"]'); assert.ok(w, '離線可喚醒的夥伴有喚醒鍵'); await m.trigger(w, 'click'); for (let i = 0; i < 10; i++) await settle(m) }
const basePane = (V, f, a, extra = {}) => V.reactive({ friend: f, agentApi: a, selfNode: 'M1', skin: 'line', groupMenu: false, log: [], ...extra })

test('#2177 電腦：進度中最下面只有一條狀態列，進度取代「上次接收訊息」，沒有另外的進度列', async () => {
  const status = { value: 'pending' }
  const m = await mount(V => basePane(V, friend('小文'), api(status)))
  try {
    assert.equal(lines(m).length, 1)
    assert.match(text(m), /^上次接收訊息是 /, '沒操作時是原文')
    await wake(m)
    assert.equal(lines(m).length, 1, '還是只有一條')
    assert.doesNotMatch(text(m), /上次接收訊息/, '進度取代了那一行')
    assert.match(text(m), /^小文：/, '沿用原本的「夥伴名：進度句」')
    assert.ok(m.find('.typing.typing-op'))
    assert.equal(m.find('.op-strip-row'), null, '沒有獨立的進度列')
    assert.equal(m.find('.op-slot'), null)
  } finally { status.value = 'failed'; m.unmount() }   // 讓背景輪詢下一輪就收工，不拖住測試行程
})

test('#2177 電腦：操作結束、結果顯示完後，那一行恢復成「上次接收訊息是…」', async () => {
  const status = { value: 'ok' }
  const ft = fakeTimers()
  const m = await mount(V => basePane(V, friend('小文'), api(status)))
  try {
    const before = text(m)
    await wake(m)
    await until(m, () => /已喚醒/.test(text(m)), 8000)
    assert.doesNotMatch(text(m), /上次接收訊息/, '結果還在顯示，還是同一條')
    assert.equal(lines(m).length, 1)
    assert.deepEqual(ft.armed, [OP_DONE_HIDE_MS], '成功排了 4 秒後消失')
    ft.fire(); await settle(m)   // 「成功 4 秒後自己消失」的時間到
    assert.equal(text(m), before, '恢復原文')
    assert.equal(m.find('.typing.typing-op'), null)
  } finally { ft.restore(); m.unmount() }
})

test('#2177 電腦：切換對象時不殘留（換到別位夥伴看到的是他的「上次接收訊息」；換回來仍是進行中）', async () => {
  const status = { value: 'pending' }
  let props
  const m = await mount(V => (props = basePane(V, friend('小文'), api(status))))
  try {
    await wake(m)
    assert.match(text(m), /^小文：/)
    props.friend = friend('小武', { lastAt: LAST_AT + 3600_000 })
    await settle(m)
    assert.equal(lines(m).length, 1)
    assert.match(text(m), /^上次接收訊息是 /, '別位夥伴沒有進度，不殘留')
    assert.doesNotMatch(text(m), /小文/)
    props.friend = friend('小文')
    await settle(m)
    assert.match(text(m), /^小文：/, '換回來，那位的進度還在')
  } finally { status.value = 'failed'; m.unmount() }
})

test('#2177 手機：ChatPane 收到 opNote 就取代「上次接收訊息」，傳 null 就恢復；沒有按鈕；按住／放開交給手機的暫停倒數', async () => {
  let props
  const m = await mount(V => (props = V.reactive({ friend: friend('小文'), log: [], opNote: null, noBar: true })))
  try {
    assert.match(text(m), /^上次接收訊息是 /)
    props.opNote = opLineNote({ name: '小文', view: { phase: 'working', done: false, text: '請前任寫交接中…（第 1 / 3 步）' } })
    await settle(m)
    assert.equal(lines(m).length, 1)
    assert.equal(text(m), '小文：請前任寫交接中…（第 1 / 3 步）')
    assert.equal(lines(m)[0].querySelector('button'), null, '一行字、沒有按鈕')
    assert.match(lines(m)[0].className, /typing-op/)
    await m.trigger(lines(m)[0], 'pointerenter'); await m.trigger(lines(m)[0], 'pointerleave')
    assert.deepEqual(m.emitted('op-hold'), [[]]); assert.deepEqual(m.emitted('op-release'), [[]])
    await m.trigger(lines(m)[0], 'pointerdown'); await m.trigger(lines(m)[0], 'pointercancel')   // 觸控按住、被系統取消
    assert.equal(m.emitted('op-hold').length, 2); assert.equal(m.emitted('op-release').length, 2)
    props.opNote = null
    await settle(m)
    assert.match(text(m), /^上次接收訊息是 /, '進度結束就恢復')
    assert.equal(m.find('.typing.typing-op'), null)
  } finally { m.unmount() }
})

test('#2177 opLineNote：沒有進度回 null、有進度帶夥伴名、失敗接「再按一次就會重試」', () => {
  assert.equal(opLineNote(null), null)
  assert.equal(opLineNote({ name: '小文' }), null)
  assert.deepEqual(opLineNote({ name: '小文', view: { phase: 'done', done: true, text: '已喚醒。' } }), { phase: 'done', done: true, text: '小文：已喚醒。' })
  assert.match(opLineNote({ name: '', view: { phase: 'failed', done: true, text: '沒有成功：x' } }).text, /^沒有成功：x，再按一次就會重試$/)
})

test('#2177 守門：手機與電腦只有一份畫面（chatpane 的 .typing）；獨立的進度列只剩終端分頁與名單頁在用', () => {
  const chat = read('ui/lib/chatpane.mjs'), html = read('ui/m.html'), css = read('ui/style.css') + read('ui/mobile.css')
  assert.match(chat, /<template v-else-if="opLine">\{\{ opLine\.text \}\}<\/template>\s*\n\s*<template v-else-if="remoteBar">/, '進度之後才是純資訊的遠端狀態')
  assert.ok(chat.indexOf('v-else-if="barFirst"') < chat.indexOf('v-else-if="opLine"') && chat.indexOf('v-else-if="voiceNote"') < chat.indexOf('v-else-if="opLine"'), '要動手的提示排在進度前面')
  assert.match(chat, /@pointerenter="opHold" @pointerleave="opRelease" @pointerdown="opPressHold" @pointerup="opPressRelease" @pointercancel="opPressRelease"/, '用 pointer 事件')
  assert.doesNotMatch(chat, /@mouseenter="opHold"|@touchstart\.passive="opHold"/)
  assert.doesNotMatch(css.match(/\.typing\.typing-op\{[^}]*\}/)[0] + css.match(/\.typing-op\.is-failed\{[^}]*\}/)[0] + css.match(/\.typing-op\.is-done\{[^}]*\}/)[0], /#[0-9a-fA-F]{3,6}/, '亮色底色用既有的顏色變數')
  assert.ok(chat.indexOf('v-else-if="opLine"') < chat.indexOf('上次接收訊息是 {{'),'進度排在「上次接收訊息」之前')
  assert.doesNotMatch(html, /m-ops-run/); assert.doesNotMatch(css, /m-ops-run/)
  assert.match(css, /\.typing\.typing-op\{[^}]*var\(--fs-2\)/, '樣式用變數')
  assert.doesNotMatch(css.match(/\.typing\.typing-op\{[^}]*\}/)[0], /\d+px/, '不寫死 px')
})

// ---- 一審（#2187）補的：優先順序、失敗不清掉、按住暫停倒數 ----
const NOTE = { phase: 'done', done: true, text: '小文：已喚醒，視窗開好了。' }
// 看別台畫面時，遠端狀態列由子元件經 setRemoteBar 回報；測試用外殼元件拿到 ChatPane 的實例直接呼叫它
let cp = null
const Shell = { inheritAttrs: false, render() { return globalThis.Vue.h(ChatPane, { ...this.$attrs, ref: el => { cp = el } }) } }
const mountShell = async propsFn => { const m = mountComponent(Shell, propsFn); await settle(m); return m }
const setBar = (m, s) => cp.setRemoteBar('view', s)
const cls = m => lines(m)[0].className

test('#2177 優先順序：危險提示最優先，進度字附在後面，不整個藏起來', async () => {
  const m = await mountShell(V => V.reactive({ friend: friend('小文'), log: [], opNote: NOTE, noBar: true }))
  try {
    setBar(m, { level: 'danger', text: '正在別台打字', stoppable: true }); await settle(m)
    assert.equal(lines(m).length, 1)
    assert.match(text(m), /^正在別台打字.*小文：已喚醒，視窗開好了。$/)
    assert.match(cls(m), /typing-danger/); assert.doesNotMatch(cls(m), /typing-op/)
    assert.ok(lines(m)[0].querySelector('button'), '停止鈕還在')
  } finally { m.unmount() }
})

test('#2177 優先順序：ask／warn 與帶按鈕的遠端提示排在進度前面（按鈕還在、只掛一組 class），進度字附在後面', async () => {
  const m = await mountShell(V => V.reactive({ friend: friend('小文'), log: [], opNote: NOTE, noBar: true }))
  try {
    for (const bar of [{ level: 'ask', text: '對方要你回答' }, { level: 'warn', text: '連線不穩', restartable: true }, { level: 'info', text: '看著畫面', restartable: true }]) {
      setBar(m, bar); await settle(m)
      assert.equal(lines(m).length, 1)
      assert.ok(text(m).startsWith(bar.text), bar.level + '：提示在前')
      assert.ok(text(m).endsWith(NOTE.text), bar.level + '：進度字附在後面')
      assert.match(cls(m), new RegExp('typing-' + bar.level)); assert.doesNotMatch(cls(m), /typing-op/, '不同時掛兩組')
      assert.equal(!!lines(m)[0].querySelector('button'), !!bar.restartable, bar.level + '：按鈕照舊')
    }
  } finally { m.unmount() }
})

test('#2177 優先順序：只有純資訊的遠端狀態才讓位給進度；進度結束後資訊狀態回來', async () => {
  let props
  const m = await mountShell(V => (props = V.reactive({ friend: friend('小文'), log: [], opNote: NOTE, noBar: true })))
  try {
    setBar(m, { level: 'info', text: '看著畫面' }); await settle(m)
    assert.equal(text(m), NOTE.text); assert.match(cls(m), /typing-op/); assert.doesNotMatch(cls(m), /typing-info/)
    props.opNote = null; await settle(m)
    assert.equal(text(m), '看著畫面'); assert.match(cls(m), /typing-info/); assert.doesNotMatch(cls(m), /typing-op/)
  } finally { m.unmount() }
})

test('#2177 失敗訊息不會自動清掉；成功的在按住期間不消失、放開才恢復（真的走 runner，pointer 事件）', async () => {
  const quiet = console.info; console.info = () => {}
  const ft = fakeTimers()
  try {
    const status = { value: 'failed' }
    const m = await mount(V => basePane(V, friend('小文'), api(status)))
    try {
      await wake(m)
      await until(m, () => /沒有成功/.test(text(m)), 8000)
      assert.match(text(m), /沒有成功.*再按一次就會重試/)
      assert.deepEqual(ft.armed, [], '失敗沒有排任何自動消失')
      assert.equal(ft.pending.size, 0)
      assert.match(text(m), /沒有成功/, '失敗留著，等下一個操作蓋掉')
      assert.match(cls(m), /is-failed/)
    } finally { m.unmount() }
    status.value = 'ok'
    const m2 = await mount(V => basePane(V, friend('小文'), api(status)))
    try {
      await wake(m2)
      await until(m2, () => /已喚醒/.test(text(m2)), 8000)
      assert.equal(ft.pending.size, 1, '成功正在倒數')
      await m2.trigger(lines(m2)[0], 'pointerenter')   // 指標停在上面：暫停倒數
      assert.equal(ft.pending.size, 0, '按住期間計時器被清掉')
      ft.fire(); await settle(m2)
      assert.match(text(m2), /已喚醒/, '按住期間不消失')
      await m2.trigger(lines(m2)[0], 'pointerleave')   // 放開：用剩下的時間重新倒數
      assert.equal(ft.pending.size, 1, '放開後重新倒數')
      ft.fire(); await settle(m2)
      assert.match(text(m2), /^上次接收訊息是 /, '倒數到了恢復原文')
    } finally { m2.unmount() }
  } finally { ft.restore(); console.info = quiet }
})
