// 對方（AI 夥伴）主動掛斷通話：回信最後一行單獨寫結束記號，通話端念完就掛斷（手機 mobile-call.mjs、電腦 call-session.mjs 都有）。
// 記號不念出、不顯示；只認通話對象、回覆通話中信件、最後一行整行。外殼、麥克風、念出、計時都用假的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, RATE } from './audio-helpers.mjs'
import { CALL_END_MARKER, CALL_END_NOTE, splitCallEnd } from '../ui/lib/call-end.mjs'
import { CALL_MARKER, createCallSession } from '../ui/lib/call-session.mjs'
import { createMobileCall } from '../ui/lib/mobile-call.mjs'
import { isVoiceMsg } from '../ui/lib/voice-mark.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8')
const tick = () => new Promise(r => setImmediate(r))
const flush = async () => { for (let i = 0; i < 5; i++) await tick() }

test('結束記號：只認最後一行整行；中間出現、前後有字的都不算；內文原樣保留', () => {
  assert.deepEqual(splitCallEnd(`好的，再見。\n${CALL_END_MARKER}`), { text: '好的，再見。', ends: true })
  assert.deepEqual(splitCallEnd(`好的\n  ${CALL_END_MARKER}  \n\n`), { text: '好的', ends: true }, '前後空白與結尾空行不影響')
  assert.deepEqual(splitCallEnd(CALL_END_MARKER), { text: '', ends: true })
  assert.equal(splitCallEnd(`${CALL_END_MARKER}\n還有話`).ends, false, '不是最後一行')
  assert.equal(splitCallEnd(`再見${CALL_END_MARKER}`).ends, false, '同一行有別的字')
  assert.equal(splitCallEnd('一般的回覆').ends, false)
  assert.equal(splitCallEnd(null).ends, false)
})

test('通話提示行告訴 AI 怎麼掛斷，且不是會被收發室跳脫的「（語音通話：」開頭；舊提示行的舊記錄仍算語音', () => {
  assert.ok(CALL_MARKER.includes(CALL_END_MARKER))
  assert.ok(CALL_MARKER.startsWith('（語音通話中，'))
  assert.ok(!CALL_MARKER.startsWith('（語音通話：'))
  assert.equal(isVoiceMsg({ k: 'me', text: `${CALL_MARKER}\n嗨` }), true)
  assert.equal(isVoiceMsg({ k: 'me', text: '（語音通話中，請簡短口語回答）\n舊的' }), true)
  assert.equal(isVoiceMsg({ k: 'them', text: `${CALL_MARKER}\n嗨` }), false)
})

test('顯示：對話區把對方回信的記號拿掉，改顯示小提示（只處理對方的信）', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.match(pane, /const shownBody = m => \(m\?\.k === 'them' \? splitCallEnd\(m\.text\)/)
  assert.match(pane, /renderMarkdown\(shownBody\(m\)\.text\)/)
  assert.match(pane, /v-if="shownBody\(m\)\.ends">\{\{ CALL_END_NOTE \}\}/)
})

// ---------- 手機 ----------
function mobile() {
  let handler = null
  const timers = new Map(); let seq = 0
  const native = {
    spoken: [], listening: 0, ended: 0,
    available: () => true, micState: () => 'granted', requestMic() {},
    listen() { native.listening++ }, stopListen() {}, speak(id, text) { native.spoken.push({ id, text }) }, stopSpeak() {},
    end() { native.ended++ }, onEvent(fn) { handler = fn; return () => { handler = null } }, emit(e) { handler?.(e) },
  }
  const call = createMobileCall({
    native, send: async () => {},
    setTimer: (f, ms) => { const id = ++seq; timers.set(id, { f, ms }); return id }, clearTimer: id => timers.delete(id), setTick: () => 0, clearTick: () => {},
  })
  return { native, call, timers }
}
async function talked() {
  const t = mobile()
  await t.call.start([])
  t.native.emit({ t: 'result', text: '嗨' })
  await tick()
  return t
}
const doneAll = t => { for (const s of [...t.native.spoken]) t.native.emit({ t: 'tts-done', id: s.id }) }

test('手機：對方回信最後一行是結束記號，記號不念，念完自動掛斷並提示', async () => {
  const t = await talked()
  t.call.onLog([{ k: 'them', id: 'r1', text: `好的，下次再聊。\n${CALL_END_MARKER}` }])
  assert.ok(t.native.spoken.length >= 1)
  assert.ok(t.native.spoken.every(s => !s.text.includes('結束通話')), '記號不念出來')
  assert.equal(t.call.state.reply, '好的，下次再聊。')
  assert.equal(t.call.state.active, true, '還沒念完不掛')
  doneAll(t)
  assert.equal(t.call.state.active, false)
  assert.equal(t.call.state.note, CALL_END_NOTE)
  assert.equal(t.native.ended, 1)
})

test('手機：只有記號的回信沒有可念的，直接掛斷', async () => {
  const t = await talked()
  t.call.onLog([{ k: 'them', id: 'r1', text: CALL_END_MARKER }])
  assert.equal(t.native.spoken.length, 0)
  assert.equal(t.call.state.active, false)
  assert.equal(t.call.state.note, CALL_END_NOTE)
})

