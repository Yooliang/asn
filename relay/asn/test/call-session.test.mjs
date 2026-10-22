// 偽通話（#99）：切句偵測、通話流程（假麥克風、假辨識、假念出、假計時；不開麥克風、不出聲、不連網）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { build, RATE } from './audio-helpers.mjs'
import { createEndpointer, rmsOf, END_SILENCE_SECONDS } from '../ui/lib/call-vad.mjs'
import { CALL_MARKER, CALL_SPEAK_MAX, ECHO_GUARD_MS, createCallSession, formatCallTime, isCallActive } from '../ui/lib/call-session.mjs'
import { createCallBeats } from '../ui/lib/call-beats.mjs'
import { createVoiceUi } from '../ui/lib/voice-ui.mjs'

const CHUNK = 1600   // 0.1 秒

// ---------- 切句 ----------
test('切句：連續說話才算開始、停頓約 1 秒才結束；單一聲喀不算', () => {
  const ep = createEndpointer()
  const events = []
  const feed = (rms, sec) => { for (let i = 0; i < Math.round(sec * 10); i++) { const e = ep.push(rms, 0.1); if (e) events.push(e) } }
  feed(0.002, 1)
  feed(0.2, 0.1)      // 喀一聲
  feed(0.002, 0.5)
  assert.deepEqual(events, [], '短促的聲音不算開始說話')
  feed(0.1, 1.2)
  assert.deepEqual(events, ['start'])
  feed(0.002, END_SILENCE_SECONDS - 0.2)
  assert.deepEqual(events, ['start'], '停頓還不夠久，不切')
  feed(0.1, 0.5)      // 句中的小停頓之後又開口
  feed(0.002, END_SILENCE_SECONDS + 0.2)
  assert.deepEqual(events, ['start', 'end'])
})

test('切句：一直講不停到上限會強制切一刀；reset 放棄目前這句', () => {
  const ep = createEndpointer({ maxUtterance: 3 })
  const events = []
  for (let i = 0; i < 40; i++) { const e = ep.push(0.1, 0.1); if (e) events.push(e) }
  assert.deepEqual(events.slice(0, 2), ['start', 'end'])
  const ep2 = createEndpointer()
  for (let i = 0; i < 5; i++) ep2.push(0.1, 0.1)
  assert.equal(ep2.speaking, true)
  ep2.reset()
  assert.equal(ep2.speaking, false)
})

test('切句：底噪很大的環境門檻跟著升高，但不超過上限', () => {
  const ep = createEndpointer()
  for (let i = 0; i < 200; i++) ep.push(0.010, 0.1)   // 穩定的 0.010 底噪（風扇，還不到說話門檻）
  assert.ok(ep.threshold > 0.025 && ep.threshold <= 0.06, `門檻 ${ep.threshold}`)
  assert.ok(rmsOf(new Float32Array([0.5, -0.5])) === 0.5)
})

test('計時顯示', () => {
  assert.equal(formatCallTime(0), '00:00')
  assert.equal(formatCallTime(65), '01:05')
  assert.equal(formatCallTime(3723), '1:02:03')
  assert.equal(formatCallTime(-5), '00:00')
})

// ---------- 通話流程 ----------
function rig({ ready = true, micError = '', recognized = '你好嗎' } = {}) {
  const r = { sent: [], spoken: [], transcribed: 0, micStops: 0, micStarts: 0, timers: new Map(), nextTimer: 1, time: 1_000_000, listeners: new Set(), recognized, ready }
  r.mic = {
    rate: RATE,
    start: async ({ onChunk }) => { r.micStarts++; if (micError) throw new Error(micError); r.onChunk = onChunk },
    stop: async () => { r.micStops++ },
  }
  r.player = {
    phase: 'idle', error: '',
    enqueue(key, text) { r.spoken.push(text); this.phase = 'playing'; r.notify() },
    stop() { this.phase = 'idle' },
  }
  r.notify = () => { for (const f of r.listeners) f(r.player) }
  r.finishSpeaking = async (error = '') => { r.player.phase = 'idle'; r.player.error = error; r.notify(); await flush() }
  r.setTimer = (f, ms) => { const id = r.nextTimer++; r.timers.set(id, { f, at: r.time + ms }); return id }
  r.clearTimer = id => { r.timers.delete(id) }
  r.advance = ms => { r.time += ms; for (const [id, t] of [...r.timers]) if (t.at <= r.time) { r.timers.delete(id); t.f() } }
  r.feed = take => { for (let i = 0; i < take.samples.length; i += CHUNK) r.onChunk(take.samples.slice(i, i + CHUNK)) }
  r.call = createCallSession({
    mic: r.mic, player: r.player, onTts: f => { r.listeners.add(f); return () => r.listeners.delete(f) },
    sttStatus: async () => ({ ready: r.ready }),
    transcribe: async wav => { r.transcribed++; assert.ok(wav.length > 100); return r.recognized },
    send: t => r.sent.push(t),
    setTimer: r.setTimer, clearTimer: r.clearTimer, setTick: () => 0, clearTick: () => {}, now: () => r.time,
  })
  return r
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res)) }
const oneSentence = () => build([0.6, 0.002, false], [1.5, 0.1, true], [1.5, 0.002, false])

