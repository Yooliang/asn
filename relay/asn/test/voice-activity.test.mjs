// 人聲偵測與頭尾修剪（移植自 Irori 的 VoiceActivityTests）：沒人聲不送辨識、修掉頭尾的安靜。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_KEEP_SECONDS, PAD_SECONDS, SILENCE_PEAK, analyze, hasSpeech, peakOf, secondsOf, trim } from '../ui/lib/voice-activity.mjs'
import { RATE, build } from './audio-helpers.mjs'

const tone = sec => build([sec, 0.1, true])

test('完全靜音、空的、沒有：都沒人聲', () => {
  assert.equal(hasSpeech({ samples: new Float32Array(RATE * 2), rate: RATE }), false)
  assert.equal(hasSpeech({ samples: new Float32Array(0), rate: RATE }), false)
  assert.equal(hasSpeech(null), false)
})

test('安靜房間的穩定底噪（風扇）不算人聲，就算峰值超過舊的峰值門檻', () => {
  const take = build([3, 0.025, false])
  assert.ok(peakOf(take) > SILENCE_PEAK, '這種底噪舊的峰值門檻擋不住')
  assert.equal(hasSpeech(take), false, JSON.stringify(analyze(take)))
})

test('碰到麥克風的一聲（40 毫秒）不算人聲', () => {
  const take = build([1, 0.002, false], [0.04, 0.5, true], [1, 0.002, false])
  assert.equal(hasSpeech(take), false)
})

test('底噪裡的一句話找得到，長度約 0.6 秒', () => {
  const take = build([1, 0.004, false], [0.6, 0.1, true], [2, 0.004, false])
  const r = analyze(take)
  assert.equal(r.hasSpeech, true)
  assert.ok(Math.abs(r.voicedSeconds - 0.6) < 0.05, String(r.voicedSeconds))
})

test('小聲講話配很安靜的房間也找得到', () => {
  assert.equal(hasSpeech(build([0.5, 0.001, false], [0.8, 0.02, true], [0.5, 0.001, false])), true)
})

test('整段都在講話：找得到，而且不修剪（交回同一份）', () => {
  const take = tone(2)
  const r = analyze(take)
  assert.equal(r.hasSpeech, true, '整段都在講話：底噪很高，門檻不能跟著高到把話擋掉')
  assert.equal(trim(take, r), take)
})

test('修頭尾：長段安靜修掉，人聲前後各留一點', () => {
  const take = build([1, 0.003, false], [1.5, 0.1, true], [3, 0.003, false])
  const cut = trim(take)
  assert.ok(Math.abs(secondsOf(cut) - (1.5 + 2 * PAD_SECONDS)) < 0.05, String(secondsOf(cut)))
  assert.equal(cut.rate, RATE)
  assert.ok(peakOf(cut) > 0.09, '人聲留著')
})

test('很短的一句「好」後面一大段安靜：修完也要留 1.2 秒（whisper.cpp 不處理短於 1 秒的）', () => {
  const cut = trim(build([0.2, 0.003, false], [0.3, 0.1, true], [4, 0.003, false]))
  assert.ok(Math.abs(secondsOf(cut) - MIN_KEEP_SECONDS) < 0.03, String(secondsOf(cut)))
  assert.ok(peakOf(cut) > 0.09)
})

test('本來就不到 1.2 秒：整段送；沒人聲：交回同一份', () => {
  const short = build([0.2, 0.003, false], [0.4, 0.1, true], [0.3, 0.003, false])
  assert.equal(trim(short), short)
  const quiet = build([2, 0.002, false])
  assert.equal(trim(quiet), quiet)
})
