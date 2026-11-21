// #1866 ②：對話頁右上角，離線可喚醒時通話圖示換成紅色喚醒圖示。電腦版真的掛載 ActionBar；手機版 m.js／m.html 是整頁應用掛不起來，
// 以同一個 headCallView 的輸出對照，並守門手機畫面接的是同一個判斷與既有的喚醒入口 pickOp('resume')。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ActionBar } from '../ui/lib/actionbar.mjs'
import { headCallView } from '../ui/lib/head-call.mjs'
import { machinesByNode } from '../ui/lib/mobile-launch.mjs'
import { mountComponent } from './helpers/render.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const LAUNCHER = { profiles: [{ id: 'claude' }], cwd_allow: ['D:/x'] }
const machines = online => machinesByNode({ machines: [{ node: 'M1', launcher: LAUNCHER, online }] })
const friend = (o = {}) => ({ id: 'M1/小牧', node: 'M1', agent: '小牧', nick: '小牧', engine: 'claude', status: 'offline', ...o })
const ctxOf = (o = {}) => ({ loaded: true, signedIn: true, machines: machines(true), ...o })

const api = (online = true, sent = []) => ({
  authStatus: async () => ({ signed_in: true }),
  launchers: async () => ({ machines: [{ node: 'M1', launcher: LAUNCHER, online }] }),
  partnerConsoleQuery: async () => ({}), subagentsQuery: async () => ({}), tasksQuery: async () => ({}),
  partnerOp: async body => { sent.push(body); return { id: 'op1' } }, partnerOps: async () => ({ ops: [{ id: 'op1', status: 'ok', result: {} }] }),
})
const settle = async m => { for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }
const bar = async (f, a = api()) => { const m = mountComponent(ActionBar, { friend: f, selfNode: 'M1', skin: 'line', api: a, callable: true }); await settle(m); return m }

test('#1866 電腦：離線可喚醒時右上角是紅色喚醒圖示，沒有通話鍵；按下走既有喚醒入口', async () => {
  const sent = []
  const m = await bar(friend(), api(true, sent))
  try {
    const w = m.find('.mbar-acts [data-slot="line-wake"]')
    assert.ok(w, '有喚醒圖示')
    assert.equal(w.getAttribute('aria-label'), '喚醒')
    assert.equal(w.getAttribute('title'), '喚醒')
    assert.match(w.className, /mbtn-wake/)
    assert.equal(w.textContent.trim(), '', '只有圖示、沒有文字')
    assert.equal(m.find('.mbar-acts [data-slot="line-call"]'), null, '通話鍵被換掉')
    await m.trigger(w, 'click'); await settle(m)
    for (let i = 0; i < 20 && sent.length === 0; i++) await settle(m)
    assert.deepEqual(sent.map(b => [b.node, b.name, b.op]), [['M1', '小牧', 'resume']], '送出的是喚醒操作')
  } finally { m.unmount() }
})

test('#1866 電腦：在線照舊是通話鍵、不出現喚醒圖示', async () => {
  const m = await bar(friend({ status: 'online' }))
  try {
    assert.ok(m.find('.mbar-acts [data-slot="line-call"]'))
    assert.equal(m.find('.mbar-acts [data-slot="line-wake"]'), null)
  } finally { m.unmount() }
})

test('#1866 電腦：離線但電腦沒開（asis）：維持原本的通話鍵，不出現喚醒圖示', async () => {
  const m = await bar(friend(), api(false))
  try {
    assert.equal(m.find('.mbar-acts [data-slot="line-wake"]'), null)
    assert.ok(m.find('.mbar-acts [data-slot="line-call"]'))
  } finally { m.unmount() }
})

test('#1866 手機與電腦對同一輸入給出同樣的 kind（兩邊都只呼叫 headCallView）', () => {
  const cases = [[friend({ status: 'online' }), ctxOf(), 'call'], [friend(), ctxOf(), 'wake'], [friend({ person: true }), ctxOf(), 'asis'],
    [friend(), ctxOf({ machines: machines(false) }), 'asis'], [friend({ engine: 'gemini' }), ctxOf(), 'asis']]
  for (const [f, c, want] of cases) assert.equal(headCallView(f, c).kind, want)
  assert.match(read('ui/lib/actionbar.mjs'), /headCallView\(props\.friend, opsCtx\)\.kind === 'wake'/)
  assert.match(read('ui/m.js'), /headCallView\(chatFriend\.value, opsCtx\.value\)\.kind === 'wake'/)
})

test('#1866 手機：喚醒圖示與通話鍵同尺寸同位置，按下走 pickOp(resume)，通話鍵在 wake 時讓位', () => {
  const html = read('ui/m.html')
  const wake = html.split('\n').find(l => l.includes('m-head-wake'))
  assert.ok(wake)
  assert.match(wake, /class="m-icon-btn m-head-call m-head-wake"/)
  assert.match(wake, /v-if="[^"]*headWake"/)
  assert.match(wake, /@click="pickOp\('resume'\)"/)
  assert.match(wake, /aria-label="喚醒" title="喚醒"/)
  assert.match(wake, /name="wake" :size="22"/)
  const call = html.split('\n').find(l => l.includes('@click="chatPaneEl.startCall()"'))
  assert.match(call, /&& !headWake"/)
  const css = read('ui/line.css')
  assert.match(css, /\.m-head-wake\{color:#c4463d\}/)
  assert.match(css, /\.mbtn\.mbtn-wake\{color:#c4463d\}/)
  assert.ok(css.indexOf('.m-head-wake{') > css.indexOf('.m-head-call,'), '手機紅色要排在 .m-head-call 的顏色之後，否則被蓋掉')
})
