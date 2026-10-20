// 「麥克風按下後停不了」的重現與守門：每一條都對應一個會卡住的路徑。
//   R 錄音中連點（第一次點擊還在等 stt_status／getUserMedia 時又點）、A 辨識永遠不回、B 準備麥克風（授權視窗）永遠不回、
//   C stt_status 永遠不回、D mic.stop 永遠不回、E 結束尾巴期間連點、F 多個面板共用同一個 voice、
//   G 第二次點擊不等 stt_status、H 取消後晚到的結果要丟掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { VoiceInput } from '../ui/lib/voice-input.mjs'
import { createVoiceUi } from '../ui/lib/voice-ui.mjs'
import { build } from './audio-helpers.mjs'

const speech = () => build([1, 0.003, false], [1.5, 0.1, true], [3, 0.003, false])
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
const never = () => new Promise(() => {})

function inputRig(over = {}) {
  const r = { log: [], notes: [], texts: [], micStarts: 0, micStops: 0, cancels: 0 }
  r.mic = { start: async () => { r.micStarts++ }, stop: async () => { r.micStops++; return speech() } }
  Object.assign(r.mic, over.mic)
  r.input = new VoiceInput({
    mic: r.mic, transcribe: over.transcribe || (async () => '你好嗎'), tailMs: over.tailMs ?? 0, wait: over.wait || (async () => {}),
    setTimer: over.setTimer || ((fn, ms) => (ms >= 60000 ? 0 : setTimeout(fn, ms))), clearTimer: t => clearTimeout(t),
    onState: s => r.log.push(s), onNote: n => r.notes.push(n), onText: t => r.texts.push(t), onCancelRecognize: () => { r.cancels++ },
    startTimeoutMs: over.startTimeoutMs, stopTimeoutMs: over.stopTimeoutMs, recognizeTimeoutMs: over.recognizeTimeoutMs,
  })
  return r
}

test('A 辨識永遠不回：再按一下就取消，回到 idle，通知後端結束辨識', async () => {
  const r = inputRig({ transcribe: never })
  await r.input.toggle()
  void r.input.toggle()
  await tick()
  assert.equal(r.input.state, 'recognizing')
  await r.input.toggle()
  assert.equal(r.input.state, 'idle')
  assert.equal(r.cancels, 1)
  assert.deepEqual(r.texts, [])
})

test('A2 辨識永遠不回、使用者也沒按：看門狗到時自己結束', async () => {
  const r = inputRig({ transcribe: never, recognizeTimeoutMs: 30 })
  await r.input.toggle()
  assert.equal(await r.input.toggle(), null)
  assert.equal(r.input.state, 'idle')
  assert.match(r.notes.at(-1), /逾時/)
  assert.equal(r.cancels, 1)
})

test('H 取消後晚到的辨識結果要丟掉，不能填進輸入框', async () => {
  let release
  const r = inputRig({ transcribe: () => new Promise(res => { release = res }) })
  await r.input.toggle()
  void r.input.toggle()
  await tick()
  await r.input.cancel()
  release('舊的字')
  await tick()
  assert.deepEqual(r.texts, [])
  assert.equal(r.input.state, 'idle')
})

test('B 準備麥克風卡住（授權視窗沒回應）：再按一下就取消，晚到的麥克風會被放掉；之後可再開始', async () => {
  let rej
  const r = inputRig({ mic: { start: () => { r.micStarts++; return new Promise((_, j) => { rej = j }) } } })
  const p = r.input.toggle()
  await tick()
  assert.equal(r.input.state, 'starting')
  await r.input.toggle()
  assert.equal(r.input.state, 'idle')
  assert.ok(r.micStops >= 1, '取消時放掉麥克風')
  rej(new Error('已取消'))
  assert.equal(await p, false)
  assert.equal(r.input.state, 'idle')
  r.mic.start = async () => { r.micStarts++ }
  assert.equal(await r.input.toggle(), true)
  assert.equal(r.input.state, 'recording')
})

test('R 準備麥克風時連點兩下：不會變成兩次 start；只剩 idle（第二下＝取消），或穩穩地錄音', async () => {
  const resolvers = []
  const r = inputRig({ mic: { start: () => { r.micStarts++; return new Promise(res => resolvers.push(res)) } } })
  const p1 = r.input.toggle()
  const p2 = r.input.toggle()
  await tick()
  resolvers.forEach(f => f())
  await Promise.all([p1, p2])
  assert.equal(r.micStarts, 1, '只開一次麥克風')
  assert.equal(r.input.state, 'idle')
})

test('R2 錄音狀態與麥克風不同步時，再按一下一定回到 idle', async () => {
  const r = inputRig({ mic: { stop: async () => ({ samples: new Float32Array(0), rate: 48000 }) } })
  await r.input.toggle()
  assert.equal(r.input.state, 'recording')
  await r.input.toggle()
  assert.equal(r.input.state, 'idle')
})

test('B2 麥克風永遠不回、也沒人按：逾時就放棄', async () => {
  const r = inputRig({ mic: { start: never }, startTimeoutMs: 30 })
  assert.equal(await r.input.toggle(), false)
  assert.equal(r.input.state, 'idle')
  assert.match(r.notes.at(-1), /麥克風/)
})

