// #2162 ⑦：patchWithFallback（個人設定、引導旗標共用的存檔規則）與 settings_patch 前端出口。
// 用假的 api 涵蓋：成功、merge（壞檔→退回整份存一次）、unreadable（等 3 秒只再試一次、不整份存）、其他錯誤（照丟）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchWithFallback, UNREADABLE_WAIT_MS, hasCode } from '../ui/lib/settings-save.mjs'
import { makeSettingsApi, makeStore } from '../ui/lib/tauri.mjs'
import { stripCode, plainMessage, onboardErrorText } from '../ui/lib/plain-errors.mjs'
import { memStore } from './helpers.mjs'

const MERGE = '[settings:merge] 設定檔內容無法合併，這次沒有存'
const UNREADABLE = '[settings:unreadable] 設定檔暫時讀不到（可能被其他程式占用），這次沒有存，稍後再試'
const FIELDS = { skin: 'line', me: { psm: '好' } }

// 模擬 invoke 出口丟出的錯誤：代號拆到 e.code，message 只剩白話句（真正的拆法由下面「invoke 出口」那支釘住）
const asErr = msg => {
  const m = /^\[(settings:[a-z_]+)\]\s*/.exec(msg)
  return Object.assign(new Error(m ? msg.slice(m[0].length) : msg), m ? { code: m[1] } : {})
}
// 假的存檔：patchErrs 是 patch 依序要丟的錯誤（用完就成功）；記下每次呼叫
const fake = (patchErrs = [], saveErr = null) => {
  const calls = []
  const errs = [...patchErrs]
  return {
    calls,
    patch: async f => { calls.push(['patch', f]); const e = errs.shift(); if (e) throw asErr(e) },
    save: async d => { calls.push(['save', d]); if (saveErr) throw asErr(saveErr) },
  }
}
const clock = () => { const waits = []; return { waits, wait: async ms => { waits.push(ms) } } }

test('成功：只 patch 一次，不整份存、不等', async () => {
  const s = fake(), c = clock()
  assert.equal(await patchWithFallback(s, FIELDS, { all: 1 }, c), true)
  assert.deepEqual(s.calls, [['patch', FIELDS]])
  assert.deepEqual(c.waits, [])
})

test('merge：退回整份存一次，內容是 full（物件或函式都行）；patch 不再重試', async () => {
  const s = fake([MERGE]), c = clock()
  const full = { old: 1, ...FIELDS }
  assert.equal(await patchWithFallback(s, FIELDS, full, c), true)
  assert.deepEqual(s.calls, [['patch', FIELDS], ['save', full]])
  assert.deepEqual(c.waits, [], '壞檔不用等')
  const s2 = fake([MERGE])
  await patchWithFallback(s2, FIELDS, () => ({ lazy: 1 }), c)
  assert.deepEqual(s2.calls[1], ['save', { lazy: 1 }])
  const s3 = fake([MERGE])
  await patchWithFallback(s3, FIELDS, undefined, c)
  assert.deepEqual(s3.calls[1], ['save', FIELDS], '沒給 full 就整份存 fields')
})

test('merge：整份存也失敗就把那個錯誤丟出去（不吞掉、不重試）', async () => {
  const s = fake([MERGE], '[settings:write] 設定檔寫入失敗')
  await assert.rejects(patchWithFallback(s, FIELDS, {}, clock()), e => e.code === 'settings:write' && e.message === '設定檔寫入失敗')
  assert.equal(s.calls.filter(x => x[0] === 'save').length, 1)
})

test('unreadable：等 3 秒再 patch 一次；成功就結束；絕不整份存', async () => {
  const s = fake([UNREADABLE]), c = clock()
  assert.equal(await patchWithFallback(s, FIELDS, { all: 1 }, c), true)
  assert.deepEqual(c.waits, [3000])
  assert.equal(UNREADABLE_WAIT_MS, 3000)
  assert.deepEqual(s.calls, [['patch', FIELDS], ['patch', FIELDS]])
})

test('unreadable：第二次還是失敗就放棄（console.warn 一行、不丟錯、不整份存、不再重試）', async () => {
  const s = fake([UNREADABLE, UNREADABLE, UNREADABLE]), c = clock(), warns = []
  assert.equal(await patchWithFallback(s, FIELDS, { all: 1 }, { ...c, warn: (...a) => warns.push(a) }), false)
  assert.deepEqual(s.calls.map(x => x[0]), ['patch', 'patch'], '只試兩次，沒有第三次、沒有 save')
  assert.deepEqual(c.waits, [3000])
  assert.equal(warns.length, 1)
  assert.equal(warns[0].join(' ').includes('[settings:'), false, 'warn 的白話句不含代號')
})

