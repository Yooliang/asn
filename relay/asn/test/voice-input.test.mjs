// 語音輸入流程（假麥克風、假辨識）：只填文字、永遠不送信；沒人聲不送辨識；幻覺字丟掉；修掉頭尾；可取消。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoiceInput } from '../ui/lib/voice-input.mjs'
import { build } from './audio-helpers.mjs'

function rig({ take, say = '你好嗎', tailMs = 0, micStartError = null } = {}) {
  const log = [], notes = [], texts = []
  const r = {
    log, notes, texts, wavs: [], micStops: 0, micStarts: 0,
    mic: {
      start: async () => { r.micStarts++; if (micStartError) throw new Error(micStartError) },
      stop: async () => { r.micStops++; return take },
    },
    transcribe: async wav => { r.wavs.push(wav); if (say instanceof Error) throw say; return say },
  }
  r.input = new VoiceInput({ mic: r.mic, transcribe: r.transcribe, tailMs, wait: async () => {}, setTimer: () => 0, clearTimer: () => {}, onState: s => log.push(s), onNote: n => notes.push(n), onText: t => texts.push(t) })
  return r
}
const speech = () => build([1, 0.003, false], [1.5, 0.1, true], [3, 0.003, false])
const wavSeconds = b64 => (Buffer.from(b64, 'base64').length - 44) / 32000

test('按一下開始、再按一下辨識：文字交給 onText，流程 idle→recording→recognizing→idle', async () => {
  const r = rig({ take: speech() })
  assert.equal(await r.input.toggle(), true)
  assert.equal(r.input.state, 'recording')
  assert.equal(await r.input.toggle(), '你好嗎')
  assert.deepEqual(r.log, ['starting', 'recording', 'recognizing', 'idle'])
  assert.deepEqual(r.texts, ['你好嗎'])
  assert.equal(r.input.state, 'idle')
})

test('句尾長段安靜不送去辨識（修掉頭尾）；送的是 16 kHz 單聲道 WAV', async () => {
  const r = rig({ take: speech() })
  await r.input.toggle(); await r.input.toggle()
  assert.equal(r.wavs.length, 1)
  const buf = Buffer.from(r.wavs[0], 'base64')
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF')
  assert.equal(buf.readUInt32LE(24), 16000)
  assert.ok(wavSeconds(r.wavs[0]) < 3, `送出 ${wavSeconds(r.wavs[0])} 秒，應該遠小於原本的 5.5 秒`)
})

test('沒人聲：不呼叫辨識，提示「沒聽到聲音」', async () => {
  const r = rig({ take: build([3, 0.025, false]) })
  await r.input.toggle(); await r.input.toggle()
  assert.equal(r.wavs.length, 0)
  assert.equal(r.texts.length, 0)
  assert.equal(r.notes.at(-1), '沒聽到聲音。')
  assert.equal(r.input.state, 'idle')
})

test('完全靜音與太短的錄音也不送辨識', async () => {
  for (const [take, note] of [[{ samples: new Float32Array(16000 * 2), rate: 16000 }, '沒聽到聲音。'], [build([0.1, 0.1, true]), '說話時間太短。']]) {
    const r = rig({ take })
    await r.input.toggle(); await r.input.toggle()
    assert.equal(r.wavs.length, 0)
    assert.equal(r.notes.at(-1), note)
  }
})

test('辨識出來整句是幻覺字：丟掉、記下原文、不填進輸入框', async () => {
  const r = rig({ take: speech(), say: '（字幕製作:貝爾）' })
  await r.input.toggle(); await r.input.toggle()
  assert.deepEqual(r.texts, [])
  assert.equal(r.input.lastDropped, '（字幕製作:貝爾）')
  assert.equal(r.notes.at(-1), '沒聽到聲音。')
})

test('辨識結果簡體會轉繁體；半形標點換全形', async () => {
  const r = rig({ take: speech(), say: '请帮我订机票,谢谢' })
  await r.input.toggle(); await r.input.toggle()
  assert.deepEqual(r.texts, ['請幫我訂機票，謝謝'])
})

test('辨識失敗：回到 idle 並顯示原因，不填字', async () => {
  const r = rig({ take: speech(), say: new Error('還沒下載語音辨識') })
  await r.input.toggle(); await r.input.toggle()
  assert.equal(r.notes.at(-1), '還沒下載語音辨識')
  assert.equal(r.input.state, 'idle')
  assert.deepEqual(r.texts, [])
})

test('麥克風開不起來：顯示原因、維持 idle', async () => {
  const r = rig({ take: speech(), micStartError: '麥克風沒有授權。' })
  assert.equal(await r.input.toggle(), false)
  assert.equal(r.input.state, 'idle')
  assert.equal(r.notes.at(-1), '麥克風沒有授權。')
})

test('取消：停掉麥克風、什麼都不送', async () => {
  const r = rig({ take: speech() })
  await r.input.toggle()
  await r.input.cancel()
  assert.equal(r.input.state, 'idle')
  assert.equal(r.micStops, 1)
  assert.equal(r.wavs.length, 0)
})

test('辨識中再按：取消（不重複送、晚到的結果丟掉）', async () => {
  let release
  const r = rig({ take: speech() })
  r.input.transcribe = () => new Promise(res => { release = res })
  await r.input.toggle()
  const p = r.input.toggle()
  await new Promise(res => setImmediate(res))
  assert.equal(r.input.state, 'recognizing')
  await r.input.toggle()
  assert.equal(r.input.state, 'idle')
  release('好')
  assert.equal(await p, null)
  assert.equal(r.wavs.length, 0)
  assert.deepEqual(r.texts, [])
})

test('錄到上限自動結束', async () => {
  let fire
  const r = rig({ take: speech() })
  r.input.setTimer = fn => { fire = fn; return 1 }
  await r.input.toggle()
  assert.ok(fire, '開始錄就設了上限計時器')
  fire()
  await new Promise(res => setTimeout(res, 10))
  assert.deepEqual(r.texts, ['你好嗎'])
})

test('結束時會多錄一小段尾巴（不吃掉最後的字）', async () => {
  let waited = 0
  const r = rig({ take: speech(), tailMs: 280 })
  r.input.wait = async ms => { waited = ms }
  await r.input.toggle(); await r.input.toggle()
  assert.equal(waited, 280)
})