test('通話：說一句 → 辨識 → 照現有路徑寄出（附口語標記）→ 等回信 → 念出 → 回到聆聽', async () => {
  const r = rig()
  assert.equal(await r.call.start([{ k: 'them', t: 1, text: '舊的訊息', id: 'old' }]), true)
  assert.equal(r.call.state.phase, 'listening')
  assert.equal(isCallActive(), true)
  r.feed(oneSentence())
  await flush()
  assert.deepEqual(r.sent, [`${CALL_MARKER}\n你好嗎`], '只寄一封，內文是辨識結果')
  assert.equal(r.call.state.heard, '你好嗎')
  assert.equal(r.call.state.phase, 'waiting', '寄出後顯示對方思考中')
  // 舊訊息不念；新回信才念
  r.call.onLog([{ k: 'them', t: 1, text: '舊的訊息', id: 'old' }, { k: 'me', t: 2, text: '你好嗎' }])
  assert.deepEqual(r.spoken, [])
  r.call.onLog([{ k: 'them', t: 1, text: '舊的訊息', id: 'old' }, { k: 'them', t: 3, text: '我在，今天想聊什麼？', id: 'n1' }])
  assert.deepEqual(r.spoken, ['我在，今天想聊什麼？'])
  assert.equal(r.call.state.phase, 'speaking')
  r.call.onLog([{ k: 'them', t: 1, text: '舊的訊息', id: 'old' }, { k: 'them', t: 3, text: '我在，今天想聊什麼？', id: 'n1' }])
  assert.equal(r.spoken.length, 1, '同一則不重念')
  // 念的時候喇叭的聲音不會被當成使用者
  r.feed(oneSentence())
  await flush()
  assert.equal(r.sent.length, 1, '念出時不收音')
  await r.finishSpeaking()
  assert.equal(r.call.state.phase, 'listening')
  r.feed(oneSentence())
  await flush()
  assert.equal(r.sent.length, 1, '念完的回音保護期內仍不收音')
  r.advance(ECHO_GUARD_MS + 10)
  r.feed(oneSentence())
  await flush()
  assert.equal(r.sent.length, 2, '保護期過後又能說')
  const end = await r.call.end()
  assert.equal(r.micStops, 1)
  assert.ok(end.seconds >= 0)
  assert.equal(isCallActive(), false)
})

test('通話：太長的回信只念前面一段；念出失敗會提示並回到聆聽', async () => {
  const r = rig()
  await r.call.start([])
  r.feed(oneSentence()); await flush()
  r.call.onLog([{ k: 'them', t: 3, text: '好。'.repeat(500), id: 'big' }])
  assert.ok([...r.spoken[0]].length <= CALL_SPEAK_MAX)
  await r.finishSpeaking('念出訊息失敗。')
  assert.match(r.call.state.note, /念不出來/)
  assert.equal(r.call.state.phase, 'listening')
  await r.call.end()
})

test('通話：靜音時不收音；取消靜音後恢復', async () => {
  const r = rig()
  await r.call.start([])
  r.call.toggleMute()
  r.feed(oneSentence()); await flush()
  assert.equal(r.sent.length, 0)
  r.call.toggleMute()
  r.feed(oneSentence()); await flush()
  assert.equal(r.sent.length, 1)
  await r.call.end()
})

test('通話：靜音幻覺、沒有人聲的雜音都不寄', async () => {
  const r = rig({ recognized: '謝謝觀看' })
  await r.call.start([])
  r.feed(oneSentence()); await flush()
  assert.equal(r.sent.length, 0, '幻覺字句不寄')
  r.feed(build([3, 0.002, false]))   // 只有底噪
  await flush()
  assert.equal(r.transcribed, 1, '沒人聲的不送去辨識')
  await r.call.end()
})

test('通話：還沒下載辨識 → 不開麥克風，提示中文；麥克風失敗 → 提示並可再試', async () => {
  const a = rig({ ready: false })
  assert.equal(await a.call.start([]), false)
  assert.equal(a.micStarts, 0)
  assert.match(a.call.state.note, /下載/)
  assert.equal(a.call.state.active, false)
  assert.equal(isCallActive(), false)

  const b = rig({ micError: '麥克風沒有授權。請到 Windows「設定」允許。' })
  assert.equal(await b.call.start([]), false)
  assert.match(b.call.state.note, /沒有授權/)
  assert.equal(isCallActive(), false)
  assert.equal(b.call.state.active, false)
})