test('unreadable：第二次變成 merge 也不整份存（只有第一次的 merge 才退回整份）', async () => {
  const s = fake([UNREADABLE, MERGE])
  assert.equal(await patchWithFallback(s, FIELDS, { all: 1 }, { ...clock(), warn: () => {} }), false)
  assert.equal(s.calls.some(x => x[0] === 'save'), false)
})

test('unreadable：等的期間又有新的存檔進來，舊的這一次不再重試（免得拿舊內容蓋掉新的）', async () => {
  const s = fake([UNREADABLE])
  let release
  const gate = new Promise(r => { release = r })
  const first = patchWithFallback(s, { skin: 'old' }, {}, { wait: () => gate, warn: () => {} })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(await patchWithFallback(s, { skin: 'new' }, {}, clock()), true)
  release()
  assert.equal(await first, true, '欄位被新的呼叫蓋過了，不會丟，所以算成功')
  assert.deepEqual(s.calls.map(x => x[1].skin), ['old', 'new'], '舊的沒有重試，舊值沒有蓋掉新值')
})

// 做法：新呼叫把舊呼叫還沒存進去的欄位「併進自己這次要送的欄位」（同一欄以新值為準）。
// 理由：只要有更新的呼叫就讓舊的放棄，會讓「先 { done }、再 { pendingDeviceName }」這種不同欄位的連續存檔丟掉第一筆；
// 讓舊的照樣重試則可能在新呼叫之後才送出，拿舊值蓋掉同一欄的新值。併進新呼叫兩個問題都沒有，而且少送一次。
test('等待中又 patch 不同欄位：兩邊的欄位都要存進去（先 {a} 碰到 unreadable、等待中再 {b}）', async () => {
  const st = memStore({ keep: 1 })
  const realPatch = st.patch
  let first = true
  st.patch = async f => { if (first) { first = false; throw asErr(UNREADABLE) } return realPatch(f) }
  let release
  const gate = new Promise(r => { release = r })
  const p1 = patchWithFallback(st, { a: 1 }, {}, { wait: () => gate, warn: () => {} })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(await patchWithFallback(st, { b: 2 }, {}, clock()), true)
  assert.deepEqual(st.data, { keep: 1, a: 1, b: 2 }, 'b 這次送出時順便把 a 帶上')
  release()
  assert.equal(await p1, true)
  assert.deepEqual(st.data, { keep: 1, a: 1, b: 2 })
  assert.deepEqual(st.patches, [{ a: 1, b: 2 }], '只多送一次：舊呼叫發現欄位已被接手就不再重試')
})

test('等待中再 patch 同一欄：新值贏，舊值不會在之後蓋回來', async () => {
  const st = memStore({})
  const realPatch = st.patch
  let first = true
  st.patch = async f => { if (first) { first = false; throw asErr(UNREADABLE) } return realPatch(f) }
  let release
  const gate = new Promise(r => { release = r })
  const p1 = patchWithFallback(st, { a: 'old', x: 1 }, {}, { wait: () => gate, warn: () => {} })
  await new Promise(r => setTimeout(r, 0))
  await patchWithFallback(st, { a: 'new' }, {}, clock())
  release()
  await p1
  assert.deepEqual(st.data, { a: 'new', x: 1 }, 'x 帶上、a 以新值為準')
})

test('等待中的舊欄位併進新呼叫後，新呼叫碰到 merge：整份存也要帶上舊欄位', async () => {
  const st = memStore({})
  let n = 0
  st.patch = async () => { throw asErr(n++ === 0 ? UNREADABLE : MERGE) }
  let release
  const gate = new Promise(r => { release = r })
  const p1 = patchWithFallback(st, { a: 1 }, {}, { wait: () => gate, warn: () => {} })
  await new Promise(r => setTimeout(r, 0))
  await patchWithFallback(st, { b: 2 }, { old: 0, b: 2 }, clock())
  release()
  await p1
  assert.deepEqual(st.data, { old: 0, b: 2, a: 1 })
})

test('新呼叫碰到其他錯誤丟出去：接手的舊欄位退回欠著，下一次存檔再帶', async () => {
  const st = memStore({})
  const realPatch = st.patch
  let n = 0
  st.patch = async f => { n++; if (n === 1) throw asErr(UNREADABLE); if (n === 2) throw asErr('[settings:too_big] 存檔太大'); return realPatch(f) }
  let release
  const gate = new Promise(r => { release = r })
  const p1 = patchWithFallback(st, { a: 1 }, {}, { wait: () => gate, warn: () => {} })
  await new Promise(r => setTimeout(r, 0))
  await assert.rejects(patchWithFallback(st, { b: 2 }, {}, clock()), e => e.code === 'settings:too_big')
  release()
  assert.equal(await p1, true, '舊呼叫醒來發現欄位還欠著，自己重試')
  assert.deepEqual(st.data, { a: 1 })
})

