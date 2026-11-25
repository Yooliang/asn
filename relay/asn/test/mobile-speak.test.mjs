// 手機念出訊息（#2304）：該不該自動念（每一種「不念」各一支）、喇叭鈕念的內容走共用去格式、停止再按、
// 聲音清單取不到回空清單並寫 log、設定預設關。外殼與計時都用假的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AUTO_SPEAK_MAX_AGE_MS, AUTO_QUEUE_MAX, autoSpeakPlan, createMobileSpeaker } from '../ui/lib/mobile-speak.mjs'
import { speakableText } from '../ui/lib/tts-player.mjs'
import { androidBridge, normalizePrefs, DEFAULT_PREFS } from '../ui/lib/mobile.mjs'

const NOW = 1_000_000_000_000
const ON = { tts_auto: true }
const msg = (o = {}) => ({ kind: 'msg', friend: { id: 'A' }, line: '你好，今天的進度如下。', at: NOW - 1000, mine: false, ...o })
const plan = (n, o = {}) => autoSpeakPlan(n, { cfg: ON, foreground: true, calling: false, now: NOW, ...o })

test('自動念：對方的新訊息、設定開著、在前景 → 念', () => {
  assert.deepEqual(plan(msg()), { ok: true, why: '' })
})
test('自動念：設定預設關（沒有設定、舊存檔）不念', () => {
  assert.equal(plan(msg(), { cfg: undefined }).why, 'off')
  assert.equal(plan(msg(), { cfg: normalizePrefs({}).voice }).why, 'off')
  assert.equal(plan(msg(), { cfg: { tts_auto: false } }).why, 'off')
})
test('自動念：不是訊息（震動、登入、上下文提醒）不念', () => {
  for (const kind of ['nudge', 'login', 'context', undefined]) assert.equal(plan(msg({ kind })).why, 'not-msg')
  assert.equal(plan(null).why, 'not-msg')
})
test('自動念：App 在背景不念', () => {
  assert.equal(plan(msg(), { foreground: false }).why, 'background')
})
test('自動念：自己發的不念', () => {
  assert.equal(plan(msg({ mine: true })).why, 'mine')
})
test('自動念：歷史訊息（太舊、沒有時間）不念', () => {
  assert.equal(plan(msg({ at: NOW - AUTO_SPEAK_MAX_AGE_MS - 1 })).why, 'history')
  assert.equal(plan(msg({ at: undefined })).why, 'history')
  assert.equal(plan(msg({ at: NOW - AUTO_SPEAK_MAX_AGE_MS })).ok, true, '剛好在時限內還是念')
})
test('自動念：補收的合併提示（「收到 N 封你不在時代收的信」）不念', () => {
  assert.equal(plan(msg({ digest: true })).why, 'digest')
})
test('自動念：通話中不念', () => {
  assert.equal(plan(msg(), { calling: true }).why, 'calling')
})
test('自動念：沒有可念的字（只有符號、程式碼）不念', () => {
  assert.equal(plan(msg({ line: '```\ncode\n```' })).why, 'empty')
  assert.equal(plan(msg({ line: '   ' })).why, 'empty')
})

function fakeNative() {
  let h = null
  const n = {
    spoken: [], stops: 0,
    speak(id, text, voice) { n.spoken.push({ id, text, voice }) },
    stop() { n.stops++ },
    onEvent(f) { h = f; return () => { h = null } },
    emit(e) { h?.(e) },
  }
  return n
}
function clock() {
  let seq = 0; const t = new Map()
  return { setTimer: (f, ms) => { t.set(++seq, { f, ms }); return seq }, clearTimer: id => t.delete(id), fire: () => { for (const [id, x] of [...t]) { t.delete(id); x.f() } }, size: () => t.size }
}

