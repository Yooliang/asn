// 手機版偽通話（lib/mobile-call.mjs）：階段轉換、權限、錯誤處理、念出分段、掛斷與背景結束、按鈕顯示條件。
// 外殼（安卓的語音辨識與念出）、寄信、計時都用假的；計時器手動撥時間。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMobileCall, canCallPartner, MOBILE_PHASE_TEXT, MIC_DENIED_TEXT, NO_RECOGNIZER_TEXT, BACKGROUND_TEXT, MAX_SILENT, MAX_ERRORS } from '../ui/lib/mobile-call.mjs'
import { CALL_MARKER, ECHO_GUARD_MS, REPLY_TIMEOUT_MS } from '../ui/lib/call-session.mjs'
import { CALL_POLL_MS, startCallPoll } from '../ui/lib/call-poll.mjs'
import { androidBridge } from '../ui/lib/mobile.mjs'

function clock() {
  let t = 0, seq = 0
  const timers = new Map()
  return {
    setTimer: (f, ms) => { const id = ++seq; timers.set(id, { f, at: t + ms }); return id },
    clearTimer: id => timers.delete(id),
    setTick: () => ++seq, clearTick: () => {},
    now: () => t,
    advance(ms) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        t = due[1].at; timers.delete(due[0]); due[1].f()
      }
      t = end
    },
    pending: () => timers.size,
  }
}

function fakeNative({ available = true, mic = 'granted', grant = true } = {}) {
  let handler = null
  const n = {
    calls: [], spoken: [], listening: 0, ended: 0,
    available: () => available,
    micState: () => mic,
    requestMic() { n.calls.push('requestMic'); if (grant !== null) queueMicrotask(() => n.emit({ t: 'perm', granted: grant })) },
    listen() { n.listening++; n.calls.push('listen') },
    stopListen() { n.calls.push('stopListen') },
    speak(id, text) { n.spoken.push({ id, text }); n.calls.push('speak') },
    stopSpeak() { n.calls.push('stopSpeak') },
    end() { n.ended++; n.calls.push('end') },
    onEvent(fn) { handler = fn; return () => { handler = null } },
    emit(e) { handler?.(e) },
    get subscribed() { return handler !== null },
  }
  return n
}

const tick = () => new Promise(r => setImmediate(r))

function make(opts = {}, nativeOpts = {}) {
  const native = fakeNative(nativeOpts)
  const c = clock()
  const sent = []
  const call = createMobileCall({
    native, send: opts.send ?? (async t => { sent.push(t) }), ...c, canStart: opts.canStart,
  })
  return { native, c, sent, call }
}

test('按鈕只給 AI 夥伴：人、ASN 程式、離線、還在開的都不行', () => {
  assert.equal(canCallPartner({ engine: 'claude', status: 'online' }), true)
  assert.equal(canCallPartner({ kind: 'gemini', status: 'busy' }), true)
  assert.equal(canCallPartner({ engine: 'asn', status: 'online' }), false, 'ASN 程式本身')
  assert.equal(canCallPartner({ engine: null, kind: null, status: 'online' }), false, '沒有 AI 引擎＝不是 AI 夥伴')
  assert.equal(canCallPartner({ engine: 'claude', status: 'offline' }), false)
  assert.equal(canCallPartner({ engine: 'claude', status: 'online', pending: true }), false)
  assert.equal(canCallPartner(null), false)
})

