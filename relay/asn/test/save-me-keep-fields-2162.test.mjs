// #2162⓪：桌面版（list.js）存 asn-me.json 時，這版不認得的欄位要原樣留著。
// 手機版才有的 mobilePrefs／lastChat／navTab，或新版才寫的欄位，過去一存檔就整個消失。
// #2162 ⑦：saveMe 改成 settings_patch，只送自己擁有的欄位，不認得的欄位由後端保留；舊檔壞到合併不了才退回整份存（帶著啟動時讀到的 savedMe）。
// 做法：從 list.js 原始碼取出真正的 saveMe 函式本體，用假的狀態跑，看送出去的欄位與最後的檔案內容（memStore.patch 的行為跟後端一樣：只動給的欄位）。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { deviceFieldsToSave } from '../ui/lib/device-order.mjs'
import { patchWithFallback } from '../ui/lib/settings-save.mjs'
import { memStore } from './helpers.mjs'

const src = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
const m = /const saveMe = trailingThrottle\((\(\) => \{.*\}), 600\)/.exec(src)

// 跑一次桌面版的存檔：file 是檔案裡原有的內容（假資料），patch 是這次改動的狀態
const runSave = (file, patch = {}, store = memStore(file)) => {
  const ref = v => ({ value: v })
  const scope = {
    savedMe: file ?? {}, meStore: store, deviceFieldsToSave, patchWithFallback,
    me: { nick: '本機', psm: '', status: 'online', ...patch.me }, devPrefs: {},
    chatPins: ref([]), showNowPlaying: ref(true), notifyPrefs: ref({}), skin: ref(patch.skin ?? 'aero'), frame: ref('x'), closeTo: ref('x'),
    autoAddClaude: ref(false), autoCheck: ref(true), ghRefs: ref([]),
    dims: { tabDim: 'a', groupDim: 'b' }, ui: { mode: 'm', dpMode: 'd', bubble: 1, toolbar: 1, collapsed: [], pinnedChat: '', ...patch.ui },
    sizes: { split: 1, merged: 2, guide: 3, setting: 4 }, sess: { ready: false, saved: { tabs: [] }, ...patch.sess }, currentSession: () => ({}),
  }
  const names = Object.keys(scope)
  const fn = new Function(...names, `return ${m[1]}`)(...names.map(k => scope[k]))
  fn()
  return store
}
const settle = () => new Promise(r => setTimeout(r, 0))