test('其他錯誤：原樣丟出去，不整份存、不等、不重試', async () => {
  for (const msg of ['[settings:too_big] 存檔太大', '[settings:backup] 備份存不下來', '連不上', '[settings:name] 存檔名稱不合格']) {
    const s = fake([msg]), c = clock()
    await assert.rejects(patchWithFallback(s, FIELDS, {}, c), e => e.message === asErr(msg).message && e.code === asErr(msg).code)
    assert.deepEqual(s.calls.map(x => x[0]), ['patch'])
    assert.deepEqual(c.waits, [])
  }
  // Tauri 的 Err(String) 是字串不是 Error：照樣丟字串
  const raw = '[settings:too_big] 存檔太大'
  await assert.rejects(patchWithFallback({ patch: async () => { throw raw }, save: async () => {} }, FIELDS, {}, clock()), e => e === raw)
})

test('只認 e.code，不比對 message 文字', () => {
  assert.equal(hasCode(asErr('[settings:merge] 任何字'), 'settings:merge'), true)
  assert.equal(hasCode(new Error('設定檔內容無法合併，這次沒有存'), 'settings:merge'), false, '只有中文句、沒有 code：不算')
  assert.equal(hasCode(new Error('[settings:merge] 就算 message 長這樣'), 'settings:merge'), false, 'message 不算數，只看 code')
  assert.equal(hasCode('[settings:merge] 字串', 'settings:merge'), false)
  assert.equal(hasCode(null, 'settings:merge'), false)
})

test('stripCode：畫面上顯示時拿掉代號；沒有代號的原樣；plainMessage、onboardErrorText 都經過它', () => {
  assert.equal(stripCode('[settings:merge] 設定檔內容無法合併，這次沒有存'), '設定檔內容無法合併，這次沒有存')
  assert.equal(stripCode('[settings:too_big] 存檔太大'), '存檔太大')
  assert.equal(stripCode('一般錯誤 [x:y] 不在開頭'), '一般錯誤 [x:y] 不在開頭')
  assert.equal(stripCode(null), '')
  assert.equal(plainMessage('[settings:unreadable] 設定檔暫時讀不到'), '設定檔暫時讀不到')
  assert.equal(plainMessage(new Error('[settings:backup] 備份存不下來')), '備份存不下來')
  assert.equal(plainMessage('[settings:merge]', '改說這句'), '改說這句', '拿掉代號後沒字了，用 fallback')
  assert.equal(onboardErrorText(new Error('[settings:write] 設定檔寫入失敗')), '設定檔寫入失敗')
})

// ---- 前端出口：指令名與參數形狀釘住 ----
test('makeSettingsApi：指令名與參數形狀（load→store_load、save→store_save、patch→settings_patch）', async () => {
  const log = []
  const api = makeSettingsApi(async (cmd, args) => { log.push([cmd, args]); return 'R' })
  assert.equal(await api.load('me'), 'R')
  await api.save('me', '{"a":1}')
  await api.patch('onboard', { done: true, gone: null })
  assert.deepEqual(log, [
    ['store_load', { name: 'me' }],
    ['store_save', { name: 'me', text: '{"a":1}' }],
    ['settings_patch', { name: 'onboard', patch: { done: true, gone: null } }],
  ])
})

test('store(name)：load／save 簽章不變；patch 與 save 走同一條排隊，內容在呼叫當下複製、undefined 欄位不送', async () => {
  const log = []
  const rel = []
  const api = makeSettingsApi(async (cmd, args) => {
    log.push([cmd, args])
    if (cmd === 'settings_patch' && args.patch.slow) await new Promise(r => rel.push(r))
    return cmd === 'store_load' ? '{"x":1}' : undefined
  })
  const st = makeStore('me', api)
  assert.deepEqual(await st.load(), { x: 1 })
  const f = { slow: true, skin: 'a', skip: undefined }
  const p1 = st.patch(f)
  f.skin = 'changed'
  const p2 = st.save({ whole: 1 })
  const p3 = st.patch({ skin: 'b' })
  await new Promise(r => setTimeout(r, 5))
  assert.deepEqual(log.map(x => x[0]), ['store_load', 'settings_patch'], '前一支沒寫完，後面的都在排隊')
  rel.forEach(r => r())
  await Promise.all([p1, p2, p3])
  assert.deepEqual(log.slice(1), [
    ['settings_patch', { name: 'me', patch: { slow: true, skin: 'a' } }],
    ['store_save', { name: 'me', text: '{"whole":1}' }],
    ['settings_patch', { name: 'me', patch: { skin: 'b' } }],
  ])
})