test('喇叭鈕：念出的內容走共用去格式，不念出 Markdown 符號、程式碼、網址', () => {
  const n = fakeNative()
  const sp = createMobileSpeaker({ native: n })
  const raw = '## 標題\n**重點**：看 https://x.example/a 這裡\n```js\nconst a = 1\n```\n- 第一項'
  sp.speak('k1', raw)
  const said = n.spoken.map(s => s.text).join('')
  assert.ok(said.length > 0)
  assert.doesNotMatch(said, /[*#`>|~_]|https?:|const a/)
  assert.equal(said.replace(/\s+/g, ''), speakableText(raw).replace(/\s+/g, ''), '與通話、電腦版同一支 speakableText 的結果一致')
})
test('喇叭鈕：念的時候是停止鈕，同一則再按就停；按另一則換過去', () => {
  const n = fakeNative()
  const sp = createMobileSpeaker({ native: n })
  sp.speak('a', '第一則。')
  assert.equal(sp.state.tts.key, 'a'); assert.equal(sp.state.tts.phase, 'speaking')
  sp.speak('a', '第一則。')
  assert.equal(sp.state.tts.phase, 'idle'); assert.ok(n.stops >= 1, '有叫外殼停')
  sp.speak('a', '第一則。'); sp.speak('b', '第二則。')
  assert.equal(sp.state.tts.key, 'b')
})
test('喇叭鈕：念完（外殼回報）回到可按；外殼一直沒回報由保險計時收掉', () => {
  const n = fakeNative(), c = clock(), logs = []
  const sp = createMobileSpeaker({ native: n, ...c, log: m => logs.push(m) })
  sp.speak('a', '短短一句。')
  n.emit({ t: 'read-done', id: n.spoken[0].id })
  assert.equal(sp.state.tts.phase, 'idle')
  sp.speak('a', '短短一句。')
  c.fire()
  assert.equal(sp.state.tts.phase, 'idle'); assert.ok(logs.some(m => /保險計時/.test(m)), '收掉要留 log')
})
test('喇叭鈕：外殼回報錯誤 → 回到可按、畫面有白話錯誤、log 有原文', () => {
  const n = fakeNative(), logs = []
  const sp = createMobileSpeaker({ native: n, log: m => logs.push(m) })
  sp.speak('a', '一句話。')
  n.emit({ t: 'read-error', message: '這支手機沒有中文語音' })
  assert.equal(sp.state.tts.phase, 'idle'); assert.match(sp.state.tts.error, /念不出來/); assert.ok(logs.length >= 1)
})
test('喇叭鈕：念出時帶設定的聲音', () => {
  const n = fakeNative()
  createMobileSpeaker({ native: n, voice: () => 'cmn-tw-x-abc-local' }).speak('a', '一句話。')
  assert.equal(n.spoken[0].voice, 'cmn-tw-x-abc-local')
})
test('自動念排隊：最多 3 則，超過丟掉最舊的', () => {
  const n = fakeNative()
  const sp = createMobileSpeaker({ native: n })
  sp.speakAuto('k0', '零。')
  for (let i = 1; i <= AUTO_QUEUE_MAX + 2; i++) sp.speakAuto(`k${i}`, `第${i}則。`)
  n.emit({ t: 'read-done', id: n.spoken[0].id })
  assert.equal(sp.state.tts.key, 'k3', '排隊裡最舊的 k1、k2 被丟掉')
})

test('聲音清單：取不到（外殼沒回應、格式壞、引擎沒啟動）回空清單並寫一行 log', async () => {
  const logs = []; const orig = console.info; console.info = (...a) => logs.push(a.join(' '))
  try {
    const mk = readVoices => androidBridge({ AsnAndroid: { vibrate() {}, callAvailable: () => true, readAvailable: () => true, readVoices, readSpeak() {}, readStop() {} } })
    for (const bad of [() => '壞掉的{', () => JSON.stringify({ voices: [], langs: [], error: '引擎沒有啟動' })]) {
      logs.length = 0
      assert.deepEqual(await mk(bad).read.voices(), { voices: [], langs: [] })
      assert.equal(logs.filter(l => /取不到聲音清單/.test(l)).length, 1, '剛好一行 log')
    }
    logs.length = 0
    const ok = await mk(() => JSON.stringify({ voices: [{ id: 'v1', name: 'v1', lang: 'zh-TW', quality: 400, needsNet: false }], langs: ['zh-TW'] })).read.voices()
    assert.equal(ok.voices.length, 1); assert.deepEqual(ok.langs, ['zh-TW']); assert.equal(logs.length, 0)
  } finally { console.info = orig }
})
test('聲音清單：引擎啟動中先回 pending，之後用 read-voices 事件送', async () => {
  const win = { AsnAndroid: { vibrate() {}, callAvailable: () => true, readAvailable: () => true, readVoices: () => 'pending', readSpeak() {}, readStop() {} } }
  const b = androidBridge(win)
  const p = b.read.voices()
  win.__asnReadEvent(JSON.stringify({ t: 'read-voices', voices: [{ id: 'x', name: 'x', lang: 'zh-TW' }], langs: ['zh-TW'] }))
  assert.equal((await p).voices[0].id, 'x')
})
test('外殼太舊或這支手機沒有語音合成：沒有 read（不顯示喇叭鈕）', () => {
  assert.equal(androidBridge({ AsnAndroid: { vibrate() {} } }).read, null)
  assert.equal(androidBridge({ AsnAndroid: { vibrate() {}, readAvailable: () => false } }).read, null)
})

test('設定：mobilePrefs.voice 預設關、壞值退回預設、只存手機有的三項', () => {
  assert.deepEqual(DEFAULT_PREFS.voice, { tts_voice: '', tts_auto: false, stt_lang: 'zh' })
  assert.equal(normalizePrefs({ voice: { tts_auto: 'yes' } }).voice.tts_auto, false)
  assert.equal(normalizePrefs({ voice: { tts_auto: true, stt_model: 'base' } }).voice.tts_auto, true)
  assert.equal('stt_model' in normalizePrefs({ voice: { stt_model: 'base' } }).voice, false)
})

test('接線：對話區同一顆喇叭鈕吃 speakApi，手機頁面有傳；Kotlin 外殼有對應方法', () => {
  const pane = readFileSync(new URL('../ui/lib/chatpane.mjs', import.meta.url), 'utf8')
  assert.match(pane, /speakApi: \{ type: Object/); assert.doesNotMatch(pane, /v-if="voice && m\.k === 'them'/)
  assert.match(readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8'), /:speak-api="speakApi"/)
  const kt = readFileSync(new URL('../src-tauri/gen/android/app/src/main/java/tw/yooliang/asn/AsnBridge.kt', import.meta.url), 'utf8')
  for (const f of ['readAvailable', 'readSpeak', 'readStop', 'readVoices']) assert.match(kt, new RegExp(`fun ${f}\\(`))
})
