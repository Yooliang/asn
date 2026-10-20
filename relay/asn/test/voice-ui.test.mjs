// 語音接線（假 Tauri、假麥克風）：沒下載辨識就先問；辨識完只把字交給輸入框；念出訊息只送文字；全程不呼叫寄信。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceUi } from '../ui/lib/voice-ui.mjs'
import { AUTO_CHOICES, DEFAULT_CFG, normalizeCfg, shouldAutoSpeak, sttStatusText } from '../ui/lib/voice-prefs.mjs'
import { build } from './audio-helpers.mjs'

function rig({ ready = true } = {}) {
  const calls = [], listeners = {}, seen = []
  const take = build([1, 0.003, false], [1.5, 0.1, true], [3, 0.003, false])
  const r = {
    calls, listeners, ready, seen,
    invoke: async (cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'stt_status') return { ready: r.ready, engine: r.ready }
      if (cmd === 'stt_transcribe') return '你好嗎'
      if (cmd === 'stt_install') { r.ready = true; listeners['asn:stt-progress']?.({ stage: 'engine', done: 4 * 1048576, total: 8 * 1048576 }); r.seen.push(r.ui.state.install.text); return }
      if (cmd === 'tts_speak') return { mime: 'audio/mpeg', audio: 'QUJD' }
      throw new Error('unexpected ' + cmd)
    },
    listen: async (evt, fn) => { listeners[evt] = fn },
  }
  r.ui = createVoiceUi({
    invoke: r.invoke, listen: r.listen,
    createMic: () => ({ start: async () => {}, stop: async () => take }),
    createAudio: () => ({ play: async () => {}, stop() {}, onended: null }),
  })
  return r
}

test('語音輸入：辨識完的字交給輸入框的回呼，不呼叫任何寄信指令', async () => {
  const r = rig()
  const got = []
  await r.ui.toggleMic(t => got.push(t))
  assert.equal(r.ui.state.mic.phase, 'recording')
  await r.ui.toggleMic()
  assert.deepEqual(got, ['你好嗎'])
  assert.equal(r.ui.state.mic.phase, 'idle')
  assert.ok(!r.calls.some(([c]) => /send|relay_/.test(c)), '語音輸入不會自動送信')
  assert.deepEqual(r.calls.map(c => c[0]), ['stt_status', 'stt_transcribe'])
})

test('還沒下載辨識：先顯示下載提示，不開麥克風', async () => {
  const r = rig({ ready: false })
  await r.ui.toggleMic(() => {})
  assert.equal(r.ui.state.install.needed, true)
  assert.equal(r.ui.state.mic.phase, 'idle')
  r.ui.dismissInstall()
  assert.equal(r.ui.state.install.needed, false)
})

test('按下載：呼叫安裝、顯示進度、完成後提示可以用了', async () => {
  const r = rig({ ready: false })
  await r.ui.toggleMic(() => {})
  await r.ui.installStt()
  assert.match(r.seen[0], /正在下載辨識引擎… 4 MB \/ 8 MB/)
  assert.equal(r.ui.state.install.needed, false)
  assert.equal(r.ui.state.install.busy, false)
  assert.match(r.ui.state.note, /準備好了/)
  assert.ok(r.calls.some(([c]) => c === 'stt_install'))
})

test('念出訊息：只把整理過的文字交給 tts_speak，不帶金鑰', async () => {
  const r = rig()
  await r.ui.speak('m1', '你好 :) https://x.example/a')
  const c = r.calls.find(([n]) => n === 'tts_speak')
  assert.deepEqual(c[1], { text: '你好' })
  assert.equal(r.ui.state.tts.phase, 'playing')
  r.ui.stopSpeaking()
  assert.equal(r.ui.state.tts.phase, 'idle')
})

test('語音設定：壞值退回預設；自動念預設關；只有對方的新訊息才自動念', () => {
  assert.deepEqual(normalizeCfg(null), DEFAULT_CFG)
  assert.deepEqual(normalizeCfg({ tts_voice: 5, tts_auto: 'yes', stt_lang: 'xx', stt_model: '../x' }), DEFAULT_CFG)
  assert.equal(DEFAULT_CFG.tts_auto, false)
  assert.deepEqual(AUTO_CHOICES, ['off', 'on'])
  const on = { tts_auto: true }
  assert.equal(shouldAutoSpeak({ kind: 'msg', line: '嗨' }, DEFAULT_CFG, 'online'), false, '預設關')
  assert.equal(shouldAutoSpeak({ kind: 'msg', line: '嗨' }, on, 'online'), true)
  assert.equal(shouldAutoSpeak({ kind: 'msg', line: '嗨' }, on, 'busy'), false, '忙碌中不念')
  assert.equal(shouldAutoSpeak({ kind: 'nudge', line: '傳送了一個震動' }, on, 'online'), false)
  assert.equal(shouldAutoSpeak({ kind: 'login', line: '已經登入' }, on, 'online'), false)
  assert.equal(shouldAutoSpeak({ kind: 'msg', line: '  ' }, on, 'online'), false)
  assert.match(sttStatusText({ ready: true }), /已準備好/)
  assert.match(sttStatusText({ ready: false, engine: false }), /還沒下載/)
})

// 守門：金鑰只在 Rust。前端程式與設定檔不出現金鑰變數名，語音程式不直接 fetch 任何網址
test('前端語音程式不碰金鑰、不直接連網', async () => {
  const fs = await import('node:fs')
  for (const f of ['voice-ui', 'voice-input', 'tts-player', 'mic', 'voice-prefs']) {
    const s = fs.readFileSync(new URL(`../ui/lib/${f}.mjs`, import.meta.url), 'utf8')
    assert.doesNotMatch(s, /x-relay-key|x-asn-tts-secret|ASN_EDGE_TTS|\bfetch\(|XMLHttpRequest|WebSocket/, f)
  }
})