test('一輪：聽你說 → 傳送中 → 等回覆 → 念出中 → 回到聽你說', async () => {
  const { native, c, sent, call } = make()
  assert.equal(await call.start([]), true)
  assert.equal(call.state.phase, 'listening')
  assert.equal(native.listening, 1)
  native.emit({ t: 'partial', text: '你好' })
  assert.equal(call.state.heard, '你好')

  let release
  const gate = new Promise(r => { release = r })
  const { native: n2, call: call2, sent: sent2 } = make({ send: async t => { sent2.push(t); await gate } })
  await call2.start([])
  n2.emit({ t: 'result', text: '今天天氣如何' })
  await tick()
  assert.equal(call2.state.phase, 'sending', '寄信還沒完成')
  assert.equal(sent2[0], `${CALL_MARKER}\n今天天氣如何`)
  release(); await tick()
  assert.equal(call2.state.phase, 'waiting')
  assert.equal(call2.state.heard, '今天天氣如何')

  // 第一支通話：結果 → 寄出 → 等回覆
  native.emit({ t: 'result', text: '嗨' })
  await tick()
  assert.deepEqual(sent, [`${CALL_MARKER}\n嗨`])
  assert.equal(call.state.phase, 'waiting')
  c.advance(1000)
  assert.equal(native.listening, 1, '等回覆時不收音')

  call.onLog([{ k: 'them', id: 'r1', text: '你好。今天天氣很好！' }])
  assert.equal(call.state.phase, 'speaking')
  assert.ok(native.spoken.length >= 1)
  assert.equal(call.state.reply, '你好。今天天氣很好！')
  for (const s of native.spoken.slice(0, -1)) native.emit({ t: 'tts-done', id: s.id })
  assert.equal(call.state.phase, 'speaking', '還有一段沒念完')
  native.emit({ t: 'tts-done', id: native.spoken.at(-1).id })
  assert.equal(call.state.phase, 'listening')
  c.advance(ECHO_GUARD_MS - 1)
  assert.equal(native.listening, 1, '念完先等一下才聽，不聽到自己的尾音')
  c.advance(1)
  assert.equal(native.listening, 2)
})

test('已看過的回信不重念；開始通話前就在記錄裡的也不念', async () => {
  const { native, call } = make()
  await call.start([{ k: 'them', id: 'old', text: '舊的' }])
  call.onLog([{ k: 'them', id: 'old', text: '舊的' }, { k: 'me', text: 'x' }])
  assert.equal(native.spoken.length, 0)
  call.onLog([{ k: 'them', id: 'new', text: '新的一句。' }])
  const n = native.spoken.length
  assert.ok(n >= 1)
  call.onLog([{ k: 'them', id: 'new', text: '新的一句。' }])
  assert.equal(native.spoken.length, n)
})

test('長回覆分段念：第一段短，段數有上限，標點與網址不念', async () => {
  const { native, call } = make()
  await call.start([])
  call.onLog([{ k: 'them', id: 'x', text: '好。' + '這是很長的一句話，說明很多事情。'.repeat(30) + ' https://example.com' }])
  assert.ok(native.spoken.length >= 2 && native.spoken.length <= 4)
  assert.ok(native.spoken.every(s => !s.text.includes('https')))
  assert.equal(new Set(native.spoken.map(s => s.id)).size, native.spoken.length)
})

test('權限：已有就直接聽；沒有就先問，允許後開始，拒絕就結束並說怎麼開', async () => {
  const ok = make({}, { mic: 'ask', grant: true })
  assert.equal(await ok.call.start([]), true)
  assert.deepEqual(ok.native.calls.slice(0, 2), ['requestMic', 'listen'])

  const no = make({}, { mic: 'ask', grant: false })
  assert.equal(await no.call.start([]), false)
  assert.equal(no.call.state.active, false)
  assert.equal(no.call.state.note, MIC_DENIED_TEXT)
  assert.ok(!no.native.calls.includes('listen'), '沒權限不開辨識')
  assert.ok(no.native.ended >= 1, '放掉外殼')
  assert.equal(no.native.subscribed, false)

  const granted = make({}, { mic: 'granted' })
  await granted.call.start([])
  assert.ok(!granted.native.calls.includes('requestMic'))
})

test('這支手機沒有語音辨識服務：不能通話並說明', async () => {
  const { call, native } = make({}, { available: false })
  assert.equal(await call.start([]), false)
  assert.equal(call.state.note, NO_RECOGNIZER_TEXT)
  assert.equal(native.listening, 0)
})

test('canStart 擋下時不啟動', async () => {
  const { call, native } = make({ canStart: () => '另一個通話正在進行。' })
  assert.equal(await call.start([]), false)
  assert.equal(call.state.note, '另一個通話正在進行。')
  assert.equal(native.subscribed, false)
})