test('#2162⓪ 找得到 saveMe 本體（原始碼改版要跟著改這支）', () => {
  assert.ok(m, '找不到 const saveMe = trailingThrottle(() => {...}, 600)')
  assert.match(m[1], /patchWithFallback\(meStore, f, /, 'saveMe 要走 patch（只送自己的欄位）')
  assert.doesNotMatch(m[1], /meStore\.save\(/, 'saveMe 不准直接整份存')
  assert.match(m[1], /\.\.\.savedMe/, '只有退回整份存時才用到啟動時讀進來的舊內容')
})

test('#2162⑦ 送出去的只有自己的欄位，不含檔案裡不認得的欄位（由後端保留）', async () => {
  const file = { futureField: 1, mobilePrefs: { fontScale: 2 }, lastChat: 'peer-a', navTab: 'chats', ownerName: '甲', version: 1 }
  const store = runSave(file)
  await settle()
  assert.equal(store.patches.length, 1)
  const sent = store.patches[0]
  for (const k of ['futureField', 'mobilePrefs', 'lastChat', 'navTab', 'ownerName', 'version']) assert.equal(k in sent, false, `不准送 ${k}`)
  for (const k of ['skin', 'me', 'winMode', 'splitSize', 'session', 'chatPins']) assert.equal(k in sent, true, `要送 ${k}`)
  assert.equal(store.saves, 0, '沒壞檔就不整份存')
})

test('#2162⑦ 舊檔壞到合併不了：退回整份存一次，帶著啟動時讀到的欄位', async () => {
  const file = { futureField: 1, ownerName: '甲', skin: 'modern' }
  const store = memStore(file)
  store.patch = async () => { throw Object.assign(new Error('設定檔內容無法合併，這次沒有存'), { code: 'settings:merge' }) }   // invoke 出口丟出的樣子：代號在 code
  runSave(file, { skin: 'line' }, store)
  await settle()
  assert.equal(store.saves, 1)
  assert.equal(store.data.futureField, 1)
  assert.equal(store.data.ownerName, '甲')
  assert.equal(store.data.skin, 'line')
})

test('#2162⓪ 桌面存一次，檔案裡不認得的欄位還在', async () => {
  const file = { futureField: 1, mobilePrefs: { fontScale: 2 }, lastChat: 'peer-a', navTab: 'chats', ownerName: '甲' }
  const out = (await (async () => { const st = runSave(file); await settle(); return st })()).data
  assert.equal(out.futureField, 1)
  assert.deepEqual(out.mobilePrefs, { fontScale: 2 })
  assert.equal(out.lastChat, 'peer-a')
  assert.equal(out.navTab, 'chats')
  assert.equal(out.ownerName, '甲')
})

test('#2162⓪ 升級後再降級：新版寫的新欄位，由這版存檔後不會丟', async () => {
  // 1) 新版寫入含新欄位的檔案
  const newVersionFile = { skin: 'modern', me: { psm: '舊' }, newFeature: { on: true, list: [1, 2] } }
  // 2) 降級回這版：啟動讀進來（savedMe）、使用者動一下設定，連存兩次
  const store = runSave(newVersionFile, { skin: 'line' })
  await settle()
  assert.deepEqual(store.data.newFeature, { on: true, list: [1, 2] })
  assert.equal(store.data.skin, 'line', '這版的欄位照常更新')
})

test('#2162⓪ 這次要存的欄位會蓋過舊值', async () => {
  const st = runSave({ skin: 'modern', me: { psm: '舊的心情', status: 'away' }, winMode: 'old', splitSize: 99 }, { skin: 'line', me: { psm: '新的心情' } })
  await settle()
  const out = st.data
  assert.equal(out.skin, 'line')
  assert.equal(out.me.psm, '新的心情')
  assert.equal(out.winMode, 'm')
  assert.equal(out.splitSize, 1)
  assert.equal('nick' in out.me, false, 'nick 不存進 me')
})

test('#2162⓪ 檔案不存在（第一次執行）也能存', async () => {
  const st = runSave(null)
  await settle()
  const out = st.data
  assert.equal(out.skin, 'aero')
})

test('#2162⑦ 手機版 m.js 的存檔也走 patch（只送自己的欄位），不再整份存', () => {
  const mjs = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  assert.match(mjs, /void patchWithFallback\(meStore, f, \(\) => \(\{ \.\.\.saved, \.\.\.f \}\)\)/)
  assert.doesNotMatch(mjs, /meStore\.save\(/)
  assert.match(mjs, /import \{ patchWithFallback \} from '\.\/lib\/settings-save\.mjs'/)
})

test('#2162⑦ saveMe 碰到「暫時讀不到」：等 3 秒再 patch 一次，不改成整份存，不連續重試', async () => {
  const file = { futureField: 1, skin: 'modern' }
  const store = memStore(file)
  const realPatch = store.patch
  let n = 0
  store.patch = async f => { if (n++ === 0) { store.patches.push(f); throw Object.assign(new Error('設定檔暫時讀不到，這次沒有存，稍後再試'), { code: 'settings:unreadable' }) } return realPatch(f) }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    runSave(file, { skin: 'line' }, store)
    await new Promise(r => setImmediate(r))
    assert.equal(store.patches.length, 1, '3 秒內不重試')
    mock.timers.tick(3000)
    await new Promise(r => setImmediate(r))
  } finally { mock.timers.reset() }
  assert.equal(store.patches.length, 2, '等 3 秒後只再試一次')
  assert.equal(store.saves, 0, '不改用整份存')
  assert.equal(store.data.skin, 'line')
  assert.equal(store.data.futureField, 1)
})

test('#2162⑦ 取消置頂：pinnedChat 變成 undefined，送出的是 null、檔案裡的 pinnedChat 被刪掉，重新讀回來是沒有（JSON 會拿掉 undefined，不轉的話舊值會留在檔案裡、重開置頂又回來）', async () => {
  const file = { pinnedChat: 'peer-a', skin: 'modern', futureField: 1 }
  const store = runSave(file, { ui: { pinnedChat: undefined } })
  await settle()
  assert.equal(store.patches.length, 1)
  assert.equal(store.patches[0].pinnedChat, null, '要明確送 null（後端刪欄），不能整欄沒送')
  assert.equal('pinnedChat' in store.patches[0], true)
  const back = await store.load()
  assert.equal('pinnedChat' in back, false, '重新讀回來沒有 pinnedChat')
  assert.equal(back.futureField, 1, '別的欄位照舊')
})

test('#2162⑦ session 在 sess.ready 為假且 sess.saved 是 undefined 時也一樣：欄位被刪、不是留著舊值', async () => {
  const store = runSave({ session: { tabs: [1] } }, { sess: { saved: undefined } })
  await settle()
  assert.equal(store.patches[0].session, null)
  assert.equal('session' in (await store.load()), false)
})

// 手機版（m.js）存 me：watch 回呼裡用 patchWithFallback 送欄位；lastChat 等欄位是 undefined 時，送出去的要是 null（後端才會刪欄）
test('#2162⑧ 手機端存檔：lastChat 是 undefined 時，送出的 patch 那一欄是 null、檔案裡的欄位被刪', async () => {
  const msrc = fs.readFileSync(new URL('../ui/m.js', import.meta.url), 'utf8')
  const mm = /watch\(\[me, prefs, devPrefs, ownerName, lastChat[^\n]*?\], \(\) => (\{.*\}), \{ deep: true \}\)/.exec(msrc)
  assert.ok(mm, '找不到手機版存 me 的 watch 回呼（原始碼改版要跟著改這支）')
  assert.match(mm[1], /patchWithFallback\(meStore, f, /, '手機版存檔要走 patchWithFallback')
  const file = { lastChat: 'peer-a', navTab: 'chats', futureField: 1 }
  const store = memStore(file)
  const ref = v => ({ value: v })
  const scope = {
    me: { nick: '手機', psm: '' }, prefs: {}, devPrefs: {}, ownerName: ref(''), lastChat: ref(undefined), nav: { tab: 'chats', chat: false },
    PAGE_TAB: 'page', fourthSt: { fourth: null }, HOME_TAB: 'home', deviceFieldsToSave, patchWithFallback, meStore: store, saved: file,
  }
  const names = Object.keys(scope)
  new Function(...names, `return () => ${mm[1]}`)(...names.map(k => scope[k]))()
  await settle()
  assert.equal(store.patches.length, 1)
  assert.equal(store.patches[0].lastChat, null, '要明確送 null（後端刪欄），不能整欄沒送')
  assert.equal('lastChat' in store.patches[0], true)
  const back = await store.load()
  assert.equal('lastChat' in back, false)
  assert.equal(back.futureField, 1, '別的欄位照舊')
})
