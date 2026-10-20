import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SPEAK_MAX, TtsPlayer, speakableText } from '../ui/lib/tts-player.mjs'

test('念出前整理文字：程式碼區塊、網址、表情代碼、排版符號都拿掉', () => {
  assert.equal(speakableText('你好 :) 世界'), '你好 世界')
  assert.equal(speakableText('看這個 https://example.com/a?b=1 就好'), '看這個 就好')
  assert.equal(speakableText('先這樣：\n```js\nconsole.log(1)\n```\n然後呢'), '先這樣： 然後呢')
  assert.equal(speakableText('## 標題\n- 項目一\n- **項目二**'), '標題 項目一 項目二')
  assert.equal(speakableText('   \n '), '')
  assert.equal(speakableText(null), '')
})

test('太長就截斷，優先在句子邊界；不超過上限', () => {
  const long = '這是一句話。'.repeat(400)
  const out = speakableText(long)
  assert.ok([...out].length <= SPEAK_MAX)
  assert.ok(out.endsWith('。'))
  const noStop = '字'.repeat(SPEAK_MAX + 500)
  assert.equal([...speakableText(noStop)].length, SPEAK_MAX)
  // 表情符號以字元算，不會被切成亂碼
  assert.equal([...speakableText('😀'.repeat(SPEAK_MAX + 5))].length, SPEAK_MAX)
})

function rig() {
  const r = { fetched: [], audios: [], changes: [], failFetch: null }
  r.p = new TtsPlayer({
    fetchAudio: async text => { r.fetched.push(text); if (r.failFetch) throw new Error(r.failFetch); return { mime: 'audio/mpeg', audio: 'QUJD' } },
    createAudio: () => {
      const a = { plays: 0, stops: 0, onended: null, play: async () => { a.plays++ }, stop: () => { a.stops++ } }
      r.audios.push(a)
      return a
    },
    onChange: p => r.changes.push(`${p.phase}:${p.key}`),
  })
  return r
}

test('播放：loading → playing → 播完回 idle', async () => {
  const r = rig()
  await r.p.toggle('m1', '你好')
  assert.deepEqual(r.fetched, ['你好'])
  assert.equal(r.p.phase, 'playing')
  assert.equal(r.p.key, 'm1')
  r.audios[0].onended()
  assert.equal(r.p.phase, 'idle')
  assert.deepEqual(r.changes, ['loading:m1', 'playing:m1', 'idle:'])
})

test('再按同一則＝停止；按另一則＝換過去（舊的被停掉）', async () => {
  const r = rig()
  await r.p.toggle('m1', 'a')
  await r.p.toggle('m1', 'a')
  assert.equal(r.p.phase, 'idle')
  assert.equal(r.audios[0].stops, 1)
  await r.p.toggle('m1', 'a')
  await r.p.toggle('m2', 'b')
  assert.equal(r.audios[1].stops, 1)
  assert.equal(r.p.key, 'm2')
  assert.equal(r.p.phase, 'playing')
})

test('取音檔失敗：回 idle，帶白話原因；沒有可念的文字不呼叫後台', async () => {
  const r = rig()
  r.failFetch = '維護者還沒有在後台啟用念出訊息。'
  await r.p.toggle('m1', '你好')
  assert.equal(r.p.phase, 'idle')
  assert.equal(r.p.error, '維護者還沒有在後台啟用念出訊息。')
  r.failFetch = null
  r.fetched.length = 0
  await r.p.toggle('m2', '```\ncode only\n```')
  assert.equal(r.fetched.length, 0)
  assert.match(r.p.error, /沒有可以念的文字/)
})

test('取音檔途中被停止：晚到的音檔不會播出來', async () => {
  let release
  const audios = []
  const p = new TtsPlayer({ fetchAudio: () => new Promise(res => { release = res }), createAudio: () => { const a = { play: async () => {}, stop() {}, onended: null }; audios.push(a); return a } })
  const pending = p.toggle('m1', '你好')
  await new Promise(res => setImmediate(res))
  assert.equal(p.phase, 'loading')
  p.stop()
  release({ mime: 'audio/mpeg', audio: 'QUJD' })
  await pending
  assert.equal(audios.length, 0)
  assert.equal(p.phase, 'idle')
})

test('自動念：忙碌中排隊，播完接著念；最多排 3 則，滿了丟最舊的', async () => {
  const r = rig()
  r.p.enqueue('a', '第一則')
  await new Promise(res => setImmediate(res))
  assert.equal(r.p.phase, 'playing')
  for (const t of ['二', '三', '四', '五']) r.p.enqueue('k' + t, t)
  assert.deepEqual(r.p.queue.map(q => q.text), ['三', '四', '五'])
  r.audios[0].onended()
  await new Promise(res => setImmediate(res))
  assert.deepEqual(r.fetched, ['第一則', '三'])
})