test('D mic.stop 永遠不回：不會卡在辨識中', async () => {
  const r = inputRig({ mic: { stop: never }, stopTimeoutMs: 30 })
  await r.input.toggle()
  assert.equal(await r.input.toggle(), null)
  assert.equal(r.input.state, 'idle')
})

test('E 結束的尾巴期間連點不會重複結束，也不會被當成取消', async () => {
  let go
  const r = inputRig({ tailMs: 280, wait: () => new Promise(res => { go = res }) })
  await r.input.toggle()
  const fin = r.input.toggle()
  await tick()
  await r.input.toggle()
  go()
  assert.equal(await fin, '你好嗎')
  assert.equal(r.micStops, 1)
  assert.deepEqual(r.texts, ['你好嗎'])
})

test('錄音中 cancel：停麥克風、不送', async () => {
  const r = inputRig()
  await r.input.toggle()
  await r.input.cancel()
  assert.equal(r.input.state, 'idle')
  assert.deepEqual(r.texts, [])
})

// ---- voice-ui（含多個面板共用一個 voice） ----
function uiRig({ status = async () => ({ ready: true }), transcribe = async () => '你好嗎' } = {}) {
  const calls = []
  const ui = createVoiceUi({
    invoke: async (cmd, args) => {
      calls.push(cmd)
      if (cmd === 'stt_status') return status()
      if (cmd === 'stt_transcribe') return transcribe(args)
      if (cmd === 'stt_cancel') return
      throw new Error('unexpected ' + cmd)
    },
    listen: async () => {},
    createMic: () => ({ start: async () => {}, stop: async () => speech() }),
    createAudio: () => ({ play: async () => {}, stop() {}, onended: null }),
  })
  return { ui, calls }
}

test('G 錄音中第二次點擊：不再問 stt_status，直接結束；已確認過的也不再問', async () => {
  const { ui, calls } = uiRig()
  const got = []
  await ui.toggleMic(t => got.push(t))
  assert.equal(ui.state.mic.phase, 'recording')
  await ui.toggleMic(t => got.push(t))
  assert.deepEqual(got, ['你好嗎'])
  assert.equal(calls.filter(c => c === 'stt_status').length, 1)
  await ui.toggleMic(() => {})
  assert.equal(calls.filter(c => c === 'stt_status').length, 1)
  assert.equal(ui.state.mic.phase, 'recording')
  await ui.cancelMic()   // 收掉 60 秒上限計時器
})

test('C stt_status 永遠不回：再按一下就取消，晚到的結果不會偷偷開始錄音', async () => {
  let rel
  const { ui } = uiRig({ status: () => new Promise(res => { rel = res }) })
  const p = ui.toggleMic(() => {})
  await tick()
  assert.equal(ui.state.mic.phase, 'starting')
  await ui.toggleMic(() => {})
  assert.equal(ui.state.mic.phase, 'idle')
  rel({ ready: true })
  await p
  await tick()
  assert.equal(ui.state.mic.phase, 'idle')
})

test('C2 stt_status 很慢時連點兩下：不會各開一次錄音，最後是 idle', async () => {
  const rels = []
  const { ui } = uiRig({ status: () => new Promise(res => rels.push(res)) })
  const p1 = ui.toggleMic(() => {})
  const p2 = ui.toggleMic(() => {})
  await tick()
  rels.forEach(f => f({ ready: true }))
  await Promise.all([p1, p2])
  await tick()
  assert.equal(ui.state.mic.phase, 'idle')
})

test('F 多個面板共用一個 voice：面板 A 開始、面板 B 按結束，字填進按結束的那個面板', async () => {
  const { ui } = uiRig()
  const a = [], b = []
  await ui.toggleMic(t => a.push(t))
  await ui.toggleMic(t => b.push(t))
  assert.deepEqual(a, [])
  assert.deepEqual(b, ['你好嗎'])
  assert.equal(ui.state.mic.phase, 'idle')
})

test('辨識卡住時 cancelMic（Esc）：回到 idle、呼叫 stt_cancel、字不會出現', async () => {
  const { ui, calls } = uiRig({ transcribe: never })
  const got = []
  await ui.toggleMic(t => got.push(t))
  void ui.toggleMic(t => got.push(t))
  await tick(400)
  assert.equal(ui.state.mic.phase, 'recognizing')
  await ui.cancelMic()
  assert.equal(ui.state.mic.phase, 'idle')
  assert.ok(calls.includes('stt_cancel'))
  assert.deepEqual(got, [])
})

test('介面：麥克風按鈕任何時候都不 disabled、Esc 可取消、有狀態文字', () => {
  const s = fs.readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  const btn = s.split('\n').find(l => l.includes('class="tool icon mic"'))
  assert.ok(btn, '找得到麥克風按鈕')
  assert.doesNotMatch(btn, /:disabled/, '辨識中不可以 disabled，否則使用者停不了')
  assert.match(s, /Escape[\s\S]{0,300}cancelMic/)
  const v = fs.readFileSync(new URL('../ui/lib/voice-input.mjs', import.meta.url), 'utf8')
  assert.match(v, /聆聽中/)
  assert.match(v, /辨識中…按一下取消/)
})
