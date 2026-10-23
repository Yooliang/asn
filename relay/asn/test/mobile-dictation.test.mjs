// 手機版語音輸入（lib/mobile-dictation.mjs）：權限、聽完放進輸入框（不自動送出）、錯誤中文說明、按鈕顯示條件、守門。
// 外殼用假的；不開麥克風。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMobileDictation, canDictate, appendDictation, DICT_NOTES, DICT_DENIED, DICT_MAX_MS } from '../ui/lib/mobile-dictation.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8')

function fakeNative({ available = true, mic = 'granted', grant = true } = {}) {
  let handler = null
  const n = {
    calls: [], names: [], ended: 0,
    available: () => available,
    micState: () => mic,
    requestMic() { n.calls.push('requestMic'); queueMicrotask(() => n.emit({ t: 'perm', granted: grant })) },
    listen(names) { n.calls.push('listen'); n.names.push(names) },
    stopListen() { n.calls.push('stopListen') },
    end() { n.ended++ },
    onEvent(fn) { handler = fn; return () => { handler = null } },
    emit(e) { handler?.(e) },
    get subscribed() { return handler !== null },
  }
  return n
}
function make(nativeOpts = {}) {
  const native = fakeNative(nativeOpts)
  const timers = new Map(); let seq = 0
  const texts = []
  const d = createMobileDictation({
    native, onText: t => texts.push(t), hints: () => ['正見'],
    setTimer: (f, ms) => { const id = ++seq; timers.set(id, { f, ms }); return id }, clearTimer: id => timers.delete(id),
  })
  return { native, d, texts, timers }
}

test('按鈕條件：有外殼且有語音辨識服務才顯示；沒外殼、沒服務、外殼丟例外都不顯示', () => {
  assert.equal(canDictate(fakeNative()), true)
  assert.equal(canDictate(fakeNative({ available: false })), false)
  assert.equal(canDictate(null), false)
  assert.equal(canDictate({ available() { throw new Error('x') } }), false)
})

test('接在輸入框後面：空的直接放；中文之間不補空格；英數字相接補一個', () => {
  assert.equal(appendDictation('', '你好'), '你好')
  assert.equal(appendDictation('今天', '天氣好'), '今天天氣好')
  assert.equal(appendDictation('open', 'file'), 'open file')
  assert.equal(appendDictation('已有的字', ''), '已有的字')
  assert.equal(appendDictation(undefined, ' 嗨 '), '嗨')
})

test('講完自動停：聽 → 結果放進 onText，回到 idle、放掉外殼；名字提示有帶給外殼', async () => {
  const { native, d, texts } = make()
  assert.equal(await d.start(), true)
  assert.equal(d.state.phase, 'listening')
  assert.deepEqual(native.names, ['["正見"]'])
  native.emit({ t: 'partial', text: '請找正' })
  assert.equal(d.state.heard, '請找正')
  native.emit({ t: 'result', text: '請找正見' })
  assert.deepEqual(texts, ['請找正見'])
  assert.equal(d.state.phase, 'idle')
  assert.equal(native.ended, 1)
  assert.equal(native.subscribed, false)
  assert.equal(d.state.note, '')
})

test('再按一次停：已聽到的字照樣放進去；一個字都沒有就單純取消', async () => {
  const a = make(); await a.d.start()
  a.native.emit({ t: 'partial', text: '講到一半' })
  await a.d.toggle()
  assert.deepEqual(a.texts, ['講到一半'])
  assert.equal(a.d.state.phase, 'idle')
  const b = make(); await b.d.start()
  await b.d.toggle()
  assert.deepEqual(b.texts, [])
  assert.equal(b.d.state.phase, 'idle')
  assert.equal(b.d.state.note, '')
  assert.ok(b.native.calls.includes('stopListen'))
})

