// #2162⓪：桌面版（list.js）存 asn-me.json 時，這版不認得的欄位要原樣留著。
// 手機版才有的 mobilePrefs／lastChat／navTab，或新版才寫的欄位，過去一存檔就整個消失。
// 做法：從 list.js 原始碼取出真正的 saveMe 函式本體，用假的狀態跑，看寫出去的內容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { deviceFieldsToSave } from '../ui/lib/device-order.mjs'
import { memStore } from './helpers.mjs'

const src = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
const m = /const saveMe = trailingThrottle\((\(\) => \{.*\}), 600\)/.exec(src)

// 跑一次桌面版的存檔：file 是檔案裡原有的內容（假資料），patch 是這次改動的狀態
const runSave = (file, patch = {}) => {
  const store = memStore(file)
  const ref = v => ({ value: v })
  const scope = {
    savedMe: file ?? {}, meStore: store, deviceFieldsToSave,
    me: { nick: '本機', psm: '', status: 'online', ...patch.me }, devPrefs: {},
    chatPins: ref([]), showNowPlaying: ref(true), notifyPrefs: ref({}), skin: ref(patch.skin ?? 'aero'), frame: ref('x'), closeTo: ref('x'),
    autoAddClaude: ref(false), autoCheck: ref(true), ghRefs: ref([]),
    dims: { tabDim: 'a', groupDim: 'b' }, ui: { mode: 'm', dpMode: 'd', bubble: 1, toolbar: 1, collapsed: [], pinnedChat: '' },
    sizes: { split: 1, merged: 2, guide: 3, setting: 4 }, sess: { ready: false, saved: { tabs: [] } }, currentSession: () => ({}),
  }
  const names = Object.keys(scope)
  const fn = new Function(...names, `return ${m[1]}`)(...names.map(k => scope[k]))
  fn()
  return store
}

test('#2162⓪ 找得到 saveMe 本體（原始碼改版要跟著改這支）', () => {
  assert.ok(m, '找不到 const saveMe = trailingThrottle(() => {...}, 600)')
  assert.match(m[1], /\.\.\.savedMe/, 'saveMe 要先展開讀進來的舊內容')
})

test('#2162⓪ 桌面存一次，檔案裡不認得的欄位還在', async () => {
  const file = { futureField: 1, mobilePrefs: { fontScale: 2 }, lastChat: 'peer-a', navTab: 'chats', ownerName: '甲' }
  const out = runSave(file).data
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
  assert.deepEqual(store.data.newFeature, { on: true, list: [1, 2] })
  assert.equal(store.data.skin, 'line', '這版的欄位照常更新')
})

test('#2162⓪ 這次要存的欄位會蓋過舊值', async () => {
  const out = runSave({ skin: 'modern', me: { psm: '舊的心情', status: 'away' }, winMode: 'old', splitSize: 99 }, { skin: 'line', me: { psm: '新的心情' } }).data
  assert.equal(out.skin, 'line')
  assert.equal(out.me.psm, '新的心情')
  assert.equal(out.winMode, 'm')
  assert.equal(out.splitSize, 1)
  assert.equal('nick' in out.me, false, 'nick 不存進 me')
})

test('#2162⓪ 檔案不存在（第一次執行）也能存', async () => {
  const out = runSave(null).data
  assert.equal(out.skin, 'aero')
})