test('通話：同時只能有一個；掛斷時正在念的會停、計時器與回音保護都清掉', async () => {
  const a = rig(), b = rig()
  await a.call.start([])
  assert.equal(await b.call.start([]), false)
  assert.match(b.call.state.note, /另一個通話/)
  a.feed(oneSentence()); await flush()
  a.call.onLog([{ k: 'them', t: 3, text: '你好', id: 'x' }])
  assert.equal(a.player.phase, 'playing')
  await a.call.end()
  assert.equal(a.player.phase, 'idle', '掛斷就停止念出')
  assert.equal(a.call.state.phase, 'idle')
  assert.equal(a.timers.size, 0, '沒有殘留的計時器')
  assert.equal(await a.call.end(), null, '重複掛斷無事')
  assert.equal(await b.call.start([]), true, '前一個掛斷後可以再開')
  await b.call.end()
})

test('通話：對方一直沒回信，過一陣子不再顯示思考中', async () => {
  const r = rig()
  await r.call.start([])
  r.feed(oneSentence()); await flush()
  assert.equal(r.call.state.phase, 'waiting')
  r.advance(181_000)
  assert.equal(r.call.state.phase, 'listening')
  assert.match(r.call.state.note, /還沒回信/)
  await r.call.end()
})

// ---------- 接線與守門 ----------
test('接進語音功能：通話只用辨識與念出的指令，不自己寄信；通話中麥克風輸入讓路', async () => {
  const calls = []
  const take = build([0.6, 0.002, false], [1.5, 0.1, true], [1.5, 0.002, false])
  let onChunk
  const ui = createVoiceUi({
    invoke: async (cmd) => {
      calls.push(cmd)
      if (cmd === 'stt_status') return { ready: true }
      if (cmd === 'stt_transcribe') return '你好嗎'
      if (cmd === 'tts_speak') return { mime: 'audio/mpeg', audio: 'QUJD' }
      throw new Error('unexpected ' + cmd)
    },
    listen: async () => {},
    createMic: () => ({ rate: RATE, start: async o => { onChunk = o.onChunk }, stop: async () => ({ samples: new Float32Array(0), rate: RATE }) }),
    createAudio: () => ({ play: async () => {}, stop() {}, onended: null }),
  })
  const sent = []
  const call = ui.newCall({ send: t => sent.push(t) })
  assert.equal(await call.start([]), true)
  for (let i = 0; i < take.samples.length; i += CHUNK) onChunk(take.samples.slice(i, i + CHUNK))
  await flush()
  assert.equal(sent.length, 1)
  call.onLog([{ k: 'them', t: 1, text: '收到', id: 'a' }])
  await flush()
  assert.ok(calls.includes('tts_speak'))
  await ui.toggleMic(() => {})
  assert.match(ui.state.note, /通話中/)
  assert.ok(!calls.some(c => /send|relay_|mail|post/i.test(c)), `通話不另開寄信管道：${calls}`)
  await call.end()
})

test('分開模式的通話廣播：通話中暫停名單視窗的自動念，超過 60 秒沒心跳就恢復', () => {
  let t = 0
  const b = createCallBeats({ now: () => t })
  assert.equal(b.anyCall(), false)
  b.onBeat({ id: 'f1', active: true })
  assert.equal(b.anyCall(), true)
  t = 59_000; assert.equal(b.anyCall(), true)
  t = 61_000; assert.equal(b.anyCall(), false, '對話視窗被直接關掉也不會一直卡住')
  b.onBeat({ id: 'f1', active: true }); b.onBeat({ id: 'f1', active: false })
  assert.equal(b.anyCall(), false)
  assert.equal(createCallBeats({ isLocalCall: () => true }).anyCall(), true)
})

test('守門：通話程式不碰金鑰、不直接連網；按鈕與畫面接上、文字純中文、不用 v-html', () => {
  const read = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
  for (const f of ['call-session', 'call-vad', 'call-view', 'call-beats']) {
    assert.doesNotMatch(read(`lib/${f}.mjs`), /x-relay-key|x-asn-tts-secret|ASN_EDGE_TTS|\bfetch\(|XMLHttpRequest|WebSocket|v-html|innerHTML/, f)
  }
  const pane = read('lib/chatpane.mjs')
  assert.match(pane, /<call-view v-if="callActive"/)
  assert.match(pane, /newCall\(\{ send: t => emit\('send', t\) \}\)/, '寄信走對話區原本的 send 事件')
  assert.match(read('lib/actionbar.mjs'), /aria-label="通話"[^>]*title="[^"]*[一-鿿]/)
  assert.match(read('list.js'), /!callBeats\.anyCall\(\)/, '自動念要讓路給通話')
  assert.match(read('chat.html'), /@call-state="callState"/)
  assert.match(fs.readFileSync(new URL('../ui/img/ab-call.svg', import.meta.url), 'utf8'), /^<svg/)
  const view = read('lib/call-view.mjs')
  assert.doesNotMatch(view, /節點/)
})