test('權限：沒有就先問，允許後開始聽；拒絕顯示怎麼開；已有就不再問', async () => {
  const ok = make({ mic: 'ask', grant: true })
  const p = ok.d.start()
  assert.equal(ok.d.state.phase, 'starting')
  assert.equal(await p, true)
  assert.deepEqual(ok.native.calls, ['requestMic', 'listen'])
  const no = make({ mic: 'ask', grant: false })
  assert.equal(await no.d.start(), false)
  assert.equal(no.d.state.phase, 'idle')
  assert.equal(no.d.state.note, DICT_DENIED)
  assert.ok(!no.native.calls.includes('listen'))
  const has = make({ mic: 'granted' }); await has.d.start()
  assert.ok(!has.native.calls.includes('requestMic'))
})

test('出錯顯示中文原因：沒聽到、忙碌、沒權限、沒網路、不支援中文、其他；沒有語音辨識服務也說明', async () => {
  for (const kind of ['silence', 'busy', 'denied', 'network', 'language', 'other']) {
    const { native, d, texts } = make(); await d.start()
    native.emit({ t: 'error', kind })
    assert.equal(d.state.phase, 'idle', kind)
    assert.equal(d.state.note, DICT_NOTES[kind], kind)
    assert.match(d.state.note, /[一-鿿]/)
    assert.deepEqual(texts, [])
  }
  const unk = make(); await unk.d.start(); unk.native.emit({ t: 'error', kind: '怪怪的' })
  assert.equal(unk.d.state.note, DICT_NOTES.other)
  const none = make({ available: false })
  assert.equal(await none.d.start(), false)
  assert.match(none.d.state.note, /沒有內建的語音辨識服務/)
  const empty = make(); await empty.d.start(); empty.native.emit({ t: 'result', text: '  ' })
  assert.equal(empty.d.state.note, DICT_NOTES.silence, '辨識出空字串＝沒聽到')
})

test('切到背景會停；保險計時到了自己收掉；聽的時候再 start 不重複開', async () => {
  const a = make(); await a.d.start()
  assert.equal(await a.d.start(), false)
  assert.equal(a.native.calls.filter(c => c === 'listen').length, 1)
  a.native.emit({ t: 'background' })
  assert.equal(a.d.state.phase, 'idle')
  const b = make(); await b.d.start()
  const dog = [...b.timers.values()].find(t => t.ms === DICT_MAX_MS)
  assert.ok(dog)
  dog.f()
  assert.equal(b.d.state.phase, 'idle')
})

test('守門：不自動送出（模組與畫面的語音輸入都沒有寄信）；權限沿用錄音權限；按鈕條件、44px、中文標籤', () => {
  const mod = read('ui', 'lib', 'mobile-dictation.mjs')
  assert.doesNotMatch(mod.replace(/^\s*\/\/.*$/gm, ''), /\bsend\b|emit\(|fetch\(|invoke\(/, '語音輸入模組不寄信、不連網')
  const pane = read('ui', 'lib', 'chatpane.mjs')
  const block = pane.slice(pane.indexOf('語音輸入（手機）'), pane.indexOf('const voiceNote'))
  assert.match(block, /onText: text => \{ draft\.value = appendDictation\(draft\.value, text\)/, '結果只放進輸入框')
  assert.doesNotMatch(block, /emit\('send'|send\(/, '不自動送出')
  assert.match(pane, /v-if="showDictBtn"[^>]*aria-label="語音輸入"/, '中文標籤')
  assert.match(pane, /const showDictBtn = computed\(\(\) => !!dict\)/)
  assert.match(read('ui', 'mobile.css'), /\.m-chat \.tool\.icon\.dict\{min-width:44px/, '至少 44px（高度沿用 .tool.icon 的 44px）')
  assert.match(read('ui', 'm.js'), /const dictApi = canDictate\(bridge\?\.call\) \?/, '沒有語音辨識服務不給 dictApi')
  assert.match(read('ui', 'm.html'), /<chat-pane[^>]*:dict-api="dictApi"/)
  for (const f of ['list.html', 'chat.html']) assert.doesNotMatch(read('ui', f), /dict-api/, `${f} 是電腦版，不用`)
  const manifest = read('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/, '沿用通話的錄音權限')
})