test('手機防誤觸：記號不在最後一行、這次通話還沒寄過語音信、不是對方寄的，都不掛斷', async () => {
  const a = await talked()
  a.call.onLog([{ k: 'them', id: 'r1', text: `${CALL_END_MARKER}\n其實還有事。` }])
  doneAll(a)
  assert.equal(a.call.state.active, true, '記號在第一行')

  const b = mobile()
  await b.call.start([])   // 還沒說過話、沒寄過
  b.call.onLog([{ k: 'them', id: 'r2', text: `突然來信\n${CALL_END_MARKER}` }])
  doneAll(b)
  assert.equal(b.call.state.active, true, '沒有回覆通話中的信')
  assert.ok(b.native.spoken.every(s => !s.text.includes('結束通話')), '記號照樣不念')

  const c = await talked()
  c.call.onLog([{ k: 'me', id: 'r3', text: `我自己寫的\n${CALL_END_MARKER}` }])
  assert.equal(c.call.state.active, true, '自己寄的不算')
})

test('手機：等著念完掛斷時不再開始聽；新通話重新計算寄過幾封', async () => {
  const t = await talked()
  t.call.onLog([{ k: 'them', id: 'r1', text: `再見\n${CALL_END_MARKER}` }])
  const n = t.native.listening
  for (const x of t.timers.values()) x.f()
  assert.equal(t.native.listening, n, '等著念完時不開始聽')
  doneAll(t)
  assert.equal(await t.call.start([]), true)
  t.call.onLog([{ k: 'them', id: 'r9', text: `沒寄過信\n${CALL_END_MARKER}` }])
  doneAll(t)
  assert.equal(t.call.state.active, true)
})

// ---------- 電腦 ----------
function desktop() {
  const r = { sent: [], spoken: [], micStops: 0, listeners: new Set(), timers: new Map(), nextTimer: 1, time: 1_000_000 }
  r.mic = { rate: RATE, start: async ({ onChunk }) => { r.onChunk = onChunk }, stop: async () => { r.micStops++ } }
  r.player = { phase: 'idle', error: '', enqueue(key, text) { r.spoken.push(text); this.phase = 'playing'; r.notify() }, stop() { this.phase = 'idle' } }
  r.notify = () => { for (const f of r.listeners) f(r.player) }
  r.finishSpeaking = async () => { r.player.phase = 'idle'; r.notify(); await flush() }
  r.feed = take => { for (let i = 0; i < take.samples.length; i += 1600) r.onChunk(take.samples.slice(i, i + 1600)) }
  r.call = createCallSession({
    mic: r.mic, player: r.player, onTts: f => { r.listeners.add(f); return () => r.listeners.delete(f) },
    sttStatus: async () => ({ ready: true }), transcribe: async () => '你好嗎', send: t => r.sent.push(t),
    setTimer: (f, ms) => { const id = r.nextTimer++; r.timers.set(id, { f, at: r.time + ms }); return id }, clearTimer: id => { r.timers.delete(id) },
    setTick: () => 0, clearTick: () => {}, now: () => r.time,
  })
  return r
}
const sentence = () => build([0.6, 0.002, false], [1.5, 0.1, true], [1.5, 0.002, false])

test('電腦：對方回信最後一行是結束記號 → 記號不念、念完自動掛斷', async () => {
  const r = desktop()
  await r.call.start([])
  r.feed(sentence()); await flush()
  assert.equal(r.sent.length, 1)
  r.call.onLog([{ k: 'them', id: 'e1', text: `好的，再見。\n${CALL_END_MARKER}` }])
  assert.ok(r.spoken.length === 1 && !r.spoken[0].includes('結束通話'), '記號不念')
  assert.equal(r.call.state.reply, '好的，再見。')
  assert.equal(r.call.state.active, true, '還沒念完')
  await r.finishSpeaking()
  assert.equal(r.call.state.active, false)
  assert.equal(r.call.state.note, CALL_END_NOTE)
  assert.equal(r.micStops, 1)
})

test('電腦：只有記號的回信直接掛斷；沒寄過語音信、記號不在最後一行、不是對方寄的都不掛', async () => {
  const r = desktop()
  await r.call.start([])
  r.call.onLog([{ k: 'them', id: 'e0', text: `還沒說過話\n${CALL_END_MARKER}` }])
  await r.finishSpeaking()
  assert.equal(r.call.state.active, true, '還沒寄過語音信')
  r.time += 1000; for (const [id, x] of [...r.timers]) if (x.at <= r.time) { r.timers.delete(id); x.f() }   // 過了念完後的回音保護時間
  r.feed(sentence()); await flush()
  r.call.onLog([{ k: 'them', id: 'e1', text: `${CALL_END_MARKER}\n還有一件事。` }, { k: 'me', id: 'e2', text: `自己寫\n${CALL_END_MARKER}` }])
  await r.finishSpeaking()
  assert.equal(r.call.state.active, true, '記號不在最後一行／自己寄的')
  r.call.onLog([{ k: 'them', id: 'e3', text: CALL_END_MARKER }])
  assert.equal(r.call.state.active, false, '只有記號：沒有可念的，直接掛斷')
})
