import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MAX_SEGMENTS, SEG_MAX, speechSegments, splitSentences } from '../ui/lib/speech-split.mjs'
import { TtsPlayer } from '../ui/lib/tts-player.mjs'

const tick = () => new Promise(res => setImmediate(res))

test('切句：中英文句尾標點與換行，標點留在句尾，小數點不切', () => {
  assert.deepEqual(splitSentences('好的。你呢？太棒了！'), ['好的。', '你呢？', '太棒了！'])
  assert.deepEqual(splitSentences('第一行\n第二行'), ['第一行', '第二行'])
  assert.deepEqual(splitSentences('Done. Next one! 3.5 is fine'), ['Done.', 'Next one!', '3.5 is fine'])
  assert.deepEqual(splitSentences('他說「好。」然後走了。'), ['他說「好。」', '然後走了。'])
  assert.deepEqual(splitSentences('  \n '), [])
})

test('分段：第一段只放第一句（太短併下一句）、後面合併成長段、段數有上限', () => {
  assert.deepEqual(speechSegments('收到。'), ['收到。'])
  assert.deepEqual(speechSegments(''), [])
  const segs = speechSegments('我先看一下這個問題。接著跑測試。然後回報結果。')
  assert.equal(segs[0], '我先看一下這個問題。')
  assert.equal(segs.length, 2)
  assert.equal(speechSegments('好。我知道了。')[0], '好。 我知道了。', '語氣詞太短要併下一句')
  const many = Array.from({ length: 40 }, (_, i) => `這是第${i}句很長很長的話需要念出來。`).join('')
  const out = speechSegments(many)
  assert.ok(out.length <= MAX_SEGMENTS)
  assert.equal(out.join('').replace(/\s/g, ''), many, '串起來等於原文')
  assert.ok([...out[1]].length <= SEG_MAX + 30)
})

function rig() {
  const r = { fetched: [], audios: [], changes: [], pend: [] }
  r.p = new TtsPlayer({
    fetchAudio: text => { r.fetched.push(text); return new Promise((res, rej) => r.pend.push({ text, res: () => res({ mime: 'audio/mpeg', audio: 'QUJD' }), rej })) },
    createAudio: () => { const a = { plays: 0, stops: 0, onended: null, play: async () => { a.plays++ }, stop: () => { a.stops++ } }; r.audios.push(a); return a },
    onChange: p => r.changes.push(`${p.phase}`),
  })
  return r
}

test('邊合成邊念：第一段好了就播，播的同時下一段已在合成；段間不回 idle', async () => {
  const r = rig()
  void r.p.play('c1', '我先看一下這個問題。接著跑測試。然後回報結果。', { stream: true })
  await tick()
  assert.equal(r.fetched.length, 1, '一開始只合成第一段')
  r.pend[0].res(); await tick()
  assert.equal(r.audios.length, 1)
  assert.equal(r.p.phase, 'playing')
  assert.equal(r.fetched.length, 2, '第一段開播時，第二段同時開始合成')
  r.audios[0].onended(); await tick()
  assert.equal(r.p.phase, 'playing', '段與段之間維持念出中（通話才不會誤以為念完）')
  assert.ok(!r.changes.slice(2).includes('idle'))
  r.pend[1].res(); await tick()
  assert.equal(r.audios.length, 2)
  r.audios[1].onended(); await tick()
  assert.equal(r.p.phase, 'idle')
})

test('分段念到一半被停止：後面的段不再播；中途一段合成失敗：回 idle 帶原因', async () => {
  const r = rig()
  void r.p.play('c1', '我先看一下這個問題。接著跑測試。然後回報結果。', { stream: true })
  await tick(); r.pend[0].res(); await tick()
  r.p.stop()
  r.audios[0].onended?.()
  r.pend[1].res(); await tick()
  assert.equal(r.audios.length, 1)
  assert.equal(r.p.phase, 'idle')
  const q = rig()
  void q.p.play('c2', '我先看一下這個問題。接著跑測試。', { stream: true })
  await tick(); q.pend[0].res(); await tick()
  q.audios[0].onended(); q.pend[1].rej(new Error('後台忙線')); await tick(); await tick()
  assert.equal(q.p.phase, 'idle')
  assert.equal(q.p.error, '後台忙線')
})

test('不帶 stream 照舊整段一次合成；排隊會保留 stream 選項', async () => {
  const r = rig()
  void r.p.play('m', '第一句。第二句。')
  await tick()
  assert.deepEqual(r.fetched, ['第一句。第二句。'])
  r.p.enqueue('x', '甲。乙。', { stream: true })
  assert.equal(r.p.queue[0].opts.stream, true)
})

test('守門：通話念回信走分段', () => {
  const s = fs.readFileSync(new URL('../ui/lib/call-session.mjs', import.meta.url), 'utf8')
  assert.match(s, /player\.enqueue\(`call:\$\{\+\+spoken\}`, say, \{ stream: true \}\)/)
})
