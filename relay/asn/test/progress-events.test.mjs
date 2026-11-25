// #2038 PR-2：進度類事件（更新下載、手機更新下載、語音引擎下載、安裝進度）從事件中心訂閱
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createEventHub } from '../ui/lib/event-hub.mjs'
import { watchUpdateProgress, watchAndroidUpdateProgress, sttProgressText } from '../ui/lib/progress-events.mjs'
import { initialUpdateState, withProgress as withDesktopProgress, withInstalling } from '../ui/lib/update.mjs'
import { initialUpdate, withProgress as withPhoneProgress } from '../ui/lib/mobile.mjs'
import { createVoiceUi } from '../ui/lib/voice-ui.mjs'
import { createAgentInstall } from '../ui/lib/agent-install.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 假的 Tauri：記下每個事件名註冊了幾次、取消了幾次，可手動送事件
function fakeTauri() {
  const regs = []
  const listen = (evt, fn) => { const r = { evt, fn, offs: 0 }; regs.push(r); return Promise.resolve(() => { r.offs++ }) }
  const fire = (evt, payload) => { for (const r of regs) if (r.evt === evt && r.offs === 0) r.fn(payload) }
  const live = evt => regs.filter(r => r.evt === evt && r.offs === 0).length
  return { listen, regs, fire, live }
}
const noAudio = { createMic: () => ({}), createAudio: () => ({ play: async () => {}, stop() {}, onended: null }) }

test('電腦更新進度：update-progress 事件 → 更新狀態的 done／total（安裝中才套用）', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  let upd = withInstalling({ ...initialUpdateState(), info: { version: '9.9.9' } })
  watchUpdateProgress(hub, { getUpd: () => upd, setUpd: n => { upd = n }, withProgress: withDesktopProgress })
  await hub.ready()
  t.fire('update-progress', { done: 5, total: 20 })
  assert.equal(upd.done, 5); assert.equal(upd.total, 20)
  upd = initialUpdateState()   // 沒在安裝：事件不能改狀態
  t.fire('update-progress', { done: 9, total: 20 })
  assert.equal(upd.done, 0)
})

test('手機更新進度：android-update-progress 事件 → 進度；phase 不是 downloading 就忽略（既有行為）', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  const upd = { ...initialUpdate(), phase: 'downloading' }
  const off = watchAndroidUpdateProgress(hub, { upd, withProgress: withPhoneProgress })
  await hub.ready()
  t.fire('android-update-progress', { done: 3, total: 10 })
  assert.equal(upd.done, 3); assert.equal(upd.total, 10); assert.equal(upd.phase, 'downloading')
  upd.phase = 'installing'
  t.fire('android-update-progress', { done: 8, total: 10 })
  assert.equal(upd.done, 3, '下載完才到的進度不能改畫面')
  assert.equal(upd.phase, 'installing', '也不能把畫面拉回「下載中」')
  off()
  assert.equal(t.live('android-update-progress'), 0, '退訂後橋也取消註冊')
})

test('語音引擎進度文字：下載中顯示大小、done 清空', () => {
  assert.equal(sttProgressText({ stage: 'engine', done: 4 * 1048576, total: 8 * 1048576 }), '正在下載辨識引擎… 4 MB / 8 MB')
  assert.equal(sttProgressText({ stage: 'model', done: 2 * 1048576 }), '正在下載語音模型… 2 MB')
  assert.equal(sttProgressText({ stage: 'done' }), '')
})

test('語音引擎進度：asn:stt-progress 事件 → 畫面文字；重複下載只訂一次；dispose 退訂', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  let subs = 0
  const counting = { subscribe: (e, f) => { subs++; return hub.subscribe(e, f) }, ready: () => hub.ready() }
  const seen = []
  const ui = createVoiceUi({
    invoke: async cmd => {
      if (cmd !== 'stt_install') throw new Error('unexpected ' + cmd)
      t.fire('asn:stt-progress', { stage: 'engine', done: 4 * 1048576, total: 8 * 1048576 })
      seen.push(ui.state.install.text)
      return null
    },
    hub: counting, ...noAudio,
  })
  await ui.installStt()
  await ui.installStt()
  assert.deepEqual(seen, ['正在下載辨識引擎… 4 MB / 8 MB', '正在下載辨識引擎… 4 MB / 8 MB'])
  assert.equal(subs, 1, 'trackProgress 只訂一次')
  assert.equal(t.live('asn:stt-progress'), 1)
  ui.dispose()
  assert.equal(t.live('asn:stt-progress'), 0, '退訂後橋取消註冊')
})

// reactive 換成會計次的代理：每次「整個 view 被換掉」就加一，用來數一個事件被處理了幾次
function countingInstall() {
  const stats = { viewSets: 0 }
  const reactive = o => new Proxy(o, { set(tg, k, v) { if (k === 'view') stats.viewSets++; tg[k] = v; return true } })
  const ui = createAgentInstall({ invoke: async () => null, reactive })
  return { ui, stats }
}

test('agent-setup：attach 呼叫兩次，一個事件只處理一次（不疊訂閱）；detach 後不再收', async () => {
  const t = fakeTauri(), hub = createEventHub({ listen: t.listen })
  const { ui, stats } = countingInstall()
  ui.attach(hub); ui.attach(hub)
  await hub.ready()
  assert.equal(t.live('agent-setup'), 1, '底層只有一個 listener')
  t.fire('agent-setup', { phase: 'reset' })
  assert.equal(stats.viewSets, 1, 'reset 事件只處理一次')
  ui.detach()
  assert.equal(t.live('agent-setup'), 0)
  t.fire('agent-setup', { phase: 'reset' })
  assert.equal(stats.viewSets, 1, '退訂後不再處理')
})

test('agent-setup：同一個 hub 重複 attach，hub 內處理器只有一個', () => {
  const hub = createEventHub()
  const { ui, stats } = countingInstall()
  ui.attach(hub); ui.attach(hub); ui.attach(hub)
  hub.emit('agent-setup', { phase: 'reset' })
  assert.equal(stats.viewSets, 1)
})

test('畫面接線：三種進度都走事件中心，不再直接 listen', () => {
  const list = read('ui/list.js'), m = read('ui/m.js'), voice = read('ui/lib/voice-ui.mjs')
  assert.doesNotMatch(list, /listen\('update-progress'/)
  assert.doesNotMatch(m, /listen\('android-update-progress'/)
  assert.doesNotMatch(voice, /listen\('asn:stt-progress'/)
  assert.match(list, /watchUpdateProgress\(core\.hub,/)
  assert.match(m, /bindRustEvents\(core\.hub\)/)
  assert.match(m, /watchAndroidUpdateProgress\(core\.hub,/)
  assert.match(list, /agentInstall\.attach\(core\.hub\)/)
})