test('store(name)：前一支 patch 失敗不擋後一支', async () => {
  let n = 0
  const st = makeStore('chats', makeSettingsApi(async cmd => { if (cmd === 'settings_patch' && n++ === 0) throw new Error('[settings:unreadable] x') }))
  await assert.rejects(st.patch({ a: 1 }))
  await st.patch({ a: 2 })
  assert.equal(n, 2)
})

// ---- 升級後再降級：新版 patch 過的檔（帶 version），舊版前端整份存不會丟欄位 ----
test('升級後再降級：新版 patch 過、帶 version:1 的 asn-me.json，舊版前端「讀進來展開 savedMe 再整份存」，欄位與 version 都還在', async () => {
  // 1) 新版：patch 之後的檔（後端補了 version:1，還有新版才有的欄位）
  const onDisk = { version: 1, skin: 'modern', me: { psm: '新' }, newFeature: { on: true, list: [1, 2] }, mobilePrefs: { fontScale: 2 } }
  const store = memStore(onDisk)
  // 2) 降級後的舊版前端（PR #2168 的寫法）：啟動時 load 成 savedMe，存檔時 { ...savedMe, 自己的欄位 } 整份存
  const savedMe = (await store.load()) ?? {}
  await store.save({ ...savedMe, skin: 'line', me: { psm: '舊版改的' } })
  assert.equal(store.data.version, 1, '舊版前端不認得 version，但展開 savedMe 會保留它')
  assert.deepEqual(store.data.newFeature, { on: true, list: [1, 2] })
  assert.deepEqual(store.data.mobilePrefs, { fontScale: 2 })
  assert.equal(store.data.skin, 'line')
  // 3) 再升級：新版 patch 照常合併，新欄位還在
  await store.patch({ skin: 'aero' })
  assert.equal(store.data.skin, 'aero')
  assert.deepEqual(store.data.newFeature, { on: true, list: [1, 2] })
  assert.equal(store.data.version, 1)
})

// ---- 頂層 undefined → null（刪欄）----
test('送出前頂層的 undefined 轉成 null（後端刪欄）；巢狀的 undefined 不處理（照 JSON 原本行為拿掉）', async () => {
  const s = fake()
  await patchWithFallback(s, { a: undefined, b: 1, c: { d: undefined, e: 2 } }, {}, clock())
  assert.deepEqual(Object.keys(s.calls[0][1]).sort(), ['a', 'b', 'c'])
  assert.equal(s.calls[0][1].a, null)
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls[0][1].c)), { e: 2 })
})

test('欠著的 null：沒有新值就照樣刪欄；新呼叫給了值就蓋掉', async () => {
  for (const [second, expect] of [[{ b: 2 }, { b: 2 }], [{ a: 'v', b: 2 }, { a: 'v', b: 2 }]]) {
    const st = memStore({ a: 'old' })
    const realPatch = st.patch
    let first = true
    st.patch = async f => { if (first) { first = false; throw asErr(UNREADABLE) } return realPatch(f) }
    let release
    const gate = new Promise(r => { release = r })
    const p1 = patchWithFallback(st, { a: undefined }, {}, { wait: () => gate, warn: () => {} })
    await new Promise(r => setTimeout(r, 0))
    await patchWithFallback(st, second, {}, clock())
    release()
    await p1
    assert.deepEqual(st.data, expect)
  }
})

test('欠著的 null 自己等完重試：照樣送 null（刪欄）', async () => {
  const st = memStore({ a: 'old', keep: 1 })
  const realPatch = st.patch
  let first = true
  st.patch = async f => { if (first) { first = false; throw asErr(UNREADABLE) } return realPatch(f) }
  await patchWithFallback(st, { a: undefined }, {}, clock())
  assert.deepEqual(st.data, { keep: 1 })
})

test('merge 退回整份存：undefined／null 欄位不會寫成 null，而是整份裡沒有這一欄', async () => {
  const s = fake([MERGE])
  await patchWithFallback(s, { a: undefined, b: 1 }, undefined, clock())
  assert.deepEqual(s.calls[1], ['save', { b: 1 }])
  const st = fake([UNREADABLE, MERGE])
  let release
  const gate = new Promise(r => { release = r })
  const p1 = patchWithFallback(st, { gone: undefined }, {}, { wait: () => gate, warn: () => {} })
  await new Promise(r => setTimeout(r, 0))
  await patchWithFallback(st, { b: 2 }, { old: 0, gone: 'stale', b: 2 }, clock())
  release()
  await p1
  const saved = st.calls.find(x => x[0] === 'save')[1]
  assert.deepEqual(saved, { old: 0, b: 2 }, '舊的欠著 null 在整份存裡也要刪掉 gone')
})