test('沒聽到話：重聽；連續太多次自動結束；聽到話就歸零', async () => {
  const { call, native, c } = make()
  await call.start([])
  for (let i = 0; i < MAX_SILENT - 1; i++) { native.emit({ t: 'error', kind: 'silence' }); c.advance(300) }
  assert.equal(call.state.active, true)
  assert.equal(native.listening, MAX_SILENT, '每次沒聽到都再聽')
  native.emit({ t: 'result', text: '' })   // 空結果也算沒聽到
  assert.equal(call.state.active, false)
  assert.match(call.state.note, /很久沒聽到聲音/)

  const b = make()
  await b.call.start([])
  for (let i = 0; i < 5; i++) { b.native.emit({ t: 'error', kind: 'silence' }); b.c.advance(300) }
  b.native.emit({ t: 'result', text: '說了一句' }); await tick(); b.c.advance(300)
  assert.equal(b.call.state.active, true)
})

test('辨識錯誤：沒權限／不支援中文立刻結束；連線問題連續幾次才結束；忙碌會再試', async () => {
  const d = make(); await d.call.start([])
  d.native.emit({ t: 'error', kind: 'denied' })
  assert.equal(d.call.state.active, false); assert.equal(d.call.state.note, MIC_DENIED_TEXT)

  const l = make(); await l.call.start([])
  l.native.emit({ t: 'error', kind: 'language' })
  assert.equal(l.call.state.active, false); assert.match(l.call.state.note, /不支援中文/)

  const n = make(); await n.call.start([])
  for (let i = 0; i < MAX_ERRORS - 1; i++) { n.native.emit({ t: 'error', kind: 'network' }); n.c.advance(1000) }
  assert.equal(n.call.state.active, true)
  n.native.emit({ t: 'error', kind: 'network' })
  assert.equal(n.call.state.active, false); assert.match(n.call.state.note, /網路/)

  const b = make(); await b.call.start([])
  b.native.emit({ t: 'error', kind: 'busy' }); b.c.advance(1000)
  assert.equal(b.call.state.active, true); assert.equal(b.native.listening, 2)
})

test('靜音：不收音；取消靜音才再聽；靜音時才到的結果丟掉', async () => {
  const { call, native, sent } = make()
  await call.start([])
  call.toggleMute()
  assert.equal(call.state.muted, true)
  assert.ok(native.calls.includes('stopListen'))
  native.emit({ t: 'result', text: '不該送出' }); await tick()
  assert.equal(sent.length, 0)
  call.toggleMute()
  assert.equal(native.listening, 2)
})

test('寄信失敗：顯示原因，回到聽你說，不卡在等回覆', async () => {
  const { call, native, c } = make({ send: async () => { throw new Error('連不上') } })
  await call.start([])
  native.emit({ t: 'result', text: '喂' }); await tick(); c.advance(300)
  assert.match(call.state.note, /寄不出去：連不上/)
  assert.equal(call.state.phase, 'listening')
})

test('對方太久沒回：不再等，回到聽你說並提示', async () => {
  const { call, native, c } = make()
  await call.start([])
  native.emit({ t: 'result', text: '喂' }); await tick()
  assert.equal(call.state.phase, 'waiting')
  c.advance(REPLY_TIMEOUT_MS)
  assert.equal(call.state.phase, 'listening')
  assert.match(call.state.note, /還沒回信/)
})

test('回信比寄信完成還早到：不會卡在等回覆', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const { call, native, c } = make({ send: async () => { await gate } })
  await call.start([])
  native.emit({ t: 'result', text: '喂' }); await tick()
  call.onLog([{ k: 'them', id: 'fast', text: '好的。' }])
  for (const s of native.spoken) native.emit({ t: 'tts-done', id: s.id })
  release(); await tick(); c.advance(ECHO_GUARD_MS + 300)
  assert.equal(call.state.phase, 'listening')
})

test('念出失敗：顯示原因並回到聽你說；念不完的保險計時會放行', async () => {
  const a = make(); await a.call.start([])
  a.call.onLog([{ k: 'them', id: 'x', text: '你好。' }])
  a.native.emit({ t: 'tts-error', message: '這支手機沒有中文語音' })
  assert.match(a.call.state.note, /念不出來：這支手機沒有中文語音/)
  assert.equal(a.call.state.phase, 'listening')

  const b = make(); await b.call.start([])
  b.call.onLog([{ k: 'them', id: 'x', text: '你好。' }])
  b.c.advance(30_000 + 10 * 400 + 1)
  assert.equal(b.call.state.phase, 'listening', '外殼一直沒回報念完')
})

test('掛斷：放掉外殼、取消訂閱、不再收事件；念到一半掛斷會停', async () => {
  const { call, native } = make()
  await call.start([])
  call.onLog([{ k: 'them', id: 'x', text: '你好。' }])
  const r = await call.end()
  assert.equal(call.state.active, false)
  assert.equal(typeof r.seconds, 'number')
  assert.ok(native.ended >= 1)
  assert.equal(native.subscribed, false)
  const n = native.listening
  native.emit({ t: 'result', text: '掛斷後' })
  assert.equal(native.listening, n)
  assert.equal(await call.end(), null)
})

test('螢幕關閉或切到背景（外殼的 background 事件）：自動結束並說明', async () => {
  const { call, native } = make()
  await call.start([])
  native.emit({ t: 'background' })
  assert.equal(call.state.active, false)
  assert.equal(call.state.note, BACKGROUND_TEXT)
  assert.equal(native.subscribed, false)
})

test('等權限的時候掛斷：不會之後又開始聽', async () => {
  const { call, native } = make({}, { mic: 'ask', grant: null })
  const p = call.start([])
  await tick()
  await call.end()
  assert.equal(await p, false)
  assert.equal(native.listening, 0)
})

test('通話中每 2 秒多收一次信：只在通話中收，結束就不收', () => {
  let on = true, pulls = 0, fn = null
  startCallPoll({ anyCall: () => on, pull: () => { pulls++; return Promise.resolve() }, setTick: f => { fn = f; return 1 }, clearTick: () => {} })
  assert.equal(CALL_POLL_MS, 2000)
  fn(); fn(); assert.equal(pulls, 2)
  on = false; fn(); assert.equal(pulls, 2)
})

test('階段文字：手機用自己的說法，五個階段都有', () => {
  assert.deepEqual(Object.keys(MOBILE_PHASE_TEXT), ['starting', 'listening', 'sending', 'waiting', 'speaking'])
  assert.ok(Object.values(MOBILE_PHASE_TEXT).every(t => !/[A-Za-z]/.test(t)), '純中文')
})

test('外殼橋：事件用字串推進來；外殼太舊沒有通話方法就回 null', () => {
  const win = { AsnAndroid: { vibrate() {}, callAvailable: () => true, callMicState: () => 'granted', callSpeak: (id, t) => { win.said = [id, t] } } }
  const b = androidBridge(win)
  assert.equal(b.call.available(), true)
  assert.equal(b.call.micState(), 'granted')
  b.call.speak(3, '嗨'); assert.deepEqual(win.said, ['3', '嗨'])
  const got = []
  const off = b.call.onEvent(e => got.push(e))
  win.__asnCallEvent('{"t":"result","text":"你好"}')
  win.__asnCallEvent('壞掉的')
  assert.deepEqual(got, [{ t: 'result', text: '你好' }])
  off(); assert.equal(win.__asnCallEvent, null)
  assert.equal(androidBridge({ AsnAndroid: { vibrate() {} } }).call, null)
})

test('手機通話：開始聽時把名字（JSON 陣列字串）交給外殼；沒給就是空陣列', async () => {
  const seen = []
  const mk = hints => {
    const native = fakeNative()
    native.listen = names => { seen.push(names) }
    const c = clock()
    return createMobileCall({ native, send: async () => {}, ...c, hints })
  }
  const a = mk(() => ['希緒', '正見'])
  assert.equal(await a.start([]), true)
  const b = mk(undefined)
  assert.equal(await b.start([]), true)
  assert.deepEqual(seen, ['["希緒","正見"]', '[]'])
  await a.end(); await b.end()
})
